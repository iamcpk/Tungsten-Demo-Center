import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ATTACHMENT_TYPES, BLOB_CONTAINERS, EMPTY_TAXONOMY, MAX_ATTACHMENT_BYTES, MAX_THUMBNAIL_BYTES, MAX_VIDEO_BYTES,
  VIDEO_UPLOAD_TYPES, cleanHtml, cleanText, createMailer, createMedia, createStores, fetchOEmbed, loadConfig,
  parseExternalVideoUrl, safeBlobName, slugify, taxonomySchema, videoInputSchema, type Attachment, type Video,
  type VideoInput, type VideoSource,
} from '@tdc/core';
import { authenticate, csrfGuard, requireRole, resolveAuthMode } from './auth.js';

const config = loadConfig();
const authMode = resolveAuthMode();
const stores = createStores(config);
const media = createMedia(config);
const mailer = createMailer(config);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const port = Number(process.env.PORT ?? 4100);
const blobOrigin = config.storageAccount ? `https://${config.storageAccount}.blob.core.windows.net` : '';
const mediaOrigin = new URL(config.mediaBaseUrl).origin;

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'img-src': ["'self'", 'data:', 'blob:', mediaOrigin, 'https://i.vimeocdn.com', 'https://i.ytimg.com'],
        'connect-src': ["'self'", ...(blobOrigin ? [blobOrigin] : [])],
        'frame-src': ["'none'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
  }),
);
app.use(compression());

// Excluded from Easy Auth in the template so App Service health checks work.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const api = express.Router();
api.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (r) => (r.ip ?? '').replace(/:\d+$/, '') }));
api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use(authenticate(authMode));
api.use(csrfGuard);
api.use(express.json({ limit: '256kb' }));

const editor = requireRole('Editor');
const admin = requireRole('Admin');
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

function audit(req: Request, action: string, target: string) {
  // Structured log line picked up by Application Insights.
  console.info(JSON.stringify({ audit: true, action, target, user: req.user?.email ?? req.user?.id, at: new Date().toISOString() }));
}

async function loadVideo(req: Request, res: Response): Promise<Video | undefined> {
  const id = z.string().uuid().safeParse(req.params.id);
  const v = id.success ? await stores.videos.get(id.data) : undefined;
  if (!v) res.status(404).json({ error: 'Video not found' });
  return v;
}

async function uniqueSlug(base: string, selfId?: string): Promise<string> {
  const all = await stores.videos.list();
  const taken = new Set(all.filter((v) => v.id !== selfId).map((v) => v.slug));
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

async function resolveSource(input: VideoInput['source'], existing?: VideoSource): Promise<VideoSource> {
  if (input.provider === 'azure') {
    return existing?.provider === 'azure' ? existing : { provider: 'azure', encodeState: 'awaiting-upload' };
  }
  const parsed = parseExternalVideoUrl(input.url);
  if (!parsed || parsed.provider !== input.provider) throw new HttpError(400, `That doesn't look like a valid ${input.provider === 'vimeo' ? 'Vimeo' : 'YouTube'} link`);
  return { ...parsed, durationSec: existing && existing.externalId === parsed.externalId ? existing.durationSec : undefined };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function applyInput(base: Partial<Video>, input: VideoInput) {
  return {
    ...base,
    title: cleanText(input.title, 200),
    pageTitle: input.pageTitle ? cleanText(input.pageTitle, 200) : undefined,
    shortDescription: cleanText(input.shortDescription, 600),
    description: cleanHtml(input.description),
    status: input.status,
    itemType: input.itemType,
    businessLines: input.businessLines,
    products: input.products,
    verticals: input.verticals,
    authors: input.authors,
    languages: input.languages,
    categories: input.categories,
    keywords: input.keywords,
    featured: input.featured,
    internalNotes: input.internalNotes ? cleanText(input.internalNotes, 4000) : undefined,
  };
}

// ---------- session ----------
api.get('/me', (req, res) => res.json({ user: req.user, mediaBaseUrl: config.mediaBaseUrl, publicSiteUrl: config.publicSiteUrl, uploadMode: media.mode }));

// ---------- videos ----------
api.get('/videos', editor, wrap(async (_req, res) => {
  const all = await stores.videos.list();
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(all);
}));

api.get('/videos/:id', editor, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (v) res.json(v);
}));

