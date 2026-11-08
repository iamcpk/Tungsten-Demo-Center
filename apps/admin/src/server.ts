import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  ATTACHMENT_TYPES, BLOB_CONTAINERS, EMPTY_TAXONOMY, MAX_ATTACHMENT_BYTES, MAX_THUMBNAIL_BYTES, MAX_VIDEO_BYTES,
  VIDEO_UPLOAD_TYPES, cleanHtml, cleanText, createMailer, createMedia, createStores, fetchOEmbed, loadConfig,
  parseExternalVideoUrl, safeBlobName, slugify, taxonomySchema, videoInputSchema, approveSchema, approverInputSchema,
  requestChangesSchema, type ApproverList, type Attachment, type MailMessage, type Video, type VideoInput, type VideoSource,
  BRANDING_HISTORY_LIMIT, BRAND_ASSET_RULES, DEFAULT_BRANDING, PREVIEW_HOURS, brandAssetBlob, brandAssetHeaders, brandAssetUrl,
  brandingPublishSchema, brandingSaveSchema, escapeHtml, fetchBrandAsset, hashToken, inspectBrandAsset, publishedSettings, randomToken,
  referencedAssets, withDefaults, type BrandAssetKind, type BrandingDoc,
} from '@tdc/core';
import { authenticate, csrfGuard, requireRole, resolveAuthMode, withApprovers, type AdminUser, type ApproverSets, type ApproverSync } from './auth.js';
import { actorId, canApprove, decisionBlockedReason, editBlockedReason, statusChangeError } from './workflow.js';

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
    // Easy Auth rejects cookie-authenticated browser POSTs that carry no Referer (403, empty body),
    // so send it to our own origin only. Nothing is sent to other sites.
    referrerPolicy: { policy: 'same-origin' },
  }),
);
app.use(compression());

// Excluded from Easy Auth in the template so App Service health checks work.
app.get('/healthz', (_req, res) => res.json({ ok: true }));

const api = express.Router();
api.use(rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: (r) => (r.ip ?? '').replace(/:\d+$/, '') }));
api.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
api.use(authenticate(authMode));

// ---------- approver list (in-app, maintained by administrators) ----------
let approverCache: { at: number; sets: ApproverSets } | undefined;
async function approverList(): Promise<ApproverList> {
  return (await stores.approvers.get('approvers')) ?? { id: 'approvers', people: [] };
}
async function approverSets(): Promise<ApproverSets> {
  if (approverCache && Date.now() - approverCache.at < 30_000) return approverCache.sets;
  const sets: ApproverSets = { portal: new Set(), entra: new Set() };
  for (const p of (await approverList()).people) sets[p.source === 'entra' ? 'entra' : 'portal'].add(p.email.toLowerCase());
  approverCache = { at: Date.now(), sets };
  return sets;
}
/** Everyone emailed about submissions: portal-added approvers plus Entra Approver role holders who have signed in. */
async function approverEmails(): Promise<Set<string>> {
  const { portal, entra } = await approverSets();
  return new Set([...portal, ...entra]);
}
async function updateApprovers(change: (list: ApproverList) => boolean) {
  const list = await approverList();
  if (!change(list)) return;
  list.updatedAt = new Date().toISOString();
  await stores.approvers.upsert(list);
  approverCache = undefined;
}
const approverSync: ApproverSync = {
  recordEntraApprover: (u) => updateApprovers((list) => {
    const email = u.email!.toLowerCase();
    if (list.people.some((p) => p.email === email)) return false;
    list.people.push({ email, name: cleanText(u.name, 120) || undefined, addedBy: 'Entra ID role', addedAt: new Date().toISOString(), source: 'entra' });
    console.info(JSON.stringify({ audit: true, action: 'approver.entra-add', target: email, at: new Date().toISOString() }));
    return true;
  }),
  dropEntraApprover: (email) => updateApprovers((list) => {
    const before = list.people.length;
    list.people = list.people.filter((p) => !(p.email === email && p.source === 'entra'));
    if (list.people.length === before) return false;
    console.info(JSON.stringify({ audit: true, action: 'approver.entra-remove', target: email, at: new Date().toISOString() }));
    return true;
  }),
};
api.use(withApprovers(approverSets, approverSync));
api.use(csrfGuard);
api.use(express.json({ limit: '256kb' }));

