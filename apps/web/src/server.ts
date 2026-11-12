import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUSINESS_LINES, cleanHtml, createMailer, createStores, emailId, escapeHtml, formSchema, loadConfig, normaliseEmail,
  randomToken, relatedVideos, searchCatalog, subscribeSchema, toPublicVideo, type CatalogQuery, type Submission,
  type Subscriber, type SubmissionType, type Video, EMPTY_TAXONOMY, brandAssetHeaders, brandAssetUrl, brandDataScript, brandHeadTags,
  fetchBrandAsset, previewSettings, publishedSettings, type Branding, type BrandingDoc,
  AnalyticsRecorder, createAnalyticsWriter, isLikelyBot, parseTrackBatch,
} from '@tdc/core';

const config = loadConfig();
const stores = createStores(config);
const mailer = createMailer(config);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../public');
const port = Number(process.env.PORT ?? 4000);
const mediaOrigin = new URL(config.mediaBaseUrl).origin;

// ---------- catalogue cache (refreshed every minute; drafts never leave the server) ----------
let catalog: Video[] = [];
let catalogLoadedAt = 0;
async function refreshCatalog(): Promise<void> {
  try {
    const all = await stores.videos.list();
    // Descriptions are sanitised on write; sanitising again here is defence in depth.
    catalog = all
      .filter((v) => v.status === 'active' || v.status === 'archived')
      .map((v) => ({ ...v, description: cleanHtml(v.description) }));
    catalogLoadedAt = Date.now();
  } catch (e) {
    console.error('catalog refresh failed', e);
  }
}
async function getCatalog(): Promise<Video[]> {
  if (Date.now() - catalogLoadedAt > 60_000) await refreshCatalog();
  return catalog;
}

// ---------- branding (published version cached for 30 seconds) ----------
let brandingCache: { at: number; doc?: BrandingDoc } | undefined;
async function getBrandingDoc(maxAgeMs = 30_000): Promise<BrandingDoc | undefined> {
  if (brandingCache && Date.now() - brandingCache.at < maxAgeMs) return brandingCache.doc;
  try {
    brandingCache = { at: Date.now(), doc: await stores.branding.get('branding') };
  } catch (e) {
    console.error('branding load failed', (e as Error).message);
    brandingCache ??= { at: Date.now() };
  }
  return brandingCache.doc;
}
/** The draft for a valid preview token, otherwise the published branding. */
async function brandingFor(previewToken: unknown): Promise<{ branding: Branding; preview: boolean }> {
  const token = typeof previewToken === 'string' && previewToken ? previewToken : undefined;
  // A short cache even for previews, so made-up tokens can't turn every request into a database read.
  const draft = token ? previewSettings(await getBrandingDoc(5_000), token) : undefined;
  return draft ? { branding: draft, preview: true } : { branding: publishedSettings(await getBrandingDoc()), preview: false };
}

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
        'img-src': ["'self'", 'data:', mediaOrigin, 'https://i.vimeocdn.com', 'https://i.ytimg.com'],
        'media-src': ["'self'", 'blob:', mediaOrigin],
        'connect-src': ["'self'", mediaOrigin],
        'frame-src': ['https://player.vimeo.com', 'https://www.youtube-nocookie.com'],
        'worker-src': ["'self'", 'blob:'],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'upgrade-insecure-requests': config.publicSiteUrl.startsWith('https') ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }),
);
app.use(compression());
app.use(express.json({ limit: '32kb' }));

/** App Service puts "ip:port" in X-Forwarded-For; strip the port so limits are per client. */
const clientKey = (req: Request) => (req.ip ?? 'unknown').replace(/:\d+$/, '');
const trackLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: clientKey });
const formLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: clientKey });
const apiLimiter = rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: clientKey });

app.get('/healthz', (_req, res) => res.json({ ok: true, videos: catalog.length }));

// ---------- anonymous video analytics ----------
// Only per-video counts are kept (see packages/core/src/analytics.ts). The IP address is used by the
// rate limiter in memory and the user agent to drop bots; neither is stored or logged.
const analytics = new AnalyticsRecorder(createAnalyticsWriter(config, stores));
const flushAnalytics = () => analytics.flush().catch((e) => console.error('analytics flush failed', (e as Error).message));
setInterval(flushAnalytics, 60_000).unref();
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => { void flushAnalytics().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5_000).unref(); });
}

