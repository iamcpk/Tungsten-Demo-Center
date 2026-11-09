import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseQuery, rankDocs, indexDoc, type SearchDoc } from './search.js';
import { searchCatalog } from './catalog.js';
import type { Video } from './types.js';

const ECOPY = 'eCopy ShareScan 6.6 & TokenVault - For Modern-Auth with the Exchange Connector';

function find(docs: SearchDoc[], q: string): string[] {
  const r = rankDocs(docs, q, indexDoc);
  return [...r.hits].sort((a, b) => b[1] - a[1]).map(([d]) => d.title);
}

const DOCS: SearchDoc[] = [
  { title: ECOPY, tags: ['eCopy ShareScan'], body: '' },
  { title: 'Printix Capture Connector for Azure Logic App', tags: ['Printix'], body: 'Send scans to Azure.' },
  { title: 'Power PDF tips', tags: ['Power PDF'], body: 'Working with PDFs in Microsoft 365.' },
  { title: 'Café ordering with TotalAgility', tags: ['TotalAgility'], body: '' },
];

test('normalize ignores case, accents and punctuation', () => {
  assert.equal(normalize('  Modern-Auth & ShareScan 6.6 '), 'modern auth sharescan 6 6');
  assert.equal(normalize('Café'), 'cafe');
});

test('finds the eCopy video by any reasonable query', () => {
  for (const q of ['ecopy', 'eCopy', 'ECOPY', 'copy', 'eco', 'sharescan', 'share scan', 'tokenvault', 'token vault',
    'modern auth', 'modern-auth', 'modernauth', '6.6', 'sharescan 6.6', 'exchange connector', 'ecopy exchange',
    '"exchange connector"', 'ecopy tokenvault modern auth']) {
    assert.equal(find(DOCS, q)[0], ECOPY, `query "${q}"`);
  }
});

test('tolerates typos and partly typed words', () => {
  for (const q of ['ecpoy', 'sharscan', 'tokenvalt', 'exchnage', 'tokenvau', 'sharesca']) {
    assert.ok(find(DOCS, q).includes(ECOPY), `query "${q}"`);
  }
  assert.deepEqual(find(DOCS, 'prntix'), ['Printix Capture Connector for Azure Logic App']);
});

test('short words do not fuzzy-match everything', () => {
  assert.deepEqual(find(DOCS, 'pdf'), ['Power PDF tips']);
  assert.deepEqual(find(DOCS, 'zzz'), []);
});

test('every word must match, title ranks above tags and description', () => {
  assert.deepEqual(find(DOCS, 'connector azure'), ['Printix Capture Connector for Azure Logic App']);
  const docs: SearchDoc[] = [
    { title: 'Other', tags: [], body: 'mentions printix once' },
    { title: 'Tagged', tags: ['Printix'], body: '' },
    { title: 'Printix in the title', tags: [], body: '' },
  ];
  assert.deepEqual(find(docs, 'printix'), ['Printix in the title', 'Tagged', 'Other']);
});

test('stop words are optional and accents are ignored', () => {
  assert.equal(find(DOCS, 'the exchange connector')[0], ECOPY);
  assert.deepEqual(find(DOCS, 'cafe'), ['Café ordering with TotalAgility']);
});

test('quoted phrases must appear together', () => {
  assert.deepEqual(find(DOCS, '"connector exchange"'), []);
  assert.equal(find(DOCS, '"the exchange connector"')[0], ECOPY);
});

test('falls back to the closest matches when no video has every word', () => {
  const r = rankDocs(DOCS, 'ecopy kubernetes', indexDoc);
  assert.equal(r.relaxed, true);
  assert.deepEqual([...r.hits.keys()].map((d) => d.title), [ECOPY]);
  const none = rankDocs(DOCS, 'kubernetes docker helm', indexDoc);
  assert.equal(none.hits.size, 0);
});

test('a single letter is ignored and long queries are capped', () => {
  assert.equal(parseQuery('e').terms.length, 0);
  assert.equal(parseQuery('6').terms.length, 1);
  assert.equal(parseQuery(Array(50).fill('word').join(' ')).terms.length, 10);
});

function video(id: string, over: Partial<Video> = {}): Video {
  return {
    id, slug: id, title: id, shortDescription: '', description: '', status: 'active', itemType: 'video',
    businessLines: [], products: [], verticals: [], authors: [], languages: [], categories: [], keywords: [],
    featured: false, source: { provider: 'vimeo', externalId: '1' }, attachments: [],
    publishedAt: '2026-01-01T00:00:00Z', createdAt: '', updatedAt: '', ...over,
  };
}

test('joined words rank first: "share scan" finds ShareScan before SharePoint scanning', () => {
  const docs: SearchDoc[] = [
    { title: 'Scan to SharePoint with Printix', tags: [], body: '' },
    { title: 'eCopy ShareScan basics', tags: [], body: '' },
  ];
  assert.equal(find(docs, 'share scan')[0], 'eCopy ShareScan basics');
});

test('four-letter words need an exact or partial match, not a typo match', () => {
  const docs: SearchDoc[] = [{ title: 'Intelligent Automation overview', tags: [], body: '' }];
  assert.deepEqual(find(docs, 'auth'), []);
});

test('catalogue search across statuses: current wins a tie, a strong archived match beats a weak current one', () => {
  const all = [
    video('old', { title: ECOPY, status: 'archived', publishedAt: '2025-01-01T00:00:00Z' }),
    video('new', { title: 'eCopy PDF Pro basics', publishedAt: '2026-03-01T00:00:00Z' }),
    video('weak', { title: 'Scanning tips', description: 'Mentions the exchange and a connector.' }),
    video('draft', { title: 'eCopy draft', status: 'draft' }),
  ];
  const r = searchCatalog(all, { q: 'ecopy', status: ['active', 'archived'] });
  assert.deepEqual(r.items.map((x) => x.id), ['new', 'old']);
  assert.equal(r.archivedTotal, 1);
  const strong = searchCatalog(all, { q: 'exchange connector', status: ['active', 'archived'] });
  assert.deepEqual(strong.items.map((x) => x.id), ['old', 'weak']);
  assert.equal(searchCatalog(all, { q: 'ecopy', status: 'active' }).total, 1);
  assert.equal(searchCatalog(all, { q: 'ecopy', status: 'archived' }).items[0].id, 'old');
});

test('catalogue search reads description HTML as text', () => {
  const all = [video('a', { description: '<p>Works with <b>Exchange&nbsp;Online</b></p>' })];
  assert.equal(searchCatalog(all, { q: 'exchange online', status: 'active' }).total, 1);
  assert.equal(searchCatalog(all, { q: 'nbsp', status: 'active' }).total, 0);
});