/** Any portal role (Content Creator, Approver, Admin). */
const creator = requireRole('Creator', 'Approver');
const approver = requireRole('Approver');
const admin = requireRole('Admin');
const wrap = (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

/** Creators may not change a published video (or its files); approvers and admins may. */
function assertEditable(req: Request, v: Video) {
  const why = editBlockedReason(req.user!, v);
  if (why) throw new HttpError(403, why);
}

// ---------- workflow emails (best effort: a mail failure never blocks the action) ----------
const adminBaseUrl = process.env.WEBSITE_HOSTNAME ? `https://${process.env.WEBSITE_HOSTNAME}` : `http://localhost:5174`;
async function sendSafely(msg: MailMessage): Promise<number> {
  if (!msg.to.length) return 0;
  try {
    await mailer.send(msg);
    return msg.to.length;
  } catch (e) {
    console.error('workflow mail failed', (e as Error).message);
    return 0;
  }
}
const isEmail = (s?: string): s is string => !!s && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s);

function markSubmitted(v: Video, u: AdminUser) {
  v.status = 'pending';
  v.review = { firstApprovedAt: v.review?.firstApprovedAt, submittedBy: actorId(u), submittedByName: u.name, submittedAt: new Date().toISOString() };
}

async function notifyApprovers(v: Video): Promise<number> {
  const submitter = v.review?.submittedBy?.toLowerCase();
  const to = [...(await approverEmails())].filter((e) => e !== submitter);
  if (!to.length) console.warn(JSON.stringify({ workflow: 'no-approvers', video: v.id }));
  return sendSafely({
    to,
    subject: `Awaiting approval: ${v.title}`,
    text: `${v.review?.submittedByName ?? v.review?.submittedBy ?? 'A content creator'} submitted a video for approval on the Tungsten Demo Center.\n\n${v.title}\n${v.shortDescription}\n\nPlease check it for quality and suitability before it goes on the public site.`,
    action: { label: 'Review the video', url: `${adminBaseUrl}/videos/${v.id}` },
  });
}

async function notifySubmitter(v: Video, approved: boolean, by: AdminUser) {
  const to = v.review?.submittedBy;
  if (!isEmail(to) || to === actorId(by)) return 0;
  const note = v.review?.note ? `\n\nComment from ${by.name}:\n${v.review.note}` : '';
  return sendSafely(approved
    ? { to: [to], subject: `Published: ${v.title}`, text: `${by.name} approved your video and it is now on the public Tungsten Demo Center.${note}`, action: { label: 'View it on the site', url: `${config.publicSiteUrl}/videos/${v.slug}` } }
    : { to: [to], subject: `Changes requested: ${v.title}`, text: `${by.name} reviewed your video and asked for changes before it can be published.${note}\n\nUpdate the video and submit it for approval again.`, action: { label: 'Open the video', url: `${adminBaseUrl}/videos/${v.id}` } });
}

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
api.get('/me', (req, res) => res.json({ user: req.user, canApprove: canApprove(req.user!), mediaBaseUrl: config.mediaBaseUrl, publicSiteUrl: config.publicSiteUrl, uploadMode: media.mode }));

// ---------- videos ----------
api.get('/videos', creator, wrap(async (_req, res) => {
  const all = await stores.videos.list();
  all.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  res.json(all);
}));

api.get('/videos/:id', creator, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (v) res.json(v);
}));

api.post('/videos', creator, wrap(async (req, res) => {
  const input = videoInputSchema.parse(req.body);
  const statusError = statusChangeError(req.user!, undefined, input.status);
  if (statusError) throw new HttpError(403, statusError);
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
  if (v.status === 'pending') markSubmitted(v, req.user!);
  await stores.videos.upsert(v);
  audit(req, 'video.create', id);
  const notifiedApprovers = v.status === 'pending' ? await notifyApprovers(v) : undefined;
  if (v.status === 'pending') audit(req, 'video.submit', id);
  res.status(201).json({ ...v, notifiedApprovers });
}));