app.post('/api/track', trackLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  // Only the site's own pages may report (stops other sites inflating the numbers from visitors' browsers).
  const site = req.get('sec-fetch-site');
  if (site && site !== 'same-origin') return res.status(403).end();
  if (isLikelyBot(req.get('user-agent'))) return res.status(204).end();
  const ids = new Set((await getCatalog()).map((v) => v.id.toLowerCase()));
  const delta = parseTrackBatch(req.body, (id) => ids.has(id));
  if (!delta) return res.status(400).json({ error: 'Invalid request' });
  analytics.record(delta);
  res.status(204).end();
});

// ---------- public read API ----------
const api = express.Router();
api.use(apiLimiter);
api.use((_req, res, next) => { res.set('Cache-Control', 'public, max-age=60'); next(); });

const str = (v: unknown, max = 100) => (typeof v === 'string' && v.length <= max ? v : undefined);

api.get('/config', (_req, res) => {
  res.json({ mediaBaseUrl: config.mediaBaseUrl, businessLines: BUSINESS_LINES });
});

api.get('/branding', async (req, res) => {
  const r = await brandingFor(req.query.preview);
  if (r.preview) res.set('Cache-Control', 'no-store');
  res.json(r);
});

api.get('/videos', async (req, res) => {
  const text = str(req.query.q, 200);
  // A search on the main Videos page also looks in the archive (shown after current videos)
  // unless the visitor turns that off with archive=0.
  const status: CatalogQuery['status'] = req.query.status === 'archived' ? 'archived'
    : text?.trim() && req.query.archive !== '0' ? ['active', 'archived'] : 'active';
  const bl = str(req.query.businessLine, 2);
  const q: CatalogQuery = {
    q: text,
    status,
    businessLine: bl === 'IA' || bl === 'PA' ? bl : undefined,
    product: str(req.query.product),
    vertical: str(req.query.vertical),
    author: str(req.query.author),
    language: str(req.query.language),
    category: str(req.query.category),
    sort: (['newest', 'oldest', 'title', 'relevance'] as const).find((s) => s === req.query.sort),
    offset: Number(req.query.offset) || 0,
    limit: Number(req.query.limit) || 24,
  };
  const r = searchCatalog(await getCatalog(), q);
  res.json({ ...r, items: r.items.map(toPublicVideo) });
});

api.get('/home', async (_req, res) => {
  const active = (await getCatalog()).filter((v) => v.status === 'active');
  const byDate = [...active].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  const featured = byDate.filter((v) => v.featured).slice(0, 8);
  const products = new Map<string, number>();
  for (const v of active) for (const p of v.products) products.set(p, (products.get(p) ?? 0) + 1);
  res.json({
    featured: featured.map(toPublicVideo),
    latest: byDate.slice(0, 12).map(toPublicVideo),
    products: [...products].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count),
    total: active.length,
  });
});

api.get('/videos/:slug', async (req, res) => {
  const all = await getCatalog();
  const v = all.find((x) => x.slug === req.params.slug);
  if (!v) return res.status(404).json({ error: 'Not found' });
  res.json({ video: toPublicVideo(v), related: relatedVideos(all, v).map(toPublicVideo) });
});