api.post('/videos', editor, wrap(async (req, res) => {
  const input = videoInputSchema.parse(req.body);
  const now = new Date().toISOString();
  const id = randomUUID();
  const source = await resolveSource(input.source);
  const v: Video = {
    ...applyInput({}, input),
    id,
    slug: await uniqueSlug(input.slug ?? slugify(input.title)),
    source,
    attachments: [],
    publishedAt: input.publishedAt ?? now,
    createdAt: now,
    updatedAt: now,
    createdBy: req.user!.email ?? req.user!.id,
    updatedBy: req.user!.email ?? req.user!.id,
  } as Video;
  if (source.provider !== 'azure') {
    const info = await fetchOEmbed(source).catch(() => undefined);
    if (info?.thumbnailUrl) v.thumbnailUrl = info.thumbnailUrl;
    if (info?.durationSec) v.source.durationSec = info.durationSec;
  }
  await stores.videos.upsert(v);
  audit(req, 'video.create', id);
  res.status(201).json(v);
}));

api.put('/videos/:id', editor, wrap(async (req, res) => {
  const existing = await loadVideo(req, res);
  if (!existing) return;
  const input = videoInputSchema.parse(req.body);
  const source = await resolveSource(input.source, existing.source);
  const sourceChanged = source.externalId !== existing.source.externalId || source.provider !== existing.source.provider;
  const v: Video = {
    ...existing,
    ...applyInput(existing, input),
    slug: input.slug && input.slug !== existing.slug ? await uniqueSlug(input.slug, existing.id) : existing.slug,
    source,
    publishedAt: input.publishedAt ?? existing.publishedAt,
    updatedAt: new Date().toISOString(),
    updatedBy: req.user!.email ?? req.user!.id,
  };
  if (sourceChanged && source.provider !== 'azure') {
    const info = await fetchOEmbed(source).catch(() => undefined);
    if (info?.thumbnailUrl) v.thumbnailUrl = info.thumbnailUrl;
    if (info?.durationSec) v.source.durationSec = info.durationSec;
  }
  await stores.videos.upsert(v);
  audit(req, 'video.update', v.id);
  res.json(v);
}));

api.delete('/videos/:id', admin, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  await media.deleteMediaPrefix(`hls/${v.id}/`);
  await media.deleteMediaPrefix(`thumbs/${v.id}/`);
  await media.deleteMediaPrefix(`attachments/${v.id}/`);
  if (v.source.uploadBlob) await media.deleteBlob(BLOB_CONTAINERS.uploads, v.source.uploadBlob);
  await stores.videos.delete(v.id);
  audit(req, 'video.delete', v.id);
  res.status(204).end();
}));

/** Look up title/thumbnail for a pasted Vimeo/YouTube link (fixed provider endpoints only). */
api.get('/oembed', editor, wrap(async (req, res) => {
  const src = typeof req.query.url === 'string' ? parseExternalVideoUrl(req.query.url) : undefined;
  if (!src) return res.status(400).json({ error: 'Only Vimeo and YouTube links are supported' });
  res.json({ source: src, info: (await fetchOEmbed(src).catch(() => undefined)) ?? null });
}));

// ---------- video file upload (browser -> Blob Storage directly) ----------
const ext = (name: string) => (name.split('.').pop() ?? '').toLowerCase();

api.post('/videos/:id/upload-url', editor, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const body = z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive().max(MAX_VIDEO_BYTES) }).parse(req.body);
  if (!VIDEO_UPLOAD_TYPES.includes(ext(body.fileName))) throw new HttpError(400, `Unsupported video type. Allowed: ${VIDEO_UPLOAD_TYPES.join(', ')}`);
  const blobName = `${v.id}/${Date.now()}-${safeBlobName(body.fileName)}`;
  const url = await media.createUploadUrl(BLOB_CONTAINERS.uploads, blobName, 360);
  audit(req, 'video.upload-url', v.id);
  res.json({ blobName, url: media.mode === 'local' ? `/api/local-upload/${BLOB_CONTAINERS.uploads}/${blobName}` : url });
}));

api.post('/videos/:id/upload-complete', editor, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const { blobName } = z.object({ blobName: z.string().min(1).max(400) }).parse(req.body);
  if (!blobName.startsWith(`${v.id}/`)) throw new HttpError(400, 'Upload does not belong to this video');
  const size = await media.blobSize(BLOB_CONTAINERS.uploads, blobName);
  if (!size) throw new HttpError(400, 'Upload not found. Please try again.');
  if (v.source.uploadBlob && v.source.uploadBlob !== blobName) await media.deleteBlob(BLOB_CONTAINERS.uploads, v.source.uploadBlob);
  v.source = { provider: 'azure', uploadBlob: blobName, encodeState: 'queued', hlsPath: v.source.hlsPath };
  v.updatedAt = new Date().toISOString();
  v.updatedBy = req.user!.email ?? req.user!.id;
  await stores.videos.upsert(v);
  await media.enqueueEncode({ videoId: v.id, uploadBlob: blobName });
  audit(req, 'video.encode-queued', v.id);
  res.json(v);
}));