api.put('/videos/:id', creator, wrap(async (req, res) => {
  const existing = await loadVideo(req, res);
  if (!existing) return;
  assertEditable(req, existing);
  const input = videoInputSchema.parse(req.body);
  const statusError = existing.status === input.status ? undefined : statusChangeError(req.user!, existing.status, input.status);
  if (statusError) throw new HttpError(403, statusError);
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
  const submitted = v.status === 'pending' && existing.status !== 'pending';
  if (submitted) markSubmitted(v, req.user!);
  await stores.videos.upsert(v);
  audit(req, submitted ? 'video.submit' : 'video.update', v.id);
  const notifiedApprovers = submitted ? await notifyApprovers(v) : undefined;
  res.json({ ...v, notifiedApprovers });
}));

// ---------- two-stage publishing ----------
api.post('/videos/:id/submit', creator, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  if (v.status !== 'draft') throw new HttpError(409, v.status === 'pending' ? 'This video is already awaiting approval.' : 'Only draft videos can be submitted for approval.');
  markSubmitted(v, req.user!);
  v.updatedAt = new Date().toISOString();
  v.updatedBy = actorId(req.user!);
  await stores.videos.upsert(v);
  audit(req, 'video.submit', v.id);
  res.json({ ...v, notifiedApprovers: await notifyApprovers(v) });
}));

api.post('/videos/:id/approve', approver, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const why = decisionBlockedReason(req.user!, v);
  if (why) throw new HttpError(v.status === 'pending' ? 403 : 409, why);
  const body = approveSchema.parse(req.body ?? {});
  const now = new Date().toISOString();
  // First approval of new content: if the publish date was left at its default (the day it was created),
  // use the approval time so it appears as the latest video. A date the creator chose on purpose is kept.
  if (!v.review?.firstApprovedAt && !v.legacyId && v.publishedAt.slice(0, 10) === v.createdAt.slice(0, 10)) v.publishedAt = now;
  v.status = body.publishAs;
  v.review = { ...v.review, decision: 'approved', decidedBy: actorId(req.user!), decidedAt: now, note: body.note || undefined, firstApprovedAt: v.review?.firstApprovedAt ?? now };
  v.updatedAt = now;
  v.updatedBy = actorId(req.user!);
  await stores.videos.upsert(v);
  audit(req, 'video.approve', v.id);
  await notifySubmitter(v, true, req.user!);
  res.json(v);
}));

api.post('/videos/:id/request-changes', approver, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  const why = decisionBlockedReason(req.user!, v);
  if (why) throw new HttpError(v.status === 'pending' ? 403 : 409, why);
  const { note } = requestChangesSchema.parse(req.body);
  const now = new Date().toISOString();
  v.status = 'draft';
  v.review = { ...v.review, decision: 'changes-requested', decidedBy: actorId(req.user!), decidedAt: now, note: cleanText(note, 2000) };
  v.updatedAt = now;
  v.updatedBy = actorId(req.user!);
  await stores.videos.upsert(v);
  audit(req, 'video.request-changes', v.id);
  await notifySubmitter(v, false, req.user!);
  res.json(v);
}));

// ---------- approvers (Admin only) ----------
api.get('/approvers', admin, wrap(async (_req, res) => {
  res.json((await approverList()).people.sort((a, b) => a.email.localeCompare(b.email)));
}));

api.post('/approvers', admin, wrap(async (req, res) => {
  const input = approverInputSchema.parse(req.body);
  const existing = (await approverList()).people.find((p) => p.email === input.email);
  if (existing) {
    throw new HttpError(409, existing.source === 'entra'
      ? `${input.email} already has the Approver role in Entra ID.`
      : `${input.email} is already an approver.`);
  }
  await updateApprovers((list) => {
    list.people.push({ email: input.email, name: input.name ? cleanText(input.name, 120) : undefined, addedBy: actorId(req.user!), addedAt: new Date().toISOString(), source: 'portal' });
    return true;
  });
  audit(req, 'approver.add', input.email);
  res.status(201).json((await approverList()).people);
}));

