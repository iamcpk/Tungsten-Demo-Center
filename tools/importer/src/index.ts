/**
 * Imports the iVengi Excel export into the Demo Center data store.
 *
 *   npm run import -- --file "iVengi Export/Video Data 7 Nov 2026.xlsx"            (dry run, report only)
 *   npm run import -- --file ... --write                                           (local JSON store in ./data)
 *   COSMOS_ENDPOINT=... STORAGE_ACCOUNT=... MEDIA_BASE_URL=... npm run import -- --file ... --write   (Azure)
 *
 * Options: --no-files (skip copying thumbnails/attachments), --limit N, --report path,
 *          --blob <name> (read the export from the private uploads container; used by the Azure job),
 *          --legacy-site https://www.tungstendemocenter.com (keep the old page slugs and use the real download links).
 * Re-running is safe: video ids are derived from the iVengi contentindex, so records are updated in place.
 * Admin edits made in the new platform after import WILL be overwritten for re-imported rows.
 */
import ExcelJS from 'exceljs';
import type { Cell } from 'exceljs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ATTACHMENT_TYPES, BLOB_CONTAINERS, cleanHtml, cleanText, createMedia, createStores, fetchOEmbed, loadConfig, parseExternalVideoUrl,
  safeBlobName, slugify, type Attachment, type BusinessLine, type Taxonomy, type Video, type VideoSource,
} from '@tdc/core';
import { cleanLegacyHtml, excelDate, isHttpUrl, legacyPublishDate, parseKeywords, parseMulti, stableId } from './parse.js';

// ---------- arguments ----------
const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (name: string) => argv.includes(`--${name}`);
const file = arg('file');
/** Name of the export in the private "uploads" container (used when the importer runs as an Azure job). */
const blobFile = arg('blob');
if (!file && !blobFile) { console.error('Usage: npm run import -- (--file <export.xlsx> | --blob <name in uploads>) [--write] [--no-files] [--limit N]'); process.exit(2); }
const write = flag('write');
const copyFiles = !flag('no-files');
const limit = Number(arg('limit') ?? Infinity);
// npm runs workspace scripts inside tools/importer; resolve paths against where the user ran the command.
const userCwd = process.env.INIT_CWD ?? process.cwd();
const inputFile = file ? path.resolve(userCwd, file) : undefined;
const reportArg = arg('report');
/** Live iVengi site to read slugs and real download links from, for example https://www.tungstendemocenter.com */
const legacySite = arg('legacy-site')?.replace(/\/+$/, '');

// Hosts the importer may download from. Values in the spreadsheet never choose the host.
const DOWNLOAD_HOSTS = new Set(['www.tungstendemocenter.com', 'tungstendemocenter.com', 'i.vimeocdn.com']);
const MAX_DOWNLOAD = 500 * 1024 ** 2;
/** Publish date for rows with no date at all: older than any real iVengi content, so they sort last. */
const UNDATED = '2000-01-01T00:00:00.000Z';

// ---------- column map (1-based, verified against the header row at start-up) ----------
const COL = {
  legacyId: [1, 'contentindex'], type: [4, 'Select the type of video:'], pageTitle: [5, 'Page title:'], videoUrl: [6, 'Video url:'],
  pageDescription: [7, 'Page description'], status: [9, 'Set the status of the video:'], products: [10, 'Select products:'],
  title: [11, 'Title:'], notes: [14, 'Internal notifications'], verticals: [16, 'Select verticals:'],
  shortDescription: [17, 'Short description:'], authors: [21, 'Select authors:'], keywords: [27, 'Enter keywords'],
  longText: [30, 'Long text:'], date: [34, 'Date:_date'], time: [35, 'Date:_time'], dateCustom: [36, 'Date:_date_time_custom'], imageReg: [37, 'If you want to overwrite the default image'],
  group: [42, 'Group:'], languages: [43, 'Select languages:'], itemType: [46, 'Item type'], categories: [47, 'Select the categories:'],
} as const;
// [description column, url column, display-name column] for the five attachment slots
const ATTACH = [[3, 12, 13], [15, 18, 19], [20, 24, 25], [26, 28, 29], [31, 32, 33]] as const;

