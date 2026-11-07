import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExternalVideoUrl, embedUrl } from './sources.js';
import { slugify, cleanHtml, cleanText } from './text.js';
import { searchCatalog } from './catalog.js';
import { toPublicVideo, type Video } from './types.js';

test('cleanText strips markup but keeps characters as plain text', () => {
  assert.equal(cleanText('Customer Onboarding & Account Opening'), 'Customer Onboarding & Account Opening');
  assert.equal(cleanText('Demo Commerciële Lening'), 'Demo Commerciële Lening');
  assert.equal(cleanText('<b>Bold</b> &amp; <script>alert(1)</script>safe'), 'Bold & safe');
  assert.equal(cleanText('Tom &quot;TJ&quot; O&#39;Neil &#x2014; &copy;'), 'Tom "TJ" O\'Neil — &copy;');
  assert.equal(cleanText('abcdef', 3), 'abc');
});

test('parses Vimeo URL shapes from the iVengi export', () => {
  assert.equal(parseExternalVideoUrl('https://vimeo.com/223143246')?.externalId, '223143246');
  assert.equal(parseExternalVideoUrl('https://player.vimeo.com/video/865632232')?.externalId, '865632232');
  const review = parseExternalVideoUrl('https://vimeo.com/nuancedemocenter/review/277491088/c5f0434417');
  assert.equal(review?.externalId, '277491088');
  assert.equal(review?.privacyHash, 'c5f0434417');
  assert.equal(parseExternalVideoUrl('https://vimeo.com/manage/717577854/advanced')?.externalId, '717577854');
  assert.match(embedUrl(review!)!, /h=c5f0434417/);
});

test('parses YouTube URLs and rejects other hosts', () => {
  assert.equal(parseExternalVideoUrl('https://youtu.be/dQw4w9WgXcQ')?.externalId, 'dQw4w9WgXcQ');
  assert.equal(parseExternalVideoUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1')?.externalId, 'dQw4w9WgXcQ');
  assert.equal(parseExternalVideoUrl('https://evil.example.com/watch?v=dQw4w9WgXcQ'), undefined);
  assert.equal(parseExternalVideoUrl('javascript:alert(1)'), undefined);
});

test('slugify matches iVengi item URLs', () => {
  assert.equal(slugify('Printix Capture Connector for Azure Logic App'), 'printix-capture-connector-for-azure-logic-app');
  assert.equal(slugify('Mon premier Scan To Folder avec eCopy ShareScan'), 'mon-premier-scan-to-folder-avec-ecopy-sharescan');
});

test('cleanHtml strips scripts and unsafe links', () => {
  const out = cleanHtml('<p onclick="x()">Hi<script>alert(1)</script> <a href="javascript:alert(1)">x</a></p>');
  assert.ok(!out.includes('script'));
  assert.ok(!out.includes('onclick'));
  assert.ok(!out.includes('javascript:'));
});

function v(id: string, over: Partial<Video> = {}): Video {
  return {
    id, slug: id, title: id, shortDescription: '', description: '', status: 'active', itemType: 'video',
    businessLines: [], products: [], verticals: [], authors: [], languages: [], categories: [], keywords: [],
    featured: false, source: { provider: 'vimeo', externalId: '1' }, attachments: [],
    publishedAt: '2026-01-01T00:00:00Z', createdAt: '', updatedAt: '', ...over,
  };
}

test('search filters, ranks and builds facets', () => {
  const all = [
    v('a', { title: 'Printix Go demo', products: ['Printix'], publishedAt: '2026-02-01T00:00:00Z' }),
    v('b', { title: 'Power PDF tips', products: ['Power PDF'], keywords: ['printix'] }),
    v('c', { title: 'Old Printix', products: ['Printix'], status: 'archived' }),
  ];
  const r = searchCatalog(all, { q: 'printix', status: 'active' });
  assert.deepEqual(r.items.map((x) => x.id), ['a', 'b']);
  const f = searchCatalog(all, { status: 'active', product: 'Printix' });
  assert.equal(f.total, 1);
  assert.equal(f.facets.products.find((x) => x.value === 'Power PDF')?.count, 1);
});

test('public projection removes internal fields', () => {
  const p = toPublicVideo(v('x', { internalNotes: 'secret', createdBy: 'me', source: { provider: 'azure', uploadBlob: 'raw.mp4', hlsPath: 'hls/x/master.m3u8' } }));
  const json = JSON.stringify(p);
  assert.ok(!json.includes('secret'));
  assert.ok(!json.includes('raw.mp4'));
  assert.ok(json.includes('master.m3u8'));
});