// Removing an Entra-recorded entry only stops the emails until that person next signs in with the role;
// the client explains that the role itself is removed in Entra ID.
api.delete('/approvers/:email', admin, wrap(async (req, res) => {
  const email = z.string().trim().toLowerCase().email().parse(req.params.email);
  if (!(await approverList()).people.some((p) => p.email === email)) throw new HttpError(404, 'Not an approver');
  await updateApprovers((list) => {
    list.people = list.people.filter((p) => p.email !== email);
    return true;
  });
  audit(req, 'approver.remove', email);
  res.json((await approverList()).people);
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
api.get('/oembed', creator, wrap(async (req, res) => {
  const src = typeof req.query.url === 'string' ? parseExternalVideoUrl(req.query.url) : undefined;
  if (!src) return res.status(400).json({ error: 'Only Vimeo and YouTube links are supported' });
  res.json({ source: src, info: (await fetchOEmbed(src).catch(() => undefined)) ?? null });
}));

// ---------- video file upload (browser -> Blob Storage directly) ----------
const ext = (name: string) => (name.split('.').pop() ?? '').toLowerCase();

api.post('/videos/:id/upload-url', creator, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  assertEditable(req, v);
  const body = z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive().max(MAX_VIDEO_BYTES) }).parse(req.body);
  if (!VIDEO_UPLOAD_TYPES.includes(ext(body.fileName))) throw new HttpError(400, `Unsupported video type. Allowed: ${VIDEO_UPLOAD_TYPES.join(', ')}`);
  const blobName = `${v.id}/${Date.now()}-${safeBlobName(body.fileName)}`;
  const url = await media.createUploadUrl(BLOB_CONTAINERS.uploads, blobName, 360);
  audit(req, 'video.upload-url', v.id);
  res.json({ blobName, url: media.mode === 'local' ? `/api/local-upload/${BLOB_CONTAINERS.uploads}/${blobName}` : url });
}));

api.post('/videos/:id/upload-complete', creator, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  assertEditable(req, v);
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

api.post('/videos/:id/re-encode', creator, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  assertEditable(req, v);
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

api.post('/videos/:id/thumbnail', creator, thumbUpload.single('file'), wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  assertEditable(req, v);
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
api.post('/videos/:id/attachments/upload-url', creator, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  assertEditable(req, v);
  const body = z.object({ fileName: z.string().min(1).max(255), size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES) }).parse(req.body);
  const e = ext(body.fileName);
  if (!ATTACHMENT_TYPES[e]) throw new HttpError(400, `Unsupported file type. Allowed: ${Object.keys(ATTACHMENT_TYPES).join(', ')}`);
  const blobName = `attachments/${v.id}/${randomUUID().slice(0, 8)}-${safeBlobName(body.fileName)}`;
  const url = await media.createUploadUrl(BLOB_CONTAINERS.media, blobName, 120);
  res.json({ blobName, contentType: ATTACHMENT_TYPES[e], url: media.mode === 'local' ? `/api/local-upload/${BLOB_CONTAINERS.media}/${blobName}` : url });
}));

