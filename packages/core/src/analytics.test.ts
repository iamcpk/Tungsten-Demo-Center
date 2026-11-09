import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYTICS_RETENTION_DAYS, AnalyticsRecorder, addDays, daysBetween, earliestDay, isLikelyBot, parseTrackBatch, summarise, ttlFor,
  type AnalyticsDayDoc, type AnalyticsDoc, type AnalyticsTotalsDoc, type AnalyticsWriter,
} from './analytics.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const known = (id: string) => id === A || id === B;

/** In-memory writer with real ETag checks, so concurrent recorders can be tested. */
class MemWriter implements AnalyticsWriter {
  docs = new Map<string, { doc: AnalyticsDoc; v: number }>();
  conflicts = 0;
  async read(id: string) {
    const d = this.docs.get(id);
    return d ? { doc: structuredClone(d.doc), etag: String(d.v) } : undefined;
  }
  async write(doc: AnalyticsDoc, etag?: string) {
    await new Promise((r) => setImmediate(r));
    const cur = this.docs.get(doc.id);
    if (etag === undefined ? !!cur : !cur || String(cur.v) !== etag) { this.conflicts++; return false; }
    this.docs.set(doc.id, { doc: structuredClone(doc), v: (cur?.v ?? 0) + 1 });
    return true;
  }
}

test('tracking requests are validated and capped', () => {
  const d = parseTrackBatch({ events: [
    { v: A, e: 'view' }, { v: A, e: 'view' }, { v: A, e: 'play' },
    { v: A, e: 'watch', s: 100 }, { v: A, e: 'watch', s: 100 }, { v: A, e: 'complete' },
    { v: '33333333-3333-4333-8333-333333333333', e: 'view' },
  ] }, known)!;
  assert.deepEqual(d.get(A), { views: 1, plays: 1, watchSeconds: 120, completes: 1 });
  assert.equal(d.size, 1, 'unknown videos are ignored');
  assert.equal(parseTrackBatch({ events: [{ v: A, e: 'like' }] }, known), undefined);
  assert.equal(parseTrackBatch({ events: [{ v: 'x', e: 'view' }] }, known), undefined);
  assert.equal(parseTrackBatch({ events: [] }, known), undefined);
  assert.equal(parseTrackBatch({ events: Array(41).fill({ v: A, e: 'view' }) }, known), undefined);
  assert.equal(parseTrackBatch('nope', known), undefined);
  assert.equal(parseTrackBatch({ events: [{ v: A, e: 'watch', s: -5 }] }, known)!.size, 0);
});

test('bots and scripted clients are recognised', () => {
  assert.equal(isLikelyBot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(isLikelyBot('curl/8.4.0'), true);
  assert.equal(isLikelyBot(undefined), true);
  assert.equal(isLikelyBot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0'), false);
});

test('recorder writes daily and lifetime totals', async () => {
  const w = new MemWriter();
  const r = new AnalyticsRecorder(w);
  const now = new Date('2026-11-09T10:00:00Z');
  r.record(parseTrackBatch({ events: [{ v: A, e: 'view' }, { v: A, e: 'play' }, { v: A, e: 'watch', s: 15.04 }] }, known)!, now);
  r.record(parseTrackBatch({ events: [{ v: A, e: 'view' }, { v: B, e: 'view' }] }, known)!, now);
  await r.flush(now);
  const day = w.docs.get('day-2026-11-09')!.doc as AnalyticsDayDoc;
  assert.deepEqual(day.videos[A], { views: 2, plays: 1, watchSeconds: 15 });
  assert.deepEqual(day.videos[B], { views: 1 });
  assert.ok(day.ttl! > (ANALYTICS_RETENTION_DAYS - 1) * 86400);
  const totals = w.docs.get('totals')!.doc as AnalyticsTotalsDoc;
  assert.equal(totals.since, '2026-11-09');
  assert.equal(totals.videos[A].views, 2);
  assert.equal(r.pendingDays(), 0);
});

test('concurrent app instances never lose counts', async () => {
  const w = new MemWriter();
  const now = new Date('2026-11-09T10:00:00Z');
  const recorders = Array.from({ length: 5 }, () => new AnalyticsRecorder(w));
  for (const r of recorders) for (let i = 0; i < 3; i++) r.record(parseTrackBatch({ events: [{ v: A, e: 'view' }] }, known)!, now);
  await Promise.all(recorders.map((r) => r.flush(now)));
  assert.equal((w.docs.get('day-2026-11-09')!.doc as AnalyticsDayDoc).videos[A].views, 15);
  assert.equal((w.docs.get('totals')!.doc as AnalyticsTotalsDoc).videos[A].views, 15);
  assert.ok(w.conflicts > 0, 'the test exercised write conflicts');
});

test('failed writes are kept and retried', async () => {
  const w = new MemWriter();
  let fail = true;
  const flaky: AnalyticsWriter = { read: (id) => w.read(id), write: async (d, e) => { if (fail) throw new Error('offline'); return w.write(d, e); } };
  const r = new AnalyticsRecorder(flaky);
  const now = new Date('2026-11-09T10:00:00Z');
  r.record(parseTrackBatch({ events: [{ v: A, e: 'view' }] }, known)!, now);
  await assert.rejects(r.flush(now));
  r.record(parseTrackBatch({ events: [{ v: A, e: 'view' }] }, known)!, now);
  fail = false;
  await r.flush(now);
  assert.equal((w.docs.get('day-2026-11-09')!.doc as AnalyticsDayDoc).videos[A].views, 2);
});

test('date helpers and retention window', () => {
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.deepEqual(daysBetween('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  assert.equal(earliestDay('2026-11-09', '2026-11-01'), '2026-11-01');
  assert.equal(earliestDay('2026-11-09'), addDays('2026-11-09', -(ANALYTICS_RETENTION_DAYS - 1)));
  assert.equal(ttlFor('2020-01-01', new Date('2026-11-09T00:00:00Z')), 3600);
});

test('summaries add up days, rates and series', () => {
  const docs: AnalyticsDayDoc[] = [
    { id: 'day-2026-11-01', kind: 'day', day: '2026-11-01', updatedAt: '', videos: { [A]: { views: 4, plays: 2, watchSeconds: 60, completes: 1 } } },
    { id: 'day-2026-11-03', kind: 'day', day: '2026-11-03', updatedAt: '', videos: { [A]: { views: 1 }, [B]: { views: 2, plays: 2, watchSeconds: 30 } } },
  ];
  const s = summarise(docs, daysBetween('2026-11-01', '2026-11-03'));
  assert.equal(s.total.views, 7);
  assert.equal(s.total.plays, 4);
  assert.equal(s.series.length, 3);
  assert.equal(s.series[1].views, 0);
  const a = s.perVideo.get(A)!;
  assert.equal(a.views, 5);
  const one = summarise(docs, daysBetween('2026-11-01', '2026-11-03'), B);
  assert.equal(one.total.views, 2);
  assert.equal(one.total.avgWatchSeconds, 15);
  assert.equal(one.perVideo.size, 1);
});
