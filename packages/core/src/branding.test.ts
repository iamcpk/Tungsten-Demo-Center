import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BRANDING, brandCss, brandDataScript, brandHeadTags, brandingSchema, contrastChecks, contrastRatio, copyrightText, googleFontsUrl,
  hashToken, imageSize, inspectBrandAsset, previewSettings, svgProblem, withDefaults, type BrandingDoc,
} from './branding.js';

const clone = () => structuredClone(DEFAULT_BRANDING);
const png = (w: number, h: number) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

test('the defaults pass validation unchanged', () => {
  assert.deepEqual(brandingSchema.parse(DEFAULT_BRANDING), DEFAULT_BRANDING);
});

test('validation rejects unsafe or malformed values', () => {
  const bad = (mut: (b: ReturnType<typeof clone>) => void) => { const b = clone(); mut(b); return brandingSchema.safeParse(b).success; };
  assert.equal(bad((b) => { b.colors.primary = 'red;}body{display:none'; }), false);
  assert.equal(bad((b) => { b.header.menu[0]!.href = 'javascript:alert(1)'; }), false);
  assert.equal(bad((b) => { b.header.menu[0]!.href = 'http://insecure.example.com'; }), false);
  assert.equal(bad((b) => { b.header.menu[0]!.href = 'toString'; }), false);
  assert.equal(bad((b) => { b.header.menu[1]!.id = b.header.menu[0]!.id; }), false);
  assert.equal(bad((b) => { b.fonts.body = { source: 'google', family: 'Comic Sans"}' }; }), false);
  assert.equal(bad((b) => { b.fonts.body = { source: 'upload', family: 'Brand', file: { file: '0123456789abcdef.png', type: 'image/png', bytes: 10 } }; }), false);
  assert.equal(bad((b) => { b.legal.privacyUrl = 'http://example.com'; }), false);
  // Built-in pages, https and mailto links are fine.
  assert.equal(bad((b) => { b.header.menu[0]!.href = 'mailto:demo@example.com'; b.footer.links[0]!.href = '/archive'; }), true);
});

test('text fields are stored as plain text', () => {
  const b = clone();
  b.home.heading = '<img src=x onerror=alert(1)>See <b>it</b>';
  assert.equal(brandingSchema.parse(b).home.heading, 'See it');
});

test('withDefaults fills fields added after a version was saved', () => {
  const partial = { colors: { primary: '#123456' }, home: { heading: 'Hi' } };
  const b = withDefaults(partial);
  assert.equal(b.colors.primary, '#123456');
  assert.equal(b.colors.accent, DEFAULT_BRANDING.colors.accent);
  assert.equal(b.home.heading, 'Hi');
  assert.equal(b.home.lead, DEFAULT_BRANDING.home.lead);
  assert.deepEqual(withDefaults(undefined), DEFAULT_BRANDING);
});

test('the default colours pass every WCAG AA check', () => {
  for (const c of contrastChecks(DEFAULT_BRANDING.colors)) assert.ok(c.ratio >= c.min, `${c.label}: ${c.ratio.toFixed(2)} < ${c.min}`);
});

test('contrast ratio matches WCAG reference values', () => {
  assert.equal(Math.round(contrastRatio('#000000', '#ffffff')), 21);
  assert.equal(contrastRatio('#777777', '#777777'), 1);
  assert.ok(Math.abs(contrastRatio('#767676', '#ffffff') - 4.54) < 0.02);
});