api.post('/videos/:id/attachments', creator, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  assertEditable(req, v);
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

api.delete('/videos/:id/attachments/:attId', creator, wrap(async (req, res) => {
  const v = await loadVideo(req, res);
  if (!v) return;
  assertEditable(req, v);
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
api.post('/videos/:id/notify', approver, wrap(async (req, res) => {
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
api.get('/taxonomy', creator, wrap(async (_req, res) => {
  res.json((await stores.meta.get('taxonomy')) ?? EMPTY_TAXONOMY);
}));

api.put('/taxonomy', approver, wrap(async (req, res) => {
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

// ---------- site branding (Admin only) ----------
// Draft -> private preview link -> publish. Every publish is kept so an earlier version can be restored.
async function brandingDoc(): Promise<BrandingDoc> {
  return (await stores.branding.get('branding')) ?? { id: 'branding', history: [] };
}
function brandingState(doc: BrandingDoc) {
  const meta = (v: NonNullable<BrandingDoc['published']>) => ({ version: v.version, publishedAt: v.publishedAt, publishedBy: v.publishedBy, note: v.note });
  const live = doc.preview && Date.parse(doc.preview.expiresAt) > Date.now();
  return {
    settings: withDefaults(doc.draft?.settings ?? doc.published?.settings),
    published: publishedSettings(doc),
    defaults: DEFAULT_BRANDING,
    rev: doc.draft?.rev ?? 0,
    draft: doc.draft ? { updatedAt: doc.draft.updatedAt, updatedBy: doc.draft.updatedBy } : null,
    current: doc.published ? meta(doc.published) : null,
    history: doc.history.map(meta),
    previewExpiresAt: live ? doc.preview!.expiresAt : null,
    publicSiteUrl: config.publicSiteUrl,
  };
}
function assertRev(doc: BrandingDoc, rev: number) {
  if ((doc.draft?.rev ?? 0) !== rev) throw new HttpError(409, 'Someone else changed the branding draft since you opened it. Reload the page to see their changes.');
}

api.get('/branding', admin, wrap(async (_req, res) => {
  res.json(brandingState(await brandingDoc()));
}));

api.put('/branding/draft', admin, wrap(async (req, res) => {
  const { settings, rev } = brandingSaveSchema.parse(req.body);
  const doc = await brandingDoc();
  assertRev(doc, rev);
  for (const a of referencedAssets(settings)) {
    if (!(await media.blobSize(BLOB_CONTAINERS.media, brandAssetBlob(a.file)))) throw new HttpError(400, `The file ${a.name ?? a.file} is missing. Upload it again.`);
  }
  doc.draft = { settings, rev: rev + 1, updatedAt: new Date().toISOString(), updatedBy: actorId(req.user!) };
  await stores.branding.upsert(doc);
  audit(req, 'branding.save-draft', String(rev + 1));
  res.json(brandingState(doc));
}));

api.delete('/branding/draft', admin, wrap(async (req, res) => {
  const doc = await brandingDoc();
  doc.draft = undefined;
  doc.preview = undefined;
  await stores.branding.upsert(doc);
  audit(req, 'branding.discard-draft', 'branding');
  res.json(brandingState(doc));
}));

api.post('/branding/publish', admin, wrap(async (req, res) => {
  const { rev, note } = brandingPublishSchema.parse(req.body);
  const doc = await brandingDoc();
  assertRev(doc, rev);
  if (!doc.draft) throw new HttpError(409, 'There are no unpublished changes.');
  if (doc.published) doc.history = [doc.published, ...doc.history].slice(0, BRANDING_HISTORY_LIMIT);
  const version = Math.max(doc.published?.version ?? 0, ...doc.history.map((h) => h.version)) + 1;
  doc.published = { version, settings: doc.draft.settings, publishedAt: new Date().toISOString(), publishedBy: actorId(req.user!), note: note ? cleanText(note, 400) || undefined : undefined };
  doc.draft = undefined;
  doc.preview = undefined;
  await stores.branding.upsert(doc);
  faviconCache = undefined;
  audit(req, 'branding.publish', String(version));
  res.json(brandingState(doc));
}));

/** Copies an earlier version into the draft. It goes live only when it is published. */
api.post('/branding/restore/:version', admin, wrap(async (req, res) => {
  const version = z.coerce.number().int().positive().parse(req.params.version);
  const { rev } = z.object({ rev: z.number().int().min(0) }).parse(req.body);
  const doc = await brandingDoc();
  assertRev(doc, rev);
  const v = [doc.published, ...doc.history].find((h) => h?.version === version);
  if (!v) return res.status(404).json({ error: 'Version not found' });
  doc.draft = { settings: v.settings, rev: rev + 1, updatedAt: new Date().toISOString(), updatedBy: actorId(req.user!) };
  await stores.branding.upsert(doc);
  audit(req, 'branding.restore-to-draft', String(version));
  res.json(brandingState(doc));
}));

/** A private link that shows the draft on the public site. Creating a new one cancels the old one. */
api.post('/branding/preview', admin, wrap(async (req, res) => {
  const doc = await brandingDoc();
  if (!doc.draft) throw new HttpError(409, 'Save your changes as a draft first.');
  const token = randomToken(24);
  const expiresAt = new Date(Date.now() + PREVIEW_HOURS * 3600_000).toISOString();
  doc.preview = { tokenHash: hashToken(token), expiresAt };
  await stores.branding.upsert(doc);
  audit(req, 'branding.preview-link', expiresAt);
  res.json({ url: `${config.publicSiteUrl}/?brandPreview=${encodeURIComponent(token)}`, expiresAt });
}));

const brandUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: Math.max(...Object.values(BRAND_ASSET_RULES).map((r) => r.maxBytes)), files: 1 } });
api.post('/branding/assets', admin, brandUpload.single('file'), wrap(async (req, res) => {
  const kind = z.enum(Object.keys(BRAND_ASSET_RULES) as [BrandAssetKind, ...BrandAssetKind[]]).parse(req.body?.kind);
  if (!req.file) throw new HttpError(400, 'Choose a file to upload');
  const r = inspectBrandAsset(kind, req.file.buffer, req.file.originalname);
  if ('error' in r) throw new HttpError(400, r.error);
  // Content-addressed name: the same file uploaded twice is stored once, and never changes once stored.
  await media.putMedia(brandAssetBlob(r.asset.file), req.file.buffer, r.asset.type);
  audit(req, 'branding.asset-upload', `${kind}:${r.asset.file}`);
  res.status(201).json(r.asset);
}));

// ---------- local development upload target (stands in for a Blob SAS URL) ----------
if (media.mode === 'local' && media.writeLocal) {
  api.put('/local-upload/:container/*', creator, express.raw({ type: '*/*', limit: '2gb' }), wrap(async (req, res) => {
    const container = req.params.container === 'media' ? BLOB_CONTAINERS.media : BLOB_CONTAINERS.uploads;
    await media.writeLocal!(container, (req.params as Record<string, string>)[0]!, req.body as Buffer);
    res.status(201).end();
  }));
}

app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

if (config.dataMode === 'local') app.use('/media', express.static(path.resolve(config.localDataDir, 'media')));
app.use('/assets', express.static(path.join(publicDir, 'assets'), { immutable: true, maxAge: '1y' }));

// Brand files from our own origin (uploaded fonts need same-origin or CORS). Signed-in users only, via Easy Auth.
app.get('/brand/:file', wrap(async (req, res) => {
  const a = await fetchBrandAsset(config.mediaBaseUrl, req.params.file!);
  if (!a) return res.status(404).end();
  res.set(brandAssetHeaders(a.type)).send(a.body);
}));

app.use(express.static(publicDir, { index: false }));

// The admin portal uses the published site favicon.
let faviconCache: { at: number; tag: string } | undefined;
async function faviconTag(): Promise<string> {
  if (faviconCache && Date.now() - faviconCache.at < 60_000) return faviconCache.tag;
  let tag = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
  try {
    const fav = publishedSettings(await stores.branding.get('branding')).assets.favicon;
    if (fav) tag = `<link rel="icon" type="${escapeHtml(fav.type)}" href="${escapeHtml(brandAssetUrl(fav))}">`;
  } catch (e) {
    console.error('branding load failed', (e as Error).message);
  }
  faviconCache = { at: Date.now(), tag };
  return tag;
}
let adminShell: string | undefined;
app.get('*', wrap(async (_req, res) => {
  adminShell ??= await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
  res.set('Cache-Control', 'no-cache').type('html').send(adminShell.replace('<!--app-favicon-->', await faviconTag()));
}));

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  if (err instanceof z.ZodError) return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') });
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(port, () => console.info(`Admin portal listening on :${port} (auth: ${authMode}, data: ${config.dataMode})`));
