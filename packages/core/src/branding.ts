import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  GOOGLE_FONTS, PAGE_TARGETS, SYSTEM_FONTS, brandAssetUrl, brandCss, googleFontsUrl, withDefaults,
  type BrandAsset, type Branding,
} from './branding-model.js';
import { cleanText, escapeHtml } from './text.js';

export * from './branding-model.js';

// ---------- stored document ----------
export interface BrandingVersion {
  version: number;
  settings: Branding;
  publishedAt: string;
  publishedBy: string;
  note?: string;
}

/** One document (id "branding") in the meta container. */
export interface BrandingDoc {
  id: 'branding';
  /** What the public site shows. Missing until the first publish (the site then uses DEFAULT_BRANDING). */
  published?: BrandingVersion;
  /** Work in progress. Missing when there are no unpublished changes. */
  draft?: { settings: Branding; rev: number; updatedAt: string; updatedBy: string };
  /** Earlier published versions, newest first. */
  history: BrandingVersion[];
  /** One active preview link for the draft. Only the SHA-256 of the token is stored. */
  preview?: { tokenHash: string; expiresAt: string };
}

export const BRANDING_HISTORY_LIMIT = 20;
export const PREVIEW_HOURS = 24;

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

/** The draft branding, if the preview token is valid and unexpired. */
export function previewSettings(doc: BrandingDoc | undefined, token: string | undefined, now = Date.now()): Branding | undefined {
  if (!doc?.preview || !token || token.length > 100) return undefined;
  if (Date.parse(doc.preview.expiresAt) < now || hashToken(token) !== doc.preview.tokenHash) return undefined;
  return withDefaults(doc.draft?.settings ?? doc.published?.settings);
}

export const publishedSettings = (doc: BrandingDoc | undefined): Branding => withDefaults(doc?.published?.settings);

// ---------- asset files ----------
export const BRAND_ASSET_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', woff2: 'font/woff2',
} as const;
export type BrandAssetExt = keyof typeof BRAND_ASSET_TYPES;
export const BRAND_ASSET_FILE = /^[a-f0-9]{16}\.(png|jpg|webp|svg|ico|woff2)$/;

export type BrandAssetKind = 'logo' | 'footerLogo' | 'favicon' | 'touchIcon' | 'socialImage' | 'font';
export const BRAND_ASSET_RULES: Record<BrandAssetKind, { exts: BrandAssetExt[]; maxBytes: number; square?: boolean; minSize?: number; label: string }> = {
  logo: { exts: ['svg', 'png', 'webp', 'jpg'], maxBytes: 1024 * 1024, label: 'Header logo' },
  footerLogo: { exts: ['svg', 'png', 'webp', 'jpg'], maxBytes: 1024 * 1024, label: 'Footer logo' },
  favicon: { exts: ['svg', 'png', 'ico'], maxBytes: 256 * 1024, square: true, minSize: 32, label: 'Favicon' },
  touchIcon: { exts: ['png'], maxBytes: 512 * 1024, square: true, minSize: 120, label: 'Home-screen icon' },
  socialImage: { exts: ['png', 'jpg', 'webp'], maxBytes: 2 * 1024 * 1024, minSize: 200, label: 'Link-preview image' },
  font: { exts: ['woff2'], maxBytes: 2 * 1024 * 1024, label: 'Font file' },
};