test('CSS, fonts and head tags come from the settings', () => {
  const b = clone();
  b.fonts.heading = { source: 'google', family: 'Source Sans 3' };
  b.fonts.body = { source: 'upload', family: 'Brand Sans', file: { file: '0123456789abcdef.woff2', type: 'font/woff2', bytes: 100 } };
  const css = brandCss(b);
  assert.match(css, /--navy:#002854/);
  assert.match(css, /@font-face\{font-family:"Brand Sans";src:url\(\/brand\/0123456789abcdef\.woff2\)/);
  assert.equal(googleFontsUrl(b), 'https://fonts.googleapis.com/css2?family=Source+Sans+3:wght@400;500;700;900&display=swap');
  b.assets.favicon = { file: 'fedcba9876543210.png', type: 'image/png', bytes: 10, width: 48, height: 48 };
  const head = brandHeadTags(b);
  assert.match(head, /<link rel="icon" type="image\/png" href="\/brand\/fedcba9876543210\.png">/);
  assert.equal(googleFontsUrl({ ...b, fonts: { heading: { source: 'system', family: 'system-sans' }, body: { source: 'system', family: 'system-serif' } } }), undefined);
});

test('the JSON data block cannot break out of its script tag', () => {
  const b = clone();
  b.home.heading = '</script><script>alert(1)</script>';
  const s = brandDataScript(b);
  assert.equal(s.match(/<\/script>/g)?.length, 1);
  assert.equal(JSON.parse(s.replace(/^<script[^>]*>|<\/script>$/g, '')).branding.home.heading, b.home.heading);
});

test('copyright fills in the year', () => {
  assert.equal(copyrightText(DEFAULT_BRANDING, 2030), '© 2030 Tungsten Automation Corporation');
});

test('uploads are checked by content, size and shape', () => {
  const ok = inspectBrandAsset('favicon', png(48, 48), 'icon.png');
  assert.ok('asset' in ok && ok.asset.width === 48 && /^[a-f0-9]{16}\.png$/.test(ok.asset.file));
  assert.match((inspectBrandAsset('favicon', png(64, 32)) as { error: string }).error, /square/);
  assert.match((inspectBrandAsset('favicon', png(16, 16)) as { error: string }).error, /at least 32/);
  assert.match((inspectBrandAsset('touchIcon', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) as { error: string }).error, /PNG/);
  assert.match((inspectBrandAsset('font', png(10, 10)) as { error: string }).error, /WOFF2/);
  assert.ok('asset' in inspectBrandAsset('font', Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(40)])));
});

test('SVGs with script or external content are refused', () => {
  const plain = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="10" height="10"/><use href="#g"/></svg>';
  assert.equal(svgProblem(Buffer.from(plain)), undefined);
  for (const evil of [
    '<svg><script>alert(1)</script></svg>',
    '<svg onload="alert(1)"></svg>',
    '<svg><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg><image href="https://tracker.example.com/x.png"/></svg>',
    '<svg><foreignObject><div/></foreignObject></svg>',
    '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    '<svg><style>@import url(https://evil.example.com/x.css);</style></svg>',
    '<html><svg/></html>',
  ]) assert.ok(svgProblem(Buffer.from(evil)), evil);
});

test('JPEG and WebP sizes are read from the file header', () => {
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0x76, 0x04, 0xb0, 0, 0, 0]);
  assert.deepEqual(imageSize(jpg, 'jpg'), { width: 1200, height: 630 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'ascii'); webp.write('WEBP', 8, 'ascii'); webp.write('VP8X', 12, 'ascii');
  webp.writeUIntLE(1199, 24, 3); webp.writeUIntLE(629, 27, 3);
  assert.deepEqual(imageSize(webp, 'webp'), { width: 1200, height: 630 });
});

test('preview links need the right token and expire', () => {
  const draft = clone();
  draft.home.heading = 'Draft heading';
  const doc: BrandingDoc = { id: 'branding', history: [], draft: { settings: draft, rev: 1, updatedAt: '', updatedBy: '' }, preview: { tokenHash: hashToken('secret'), expiresAt: new Date(Date.now() + 60_000).toISOString() } };
  assert.equal(previewSettings(doc, 'secret')?.home.heading, 'Draft heading');
  assert.equal(previewSettings(doc, 'wrong'), undefined);
  assert.equal(previewSettings(doc, undefined), undefined);
  assert.equal(previewSettings(doc, 'secret', Date.now() + 120_000), undefined);
});