api.post('/videos/:id/re-encode', editor, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const uploadBlob = v.source.uploadBlob;
  if (v.source.provider !== 'azure' || !uploadBlob) throw new HttpError(400, 'No uploaded source file to encode');
  v.source = { ...v.source, encodeState: 'queued', encodeError: undefined };
  await stores.videos.upsert(v);
  await media.enqueueEncode({ videoId: v.id, uploadBlob });
  res.json(v);
}));

// ---------- thumbnails (small, via the server so content can be verified) ----------
const thumbUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_THUMBNAIL_BYTES, files: 1 } });

function imageType(buf: Buffer): { ext: string; type: string } | undefined {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', type: 'image/jpeg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', type: 'image/png' };
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { ext: 'webp', type: 'image/webp' };
  return undefined;
}

api.post('/videos/:id/thumbnail', editor, thumbUpload.single('file'), wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const file = req.file;
  const kind = file ? imageType(file.buffer) : undefined;
  if (!file || !kind) throw new HttpError(400, 'Upload a JPG, PNG or WebP image');
  await media.deleteMediaPrefix(`thumbs/${v.id}/`);
  v.thumbnailPath = await media.putMedia(`thumbs/${v.id}/${Date.now()}.${kind.ext}`, file.buffer, kind.type);
  v.updatedAt = new Date().toISOString();
  await stores.videos.upsert(v);
  audit(req, 'video.thumbnail', v.id);
  res.json(v);
}));

// ---------- attachments (browser -> media container directly) ----------
api.post('/videos/:id/attachments/upload-url', editor, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const body = z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES) }).parse(req.body);
  const e = ext(body.fileName);
  if (!ATTACHMENT_TYPES[e]) throw new HttpError(400, `Unsupported file type. Allowed: ${Object.keys(ATTACHMENT_TYPES).join(', ')}`);
  const blobName = `attachments/${v.id}/${randomUUID().slice(0, 8)}-${safeBlobName(body.fileName)}`;
  const url = await media.createUploadUrl(BLOB_CONTAINERS.media, blobName, 120);
  res.json({ blobName, contentType: ATTACHMENT_TYPES[e], url: media.mode === 'local' ? `/api/local-upload/${BLOB_CONTAINERS.media}/${blobName}` : url });
}));

api.post('/videos/:id/attachments', editor, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const body = z.object({ blobName: z.string().max(400), name: z.string().trim().min(1).max(200), description: z.string().trim().max(400).optional() }).parse(req.body);
  if (!body.blobName.startsWith(`attachments/${v.id}/`)) throw new HttpError(400, 'Invalid attachment path');
  const size = await media.blobSize(BLOB_CONTAINERS.media, body.blobName);
  if (!size) throw new HttpError(400, 'Attachment upload not found');
  const att: Attachment = { id: randomUUID(), name: cleanText(body.name, 200), description: body.description ? cleanText(body.description, 400) : undefined, path: body.blobName, sizeBytes: size, contentType: ATTACHMENT_TYPES[ext(body.blobName)] };
  v.attachments = [...v.attachments, att];
  v.updatedAt = new Date().toISOString();
  await stores.videos.upsert(v);
  audit(req, 'video.attachment-add', v.id);
  res.json(v);
}));

api.delete('/videos/:id/attachments/:attId', editor, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const att = v.attachments.find((a) => a.id === req.params.attId);
  if (!att) return res.status(404).json({ error: 'Attachment not found' });
  if (att.path) await media.deleteBlob(BLOB_CONTAINERS.media, att.path);
  v.attachments = v.attachments.filter((a) => a.id !== att.id);
  v.updatedAt = new Date().toISOString();
  await stores.videos.upsert(v);
  audit(req, 'video.attachment-delete', v.id);
  res.json(v);
}));