/** Reasons an SVG is refused. SVG can carry script, so only plain vector artwork is accepted. */
const SVG_BLOCKLIST: [RegExp, string][] = [
  [/<script/i, 'scripts'],
  [/<foreignObject|<iframe|<embed|<object/i, 'embedded HTML'],
  [/<!ENTITY|<!DOCTYPE/i, 'DTDs or entities'],
  [/\son[a-z]+\s*=/i, 'event handlers'],
  [/javascript:|vbscript:|data:text\/html/i, 'script links'],
  [/(?:xlink:)?href\s*=\s*["']\s*(?!#|data:image\/(?:png|jpe?g|webp|gif);)/i, 'links to other files'],
  [/@import|url\(\s*["']?\s*(?:https?:|\/\/)/i, 'external stylesheets or images'],
];

export function svgProblem(buf: Buffer): string | undefined {
  const text = buf.toString('utf8').replace(/^﻿/, '');
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>/]/i.test(text)) return 'This is not an SVG image';
  for (const [re, what] of SVG_BLOCKLIST) if (re.test(text)) return `SVG files with ${what} aren't allowed. Export it again as plain artwork, or use a PNG.`;
  return undefined;
}

function sniff(buf: Buffer): BrandAssetExt | undefined {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  if (buf.length > 6 && buf.readUInt16LE(0) === 0 && buf.readUInt16LE(2) === 1 && buf.readUInt16LE(4) > 0) return 'ico';
  if (buf.length > 4 && buf.subarray(0, 4).toString('ascii') === 'wOF2') return 'woff2';
  if (/^\s*(?:<\?xml|<svg|<!--)/i.test(buf.subarray(0, 512).toString('utf8').replace(/^﻿/, ''))) return 'svg';
  return undefined;
}

/** Pixel size for PNG, JPEG, WebP and ICO. Undefined for SVG and fonts. */
export function imageSize(buf: Buffer, ext: BrandAssetExt): { width: number; height: number } | undefined {
  try {
    if (ext === 'png' && buf.length >= 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    if (ext === 'ico') return { width: buf[6] || 256, height: buf[7] || 256 };
    if (ext === 'webp') {
      const chunk = buf.subarray(12, 16).toString('ascii');
      if (chunk === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
      if (chunk === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }; }
    }
    if (ext === 'jpg') {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) return undefined;
        const m = buf[i + 1]!;
        if (m === 0xff) { i++; continue; }
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* truncated file */ }
  return undefined;
}

/**
 * Check an uploaded brand file by its content (never its name or the browser's type).
 * Returns the stored asset description, or an error message.
 */
export function inspectBrandAsset(kind: BrandAssetKind, buf: Buffer, originalName?: string): { asset: BrandAsset; ext: BrandAssetExt } | { error: string } {
  const rule = BRAND_ASSET_RULES[kind];
  const ext = sniff(buf);
  const allowed = rule.exts.map((e) => e.toUpperCase()).join(', ');
  if (!ext || !rule.exts.includes(ext)) return { error: `${rule.label}: upload ${allowed}` };
  if (buf.length > rule.maxBytes) return { error: `${rule.label}: the file is larger than ${Math.round(rule.maxBytes / 1024)} KB` };
  if (ext === 'svg') { const p = svgProblem(buf); if (p) return { error: p }; }
  const size = imageSize(buf, ext);
  if (size) {
    if (rule.square && size.width !== size.height) return { error: `${rule.label}: the image must be square (this one is ${size.width} x ${size.height})` };
    if (rule.minSize && Math.min(size.width, size.height) < rule.minSize) return { error: `${rule.label}: the image must be at least ${rule.minSize} pixels (this one is ${size.width} x ${size.height})` };
  }
  const file = `${createHash('sha256').update(buf).digest('hex').slice(0, 16)}.${ext}`;
  return { ext, asset: { file, type: BRAND_ASSET_TYPES[ext], bytes: buf.length, ...size, name: originalName ? cleanText(originalName, 200) || undefined : undefined } };
}

export const brandAssetBlob = (file: string) => `branding/${file}`;

/** Every uploaded file the settings refer to. */
export function referencedAssets(b: Branding): BrandAsset[] {
  const fonts = [b.fonts.heading, b.fonts.body].flatMap((f) => (f.source === 'upload' ? [f.file] : []));
  return [...Object.values(b.assets).filter((a): a is BrandAsset => !!a), ...fonts];
}

// ---------- validation ----------
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'use a #rrggbb colour').transform((s) => s.toLowerCase());
const text = (max: number, min = 0) => z.string().max(max * 2).transform((s) => cleanText(s, max)).pipe(z.string().min(min, min ? 'is required' : undefined));
const href = z.string().trim().max(500).refine(
  (h) => Object.hasOwn(PAGE_TARGETS, h) || /^https:\/\/[^\s<>"'`]+$/i.test(h) || /^mailto:[^@\s<>"']+@[^@\s<>"']+$/i.test(h),
  'must be a built-in page, an https:// address or a mailto: address',
);
const link = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/),
  label: text(40, 1),
  href,
  style: z.enum(['link', 'button']).optional(),
  visible: z.boolean(),
});
const asset = z.object({
  file: z.string().regex(BRAND_ASSET_FILE),
  type: z.enum(Object.values(BRAND_ASSET_TYPES) as [string, ...string[]]),
  bytes: z.number().int().positive(),
  width: z.number().int().positive().max(20000).optional(),
  height: z.number().int().positive().max(20000).optional(),
  name: z.string().max(200).optional(),
});
const font = z.discriminatedUnion('source', [
  z.object({ source: z.literal('google'), family: z.enum(GOOGLE_FONTS) }),
  z.object({ source: z.literal('system'), family: z.enum(Object.keys(SYSTEM_FONTS) as [keyof typeof SYSTEM_FONTS]) }),
  z.object({ source: z.literal('upload'), family: z.string().trim().regex(/^[A-Za-z0-9 -]{2,40}$/, 'letters, numbers, spaces and dashes only'), file: asset.refine((a) => a.file.endsWith('.woff2'), 'must be a WOFF2 file') }),
]);
const contact = z.object({ title: text(60, 1), intro: text(300), button: text(30, 1) });