// Caption files live in the public media container on another origin. The player's <track> needs them
// from the site's own origin (browsers don't load cross-origin captions without CORS), so they are relayed here.
const captionCache = new Map<string, string>();
api.get('/videos/:slug/captions/:trackId', async (req, res) => {
  const v = (await getCatalog()).find((x) => x.slug === req.params.slug);
  const t = v?.captions?.find((c) => c.id === req.params.trackId);
  if (!v || !t || !(t.path.startsWith(`captions/${v.id}/`) && /^captions\/[0-9a-f-]{36}\/[A-Za-z0-9._-]+\.vtt$/.test(t.path))) return res.status(404).json({ error: 'Not found' });
  let vtt = captionCache.get(t.path);
  if (vtt === undefined) {
    const r = await fetch(`${config.mediaBaseUrl}/${t.path}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    if (!r?.ok) return res.status(502).json({ error: 'Captions are not available right now' });
    vtt = await r.text();
    if (!vtt.startsWith('WEBVTT')) return res.status(502).json({ error: 'Captions are not available right now' });
    if (captionCache.size >= 200) captionCache.delete(captionCache.keys().next().value!);
    captionCache.set(t.path, vtt); // file names are unique per upload, so a cached copy never goes stale
  }
  res.set({ 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'public, max-age=300' }).send(vtt);
});

api.get('/taxonomy', async (_req, res) => {
  const t = (await stores.meta.get('taxonomy')) ?? EMPTY_TAXONOMY;
  res.json({ products: t.products });
});

// ---------- subscriptions (double opt-in) ----------
const CONSENT_TEXT = 'I agree to receive emails from Tungsten Automation about new Demo Center videos. I can unsubscribe at any time.';

api.post('/subscribe', formLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
  const email = normaliseEmail(parsed.data.email);
  const id = emailId(email);
  const existing = await stores.subscribers.get(id);
  // Same response whether or not the address exists, so the endpoint can't be used to probe for subscribers.
  if (existing?.status !== 'confirmed') {
    const sub: Subscriber = {
      id, email, status: 'pending', products: parsed.data.products, token: randomToken(),
      consentText: CONSENT_TEXT, createdAt: existing?.createdAt ?? new Date().toISOString(),
    };
    await stores.subscribers.upsert(sub);
    await mailer.send({
      to: [email],
      subject: 'Confirm your Tungsten Demo Center subscription',
      text: 'Please confirm that you want to receive emails when new videos are published on the Tungsten Demo Center.\n\nIf you did not request this, ignore this email and nothing will happen.',
      action: { label: 'Confirm subscription', url: `${config.publicSiteUrl}/subscribe/confirm?token=${encodeURIComponent(sub.token)}` },
    });
  }
  res.json({ ok: true });
});

/**
 * Confirmation links in emails that were already sent point here. Opening a link never changes
 * anything: mail scanners (for example Microsoft Defender Safe Links) open every link in incoming
 * mail, which used to confirm the subscription and use up the link before the person clicked it.
 * The page it leads to asks the person to press Confirm, which POSTs below.
 */
api.get('/subscribe/confirm', (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = str(req.query.token, 100);
  res.redirect(302, token ? `/subscribe/confirm?token=${encodeURIComponent(token)}` : '/subscribed?status=invalid');
});

// More generous than the form limit: people behind one company network may confirm at the same time.
const confirmLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false, keyGenerator: clientKey });

/**
 * Confirms a pending subscription. Safe to repeat: the token stays the same (it is also the
 * unsubscribe token), so pressing Confirm again just reports "already confirmed".
 * An unsubscribed address is not re-subscribed by an old link; the person subscribes again instead.
 */
api.post('/subscribe/confirm', confirmLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = str(req.body?.token, 100);
  const [sub] = token ? await stores.subscribers.findBy('token', token) : [];
  if (!sub || sub.status === 'unsubscribed') return res.json({ status: 'invalid' });
  if (sub.status === 'confirmed') return res.json({ status: 'already' });
  await stores.subscribers.upsert({ ...sub, status: 'confirmed', confirmedAt: new Date().toISOString() });
  res.json({ status: 'confirmed' });
});

// GET shows a confirmation page (mail scanners prefetch links); POST performs the unsubscribe.
api.post('/unsubscribe', formLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const token = str(req.body?.token, 100);
  const [sub] = token ? await stores.subscribers.findBy('token', token) : [];
  if (sub) await stores.subscribers.upsert({ ...sub, status: 'unsubscribed', unsubscribedAt: new Date().toISOString() });
  res.json({ ok: true });
});

// ---------- contact / suggest / demo forms ----------
const FORM_SUBJECT: Record<SubmissionType, string> = {
  contact: 'Demo Center contact request',
  suggest: 'Demo Center video suggestion',
  demo: 'Demo Center demo request',
};

api.post('/forms/:type', formLimiter, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const type = req.params.type as SubmissionType;
  if (!(type in FORM_SUBJECT)) return res.status(404).json({ error: 'Unknown form' });
  const parsed = formSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' });
  if (parsed.data.elapsedMs !== undefined && parsed.data.elapsedMs < 2500) return res.json({ ok: true }); // silently drop bots
  const { website, elapsedMs, ...data } = parsed.data;
  void website; void elapsedMs;
  const sub: Submission = { id: randomUUID(), type, ...data, email: normaliseEmail(data.email), status: 'new', createdAt: new Date().toISOString() };
  await stores.submissions.upsert(sub);
  if (config.formsTo) {
    await mailer.send({
      to: config.formsTo.split(/[;,]/).map((s) => s.trim()).filter(Boolean),
      replyTo: sub.email,
      subject: `${FORM_SUBJECT[type]}: ${sub.name}`,
      text: `Name: ${sub.name}\nEmail: ${sub.email}\nCompany: ${sub.company ?? '-'}\nProduct: ${sub.product ?? '-'}\n\n${sub.message}`,
    });
  }
  res.json({ ok: true });
});

app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- legacy iVengi URLs ----------
app.get('/items/:slug', (req, res) => res.redirect(301, `/videos/${encodeURIComponent(req.params.slug)}`));
app.get(['/archived-videos', '/archive-videos'], (_req, res) => res.redirect(301, '/archive'));

// ---------- SEO ----------
app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: ${config.publicSiteUrl}/sitemap.xml\n`);
});
app.get('/sitemap.xml', async (_req, res) => {
  const urls = (await getCatalog())
    .filter((v) => v.status === 'active')
    .map((v) => `<url><loc>${escapeHtml(`${config.publicSiteUrl}/videos/${v.slug}`)}</loc><lastmod>${v.updatedAt.slice(0, 10)}</lastmod></url>`);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${config.publicSiteUrl}/</loc></url>${urls.join('')}</urlset>`);
});

// Local development: serve the media folder that stands in for Blob Storage.
if (config.dataMode === 'local') {
  app.use('/media', express.static(path.resolve(config.localDataDir, 'media'), { fallthrough: false }));
}

app.use('/assets', express.static(path.join(publicDir, 'assets'), { immutable: true, maxAge: '1y' }));

// Brand files (logos, favicon, fonts) from our own origin, so uploaded fonts need no CORS.
app.get('/brand/:file', async (req, res, next) => {
  try {
    const a = await fetchBrandAsset(config.mediaBaseUrl, req.params.file);
    if (!a) return res.status(404).end();
    res.set(brandAssetHeaders(a.type)).send(a.body);
  } catch (e) {
    next(e);
  }
});

// Browsers and bookmark tools also ask for /favicon.ico directly, without reading the page.
app.get('/favicon.ico', async (_req, res) => {
  const fav = (await brandingFor(undefined)).branding.assets.favicon;
  res.set('Cache-Control', 'public, max-age=300').redirect(302, fav ? brandAssetUrl(fav) : '/favicon.svg');
});

app.use(express.static(publicDir, { index: false, maxAge: '1h' }));

// ---------- SPA shell with per-page meta tags for link previews ----------
let shell: string | undefined;
async function getShell(): Promise<string> {
  if (!shell || config.dataMode === 'local') shell = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
  return shell;
}

function metaTags(b: Branding, title: string, description: string, url: string, image?: string): string {
  const t = escapeHtml(title);
  const d = escapeHtml(description.slice(0, 300));
  return [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    `<meta property="og:type" content="video.other">`,
    `<meta property="og:site_name" content="${escapeHtml(b.identity.siteName)}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    image ? `<meta property="og:image" content="${escapeHtml(image)}">` : '',
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n    ');
}

const TOKEN_PAGES = new Set(['/subscribe/confirm', '/subscribed', '/unsubscribe']);

app.get('*', async (req: Request, res: Response, next: NextFunction) => {
  try {
    let html = await getShell();
    const { branding: b, preview } = await brandingFor(req.query.brandPreview);
    const siteImage = b.assets.socialImage ? `${config.publicSiteUrl}${brandAssetUrl(b.assets.socialImage)}` : undefined;
    let tags = metaTags(b, b.identity.siteName, b.seo.description, `${config.publicSiteUrl}${req.path}`, siteImage);
    // Pages opened from emails carry a personal token: keep them out of search engines and caches.
    const tokenPage = TOKEN_PAGES.has(req.path);
    if (tokenPage) tags += '\n    <meta name="robots" content="noindex, nofollow">';
    const m = /^\/videos\/([a-z0-9-]+)$/.exec(req.path);
    if (m) {
      const v = (await getCatalog()).find((x) => x.slug === m[1]);
      if (!v) res.status(404);
      else {
        const img = v.thumbnailPath ? `${config.mediaBaseUrl}/${v.thumbnailPath}` : v.thumbnailUrl;
        tags = metaTags(b, `${v.pageTitle || v.title} | ${b.identity.siteName}`, v.shortDescription, `${config.publicSiteUrl}/videos/${v.slug}`, img ?? siteImage);
      }
    }
    if (preview) tags += '\n    <meta name="robots" content="noindex, nofollow">';
    html = html.replace(/<title>.*?<\/title>/s, '').replace('<!--app-meta-->', `${tags}\n    ${brandHeadTags(b)}\n    ${brandDataScript(b, preview)}`);
    res.set('Cache-Control', preview || tokenPage ? 'no-store' : 'no-cache').type('html').send(html);
  } catch (e) {
    next(e);
  }
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  void _next;
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

await refreshCatalog();
app.listen(port, () => console.info(`Public site listening on :${port} (data: ${config.dataMode})`));