// ---------- notify subscribers ----------
api.post('/videos/:id/notify', admin, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  if (v.status !== 'active') throw new HttpError(400, 'Only active videos can be announced');
  const subs = (await stores.subscribers.list()).filter((s) => s.status === 'confirmed' && (!s.products.length || s.products.some((p) => v.products.includes(p))));
  let sent = 0;
  for (const s of subs) {
    try {
      await mailer.send({
        to: [s.email],
        subject: `New on the Tungsten Demo Center: ${v.title}`,
        text: `${v.title}\n\n${v.shortDescription}`,
        action: { label: 'Watch the video', url: `${config.publicSiteUrl}/videos/${v.slug}` },
        unsubscribeUrl: `${config.publicSiteUrl}/unsubscribe?token=${s.token}`,
      });
      sent++;
    } catch (e) {
      console.error('notify failed for one subscriber', (e as Error).message);
    }
  }
  v.notifiedAt = new Date().toISOString();
  await stores.videos.upsert(v);
  audit(req, 'video.notify', v.id);
  res.json({ sent, total: subs.length });
}));

// ---------- taxonomy ----------
api.get('/taxonomy', editor, wrap(async (_req, res) => {
  res.json((await stores.meta.get('taxonomy')) ?? EMPTY_TAXONOMY);
}));

api.put('/taxonomy', editor, wrap(async (req, res) => {
  const t = taxonomySchema.parse(req.body);
  const dedupe = (a: string[]) => [...new Set(a.map((x) => cleanText(x, 80)).filter(Boolean))];
  const doc = { id: 'taxonomy' as const, products: dedupe(t.products), verticals: dedupe(t.verticals), authors: dedupe(t.authors), languages: dedupe(t.languages), categories: dedupe(t.categories), updatedAt: new Date().toISOString() };
  await stores.meta.upsert(doc);
  audit(req, 'taxonomy.update', 'taxonomy');
  res.json(doc);
}));

// ---------- subscribers & submissions (Admin only: personal data) ----------
api.get('/subscribers', admin, wrap(async (_req, res) => {
  const all = await stores.subscribers.list();
  res.json(all.map(({ token, ...s }) => { void token; return s; }).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}));

api.get('/subscribers.csv', admin, wrap(async (req, res) => {
  const all = (await stores.subscribers.list()).filter((s) => s.status === 'confirmed');
  // Prefix cells that start with formula characters to stop CSV injection in Excel.
  const cell = (s: string) => `"${(/^[=+\-@\t\r]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"`;
  const rows = [['email', 'products', 'confirmedAt'], ...all.map((s) => [s.email, s.products.join('; '), s.confirmedAt ?? ''])];
  audit(req, 'subscribers.export', String(all.length));
  res.type('text/csv').attachment('subscribers.csv').send(rows.map((r) => r.map(cell).join(',')).join('\r\n'));
}));

api.delete('/subscribers/:id', admin, wrap(async (req, res) => {
  const id = z.string().regex(/^[0-9a-f]{64}$/).parse(req.params.id);
  await stores.subscribers.delete(id);
  audit(req, 'subscriber.delete', id.slice(0, 8));
  res.status(204).end();
}));

api.get('/submissions', admin, wrap(async (_req, res) => {
  res.json((await stores.submissions.list()).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}));

api.patch('/submissions/:id', admin, wrap(async (req, res) => {
  const s = await stores.submissions.get(z.string().uuid().parse(req.params.id));
  if (!s) return res.status(404).json({ error: 'Not found' });
  const { status } = z.object({ status: z.enum(['new', 'handled']) }).parse(req.body);
  res.json(await stores.submissions.upsert({ ...s, status }));
}));

api.delete('/submissions/:id', admin, wrap(async (req, res) => {
  await stores.submissions.delete(z.string().uuid().parse(req.params.id));
  res.status(204).end();
}));

// ---------- local development upload target (stands in for a Blob SAS URL) ----------
if (media.mode === 'local' && media.writeLocal) {
  api.put('/local-upload/:container/*', editor, express.raw({ type: '*/*', limit: '2gb' }), wrap(async (req, res) => {
    const container = req.params.container === 'media' ? BLOB_CONTAINERS.media : BLOB_CONTAINERS.uploads;
    await media.writeLocal!(container, (req.params as Record<string, string>)[0]!, req.body as Buffer);
    res.status(201).end();
  }));
}

app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

if (config.dataMode === 'local') app.use('/media', express.static(path.resolve(config.localDataDir, 'media')));
app.use('/assets', express.static(path.join(publicDir, 'assets'), { immutable: true, maxAge: '1y' }));
app.use(express.static(publicDir, { index: false }));
app.get('*', (_req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(publicDir, 'index.html')));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(port, () => console.info(`Admin portal listening on :${port} (auth: ${authMode}, data: ${config.dataMode})`));