export const brandingSchema = z.object({
  identity: z.object({ siteName: text(60, 1), brandSubtitle: text(40), logoAlt: text(100, 1), logoHeight: z.number().int().min(20).max(80) }),
  colors: z.object({
    primary: hex, primaryDeep: hex, secondary: hex, accent: hex, accentDark: hex, accentSoft: hex,
    text: hex, muted: hex, mutedLight: hex, border: hex, background: hex, surface: hex,
  }),
  fonts: z.object({ heading: font, body: font }),
  assets: z.object({ logo: asset.optional(), footerLogo: asset.optional(), favicon: asset.optional(), touchIcon: asset.optional(), socialImage: asset.optional() }),
  header: z.object({ menu: z.array(link).max(8) }),
  home: z.object({
    eyebrow: text(60), heading: text(80, 1), headingAccent: text(60), lead: text(300), searchPlaceholder: text(80), showBusinessLines: z.boolean(),
    featuredHeading: text(60, 1), latestHeading: text(60, 1), browseAllLabel: text(30, 1), productsHeading: text(60, 1), showProducts: z.boolean(),
    showCta: z.boolean(), ctaHeading: text(80), ctaText: text(300), ctaSuggestLabel: text(30, 1), ctaDemoLabel: text(30, 1),
  }),
  footer: z.object({ heading: text(60), text: text(400), links: z.array(link).max(10), copyright: text(120), showLogo: z.boolean() }),
  pages: z.object({
    videosHeading: text(60, 1), archiveHeading: text(60, 1), subscribeHeading: text(80, 1), subscribeIntro: text(400),
    contact, suggest: contact, demo: contact, notFoundHeading: text(80, 1), notFoundText: text(300),
  }),
  seo: z.object({ description: text(300) }),
  legal: z.object({ privacyUrl: z.string().trim().max(500).regex(/^https:\/\/[^\s<>"'`]+$/i, 'must be an https:// address') }),
}).superRefine((b, ctx) => {
  for (const [list, path] of [[b.header.menu, 'header.menu'], [b.footer.links, 'footer.links']] as const) {
    const ids = list.map((l) => l.id);
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', path: path.split('.'), message: 'link ids must be unique' });
  }
});

export const brandingSaveSchema = z.object({ settings: brandingSchema, rev: z.number().int().min(0) });
export const brandingPublishSchema = z.object({ rev: z.number().int().min(0), note: z.string().max(400).optional() });

// ---------- HTML head ----------
/** Tags for <head>: brand CSS, fonts, favicon, touch icon and theme colour. */
export function brandHeadTags(b: Branding): string {
  const out = [`<meta name="theme-color" content="${escapeHtml(b.colors.primary)}">`];
  const gf = googleFontsUrl(b);
  if (gf) {
    out.push('<link rel="preconnect" href="https://fonts.googleapis.com">', '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>');
    out.push(`<link rel="stylesheet" href="${escapeHtml(gf)}">`);
  }
  // brandCss only contains validated colours, numbers, curated or [A-Za-z0-9 -] family names and fixed URLs.
  out.push(`<style id="brand-css">${brandCss(b).replace(/</g, '\\3c ')}</style>`);
  const fav = b.assets.favicon;
  out.push(fav ? `<link rel="icon" type="${escapeHtml(fav.type)}" href="${escapeHtml(brandAssetUrl(fav))}">` : '<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
  if (b.assets.touchIcon) out.push(`<link rel="apple-touch-icon" href="${escapeHtml(brandAssetUrl(b.assets.touchIcon))}">`);
  return out.join('\n    ');
}

/** Branding as a JSON data block the browser app reads on start-up (never executed). */
export function brandDataScript(b: Branding, preview = false): string {
  const json = JSON.stringify({ branding: b, preview }).replace(/</g, '\\u003c').replace(/ /g, '\\u2028').replace(/ /g, '\\u2029');
  return `<script id="brand-data" type="application/json">${json}</script>`;
}

// ---------- serving brand files from the sites' own origin ----------
const assetCache = new Map<string, { body: Buffer; type: string }>();

/**
 * Fetch a brand file from the media CDN, cached in memory. File names are content hashes,
 * so a cached copy never goes stale.
 */
export async function fetchBrandAsset(mediaBaseUrl: string, file: string): Promise<{ body: Buffer; type: string } | undefined> {
  if (!BRAND_ASSET_FILE.test(file)) return undefined;
  const hit = assetCache.get(file);
  if (hit) return hit;
  const res = await fetch(`${mediaBaseUrl}/${brandAssetBlob(file)}`, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return undefined;
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > 3 * 1024 * 1024) return undefined;
  const entry = { body, type: BRAND_ASSET_TYPES[file.split('.').pop() as BrandAssetExt] };
  if (assetCache.size >= 60) assetCache.delete(assetCache.keys().next().value!);
  assetCache.set(file, entry);
  return entry;
}

/** Response headers for a brand file. SVGs get a script-free sandbox in case one is opened directly. */
export function brandAssetHeaders(type: string): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' };
  if (type === 'image/svg+xml') h['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";
  return h;
}