function text(cell: Cell): string {
  const v = cell.value as unknown;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as { richText?: { text: string }[]; text?: string; hyperlink?: string; result?: unknown };
    if (o.richText) return o.richText.map((r) => r.text).join('');
    if (o.hyperlink) return o.hyperlink;
    if (o.text !== undefined) return String(o.text);
    if (o.result !== undefined) return String(o.result);
    if (v instanceof Date) return v.toISOString();
  }
  return String(v);
}

interface Issue { legacyId: string; title: string; issue: string }
const issues: Issue[] = [];
const note = (legacyId: string, title: string, issue: string) => issues.push({ legacyId, title, issue });

function encodeUrl(u: string) {
  return encodeURI(decodeURI(u.trim()));
}

/** fetch() restricted to the allow-listed hosts, including after redirects. */
async function fetchAllowed(url: string, timeoutMs = 120_000): Promise<Response> {
  const u = new URL(encodeUrl(url));
  if (u.protocol !== 'https:' || !DOWNLOAD_HOSTS.has(u.hostname)) throw new Error(`host not allowed: ${u.hostname}`);
  const res = await fetch(u, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const final = new URL(res.url);
  if (!DOWNLOAD_HOSTS.has(final.hostname)) throw new Error(`redirected to disallowed host ${final.hostname}`);
  return res;
}

// ---------- live iVengi site: slugs and real download links ----------
// The export has neither the page slug nor the real download URL (iVengi adds a random token to file names),
// so both are read from the live site. Keeping the old slug means /items/{slug} redirects land on the same video.
const LEGACY_LIST_PATH = '/IManager/Content/71293/Yq7h/mt32557/mp0';
const SLUG_RE = /^\/items\/([a-z0-9][a-z0-9-]{0,150})$/i;

async function fetchLegacySlugs(origin: string): Promise<Map<string, string>> {
  const slugs = new Map<string, string>();
  for (let offset = 0; offset < 5000; offset += 100) {
    const res = await fetchAllowed(`${origin}${LEGACY_LIST_PATH}?offset=${offset}&limit=100`, 60_000);
    const body = (await res.json()) as Array<{ Hits?: { Total: number; ContentIndexes: string[] }; Items?: Array<{ link?: string }> }>;
    const hits = body.find((x) => x.Hits)?.Hits;
    const items = body.find((x) => x.Items)?.Items ?? [];
    if (!hits || hits.ContentIndexes.length !== items.length) throw new Error('Unexpected iVengi listing format');
    hits.ContentIndexes.forEach((id, i) => {
      const m = SLUG_RE.exec(items[i]?.link ?? '');
      if (m) slugs.set(String(id), m[1]!.toLowerCase());
    });
    if (!hits.ContentIndexes.length || offset + hits.ContentIndexes.length >= hits.Total) break;
  }
  return slugs;
}

/** Comparable form of a file name: iVengi's "{n}_{id}_{token}_" prefix removed, only letters and digits kept. */
function fileKey(name: string): string {
  let decoded = name;
  try { decoded = decodeURIComponent(name); } catch { /* keep as is */ }
  return decoded.replace(/^\d+_\d+_[A-Za-z0-9]{2,8}_/, '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function fetchLegacyDownloads(origin: string, slug: string, legacyId: string): Promise<string[]> {
  const html = await (await fetchAllowed(`${origin}/items/${slug}`, 60_000)).text();
  const links = new Set<string>();
  for (const m of html.matchAll(/href="([^"]*\/IManager\/Download\/[^"]+)"/gi)) {
    const href = new URL(m[1]!.replace(/&amp;/g, '&'), origin).toString();
    if (href.includes(`/${legacyId}/`)) links.add(href);
  }
  return [...links];
}

async function download(url: string): Promise<{ data: Buffer; type?: string } | undefined> {
  const res = await fetchAllowed(url);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_DOWNLOAD) throw new Error('file too large');
  const data = Buffer.from(await res.arrayBuffer());
  if (data.length > MAX_DOWNLOAD) throw new Error('file too large');
  return { data, type: res.headers.get('content-type') ?? undefined };
}

async function main() {
  const config = loadConfig();
  const stores = createStores(config);
  const media = createMedia(config);
  const reportPath = reportArg ? path.resolve(userCwd, reportArg) : path.resolve(config.localDataDir, 'import-report.json');
  console.info(`Reading ${inputFile ?? `uploads/${blobFile}`}`);
  console.info(write ? `Target: ${config.dataMode === 'cosmos' ? `Cosmos DB ${config.cosmosEndpoint}` : `local store in ./${config.localDataDir}`}, media: ${media.mode}` : 'DRY RUN (add --write to save)');

  const wb = new ExcelJS.Workbook();
  if (inputFile) await wb.xlsx.readFile(inputFile);
  else await wb.xlsx.load((await media.readBlob(BLOB_CONTAINERS.uploads, blobFile!)) as unknown as ArrayBuffer);
  const ws = wb.worksheets[0]!;
  const header = ws.getRow(1);
  for (const [key, [col, prefix]] of Object.entries(COL)) {
    const h = text(header.getCell(col));
    if (!h.startsWith(prefix)) throw new Error(`Unexpected column ${col} for ${key}: "${h}" (expected "${prefix}..."). The export layout has changed.`);
  }

  const existing = new Map((await stores.videos.list()).map((v) => [v.id, v]));
  const slugs = new Set([...existing.values()].map((v) => v.slug));
  const legacySlugs = legacySite ? await fetchLegacySlugs(legacySite) : new Map<string, string>();
  if (legacySite) console.info(`Live site: ${legacySlugs.size} slugs read from ${legacySite}`);
  for (const s of legacySlugs.values()) slugs.add(s);
  const videos: Video[] = [];
  const tax: Record<keyof Omit<Taxonomy, 'id' | 'updatedAt'>, Map<string, number>> = {
    products: new Map(), verticals: new Map(), authors: new Map(), languages: new Map(), categories: new Map(),
  };
  const now = new Date().toISOString();

  for (let r = 2; r <= ws.rowCount && videos.length < limit; r++) {
    const row = ws.getRow(r);
    const c = (k: keyof typeof COL) => text(row.getCell(COL[k][0])).trim();
    const legacyId = c('legacyId');
    if (!legacyId) continue;
    const title = cleanText(c('title') || c('pageTitle'), 200);
    if (!title) { note(legacyId, '', 'no title, skipped'); continue; }
    const id = stableId(legacyId);
    const prev = existing.get(id);

    // Status. "Test group" rows are imported as hidden drafts.
    const statusRaw = c('status').toLowerCase();
    let status: Video['status'] = statusRaw === 'active' ? 'active' : statusRaw === 'archived' ? 'archived' : 'draft';
    if (c('group') === 'Test group') { status = 'draft'; note(legacyId, title, 'in "Test group": imported as draft'); }

    const itemType: Video['itemType'] = c('itemType').toLowerCase() === 'document' ? 'document' : 'video';
    const rawUrl = c('videoUrl');
    let source: VideoSource | undefined = rawUrl ? parseExternalVideoUrl(rawUrl) : undefined;
    if (rawUrl && !source) note(legacyId, title, `unrecognised video URL "${rawUrl}"`);
    if (!source) {
      source = { provider: 'vimeo' };
      if (itemType === 'video' && status !== 'draft') { status = 'draft'; note(legacyId, title, 'no playable video URL: imported as draft'); }
    }

    // Publish date drives "latest first" on the site, so it comes from the iVengi Date:_date column
    // (+ Date:_time). Undated rows must not fall back to "now", which would push them to the top.
    const dayCell = row.getCell(COL.date[0]).value ?? c('date');
    let publishedAt = legacyPublishDate(dayCell, c('time'), c('dateCustom'));
    if (publishedAt && !excelDate(dayCell, c('time'))) note(legacyId, title, `Date:_date empty (row shifted): used Date:_time "${c('time')}" = ${publishedAt.slice(0, 16)}`);
    if (!publishedAt) {
      publishedAt = UNDATED;
      note(legacyId, title, `no publish date in the export: set to ${publishedAt.slice(0, 10)} so it sorts after dated videos`);
    }

    const businessLines = parseMulti(c('type')).filter((b): b is BusinessLine => b === 'IA' || b === 'PA');
    const v: Video = {
      id,
      slug: legacySlugs.get(legacyId) ?? prev?.slug ?? (() => { const base = slugify(title); let s = base; for (let i = 2; slugs.has(s); i++) s = `${base}-${i}`; slugs.add(s); return s; })(),
      title,
      pageTitle: cleanText(c('pageTitle'), 200) || undefined,
      shortDescription: cleanText(c('shortDescription') || c('pageDescription'), 600),
      description: cleanHtml(cleanLegacyHtml(c('longText'))),
      status,
      itemType,
      businessLines,
      products: parseMulti(c('products')),
      verticals: parseMulti(c('verticals')),
      authors: parseMulti(c('authors')),
      languages: parseMulti(c('languages')),
      categories: parseMulti(c('categories')).filter((x) => x.toLowerCase() !== 'video'),
      keywords: parseKeywords(c('keywords')),
      featured: prev?.featured ?? false,
      source: { ...source, durationSec: prev?.source.durationSec },
      thumbnailPath: prev?.thumbnailPath,
      thumbnailUrl: undefined,
      attachments: [],
      publishedAt,
      createdAt: prev?.createdAt ?? now,
      updatedAt: now,
      createdBy: prev?.createdBy ?? 'ivengi-import',
      updatedBy: 'ivengi-import',
      internalNotes: cleanText(c('notes'), 4000) || undefined,
      legacyId,
    };
    for (const k of Object.keys(tax) as (keyof typeof tax)[]) for (const val of v[k]) tax[k].set(val, (tax[k].get(val) ?? 0) + 1);

    // Thumbnail: iVengi custom image, else Vimeo/YouTube oEmbed thumbnail.
    const img = c('imageReg');
    if (isHttpUrl(img)) v.thumbnailUrl = encodeUrl(img);
    if (!v.thumbnailUrl && source.externalId) {
      const info = await fetchOEmbed(source).catch(() => undefined);
      if (info?.thumbnailUrl) v.thumbnailUrl = info.thumbnailUrl;
      if (info?.durationSec) v.source.durationSec = info.durationSec;
      if (!info) note(legacyId, title, 'oEmbed lookup failed (video may be private or deleted on Vimeo)');
    }

    // Attachments
    for (const [descCol, urlCol, nameCol] of ATTACH) {
      const url = text(row.getCell(urlCol)).trim();
      if (!url) continue;
      const preview = url.slice(0, 60);
      if (!isHttpUrl(url)) { note(legacyId, title, `attachment cell is not a URL (misaligned row?): "${preview}"`); continue; }
      const fileName = decodeURIComponent(url.split('/').pop() ?? 'file');
      const att: Attachment = {
        id: stableId(`${legacyId}:${urlCol}`),
        name: cleanText(text(row.getCell(nameCol)) || fileName, 200),
        description: cleanText(text(row.getCell(descCol)), 400) || undefined,
        url: encodeUrl(url),
        contentType: ATTACHMENT_TYPES[(fileName.split('.').pop() ?? '').toLowerCase()],
      };
      v.attachments.push(att);
    }
    if (legacySite && !legacySlugs.has(legacyId)) note(legacyId, title, 'not found on the live site: kept a generated slug, so its old /items/ link will not redirect');

    // The export's attachment URLs are not the real ones; swap in the live site's links.
    const liveSlug = legacySlugs.get(legacyId);
    if (liveSlug && v.attachments.length) {
      let live: string[] = [];
      try { live = await fetchLegacyDownloads(legacySite!, liveSlug, legacyId); }
      catch (e) { note(legacyId, title, `could not read live page for attachments: ${(e as Error).message}`); }
      const unused = new Set(live);
      for (const a of v.attachments) {
        const want = fileKey(a.url!.split('/').pop() ?? '');
        const hit = [...unused].find((l) => fileKey(l.split('/').pop() ?? '') === want);
        if (hit) { a.url = hit; unused.delete(hit); }
      }
      // Anything left unmatched: pair by position when the counts agree, otherwise report it.
      const missing = v.attachments.filter((a) => !live.includes(a.url!));
      if (missing.length && missing.length === unused.size) missing.forEach((a, i) => { a.url = [...unused][i]; });
      else for (const a of missing) note(legacyId, title, `no matching download on the live page for attachment (${a.name})`);
    }
    videos.push(v);
  }

  // ---------- copy files into Blob Storage ----------
  if (write && copyFiles) {
    let n = 0;
    for (const v of videos) {
      n++;
      if (v.thumbnailUrl && !v.thumbnailPath) {
        try {
          const f = await download(v.thumbnailUrl);
          if (f) {
            const ext = /png/.test(f.type ?? '') ? 'png' : /webp/.test(f.type ?? '') ? 'webp' : 'jpg';
            v.thumbnailPath = await media.putMedia(`thumbs/${v.id}/legacy.${ext}`, f.data, f.type ?? 'image/jpeg');
            v.thumbnailUrl = undefined;
          }
        } catch (e) { note(v.legacyId!, v.title, `thumbnail copy failed: ${(e as Error).message}`); }
      }
      for (const a of v.attachments) {
        if (!a.url) continue;
        try {
          const f = await download(a.url);
          if (f) {
            const name = safeBlobName(decodeURIComponent(a.url.split('/').pop() ?? a.name).replace(/^\d+_\d+_[A-Za-z0-9]{2,8}_/, ''));
            a.path = await media.putMedia(`attachments/${v.id}/${name}`, f.data, a.contentType ?? f.type ?? 'application/octet-stream');
            a.sizeBytes = f.data.length;
            a.url = undefined;
          }
        } catch (e) { note(v.legacyId!, v.title, `attachment copy failed (${a.name}): ${(e as Error).message}`); }
      }
      if (n % 25 === 0) console.info(`  files: ${n}/${videos.length}`);
    }
  }

  // ---------- save ----------
  if (write) {
    for (const v of videos) await stores.videos.upsert(v);
    const current = await stores.meta.get('taxonomy');
    const merge = (k: keyof typeof tax) => {
      const fromData = [...tax[k]].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([x]) => x);
      return [...new Set([...(current?.[k] ?? []), ...fromData])];
    };
    await stores.meta.upsert({ id: 'taxonomy', products: merge('products'), verticals: merge('verticals'), authors: merge('authors'), languages: merge('languages'), categories: merge('categories'), updatedAt: now });
  }

  // ---------- report ----------
  const count = (pred: (v: Video) => boolean) => videos.filter(pred).length;
  const summary = {
    rows: videos.length,
    active: count((v) => v.status === 'active'),
    archived: count((v) => v.status === 'archived'),
    draft: count((v) => v.status === 'draft'),
    vimeo: count((v) => v.source.provider === 'vimeo' && !!v.source.externalId),
    youtube: count((v) => v.source.provider === 'youtube'),
    withThumbnail: count((v) => !!(v.thumbnailPath || v.thumbnailUrl)),
    attachments: videos.reduce((n, v) => n + v.attachments.length, 0),
    attachmentsCopied: videos.reduce((n, v) => n + v.attachments.filter((a) => a.path).length, 0),
    products: tax.products.size, authors: tax.authors.size, verticals: tax.verticals.size, languages: tax.languages.size, categories: tax.categories.size,
    issues: issues.length,
  };
  const report = JSON.stringify({ generatedAt: now, written: write, summary, issues }, null, 2);
  let reportWhere: string;
  if (blobFile) {
    // Running as a job: keep the report (it can contain internal notes' context) in the private uploads container.
    const name = `imports/report-${now.replace(/[:.]/g, '-')}${write ? '' : '-dryrun'}.json`;
    await media.writeBlob(BLOB_CONTAINERS.uploads, name, Buffer.from(report), 'application/json');
    reportWhere = `uploads/${name}`;
  } else {
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, report);
    reportWhere = reportPath;
  }
  console.info(JSON.stringify(summary));
  console.info(`${issues.length} issue(s) written to ${reportWhere}${write ? '' : '. Nothing was saved (dry run).'}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
