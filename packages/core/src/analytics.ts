/**
 * Anonymous video analytics.
 *
 * Privacy by design: the public site sends only "video X was opened / played / watched for N seconds"
 * events. Nothing identifies a visitor: no cookies, no local storage, no visitor or session ids, and
 * no IP address, user agent or location is stored. Events are added to per-day totals in memory and
 * written about once a minute, so the database only ever holds aggregate counts per video per day.
 *
 * Retention: daily totals are kept for 25 months (enough to compare any month with the same month a
 * year earlier) and then expire automatically (Cosmos DB TTL). Lifetime totals per video are kept.
 */

export const TRACK_EVENTS = ['view', 'play', 'q25', 'q50', 'q75', 'complete', 'watch'] as const;
export type TrackEvent = (typeof TRACK_EVENTS)[number];

export interface Counters {
  /** Video page opened. */
  views: number;
  /** Playback started (at most once per page view). */
  plays: number;
  /** Seconds actually played (seeking ahead does not count). */
  watchSeconds: number;
  /** Plays that reached 25%, 50% and 75% of the video. */
  q25: number;
  q50: number;
  q75: number;
  /** Plays that reached 95% of the video or the end. */
  completes: number;
}
export const COUNTER_KEYS: (keyof Counters)[] = ['views', 'plays', 'watchSeconds', 'q25', 'q50', 'q75', 'completes'];
const EVENT_FIELD: Record<Exclude<TrackEvent, 'watch'>, keyof Counters> = {
  view: 'views', play: 'plays', q25: 'q25', q50: 'q50', q75: 'q75', complete: 'completes',
};

/** 25 months of daily detail. */
export const ANALYTICS_RETENTION_DAYS = 762;
/** The most watch time one tracking request may add for one video. The player reports every 15 s. */
export const MAX_WATCH_PER_REQUEST = 120;
export const MAX_EVENTS_PER_REQUEST = 40;

export interface AnalyticsDayDoc {
  id: string;
  kind: 'day';
  /** UTC date, YYYY-MM-DD. */
  day: string;
  videos: Record<string, Partial<Counters>>;
  updatedAt: string;
  /** Seconds until Cosmos DB deletes the document (counted from the last write). */
  ttl?: number;
}
export interface AnalyticsTotalsDoc {
  id: 'totals';
  kind: 'totals';
  /** First day anything was recorded. */
  since: string;
  videos: Record<string, Partial<Counters>>;
  updatedAt: string;
}
export type AnalyticsDoc = AnalyticsDayDoc | AnalyticsTotalsDoc;

export type Delta = Map<string, Partial<Counters>>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const VIDEO_ID = /^[0-9a-f-]{36}$/i;

export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const dayDocId = (day: string) => `day-${day}`;
export const isDay = (s: unknown): s is string => typeof s === 'string' && DAY.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

export function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return dayKey(d);
}

/** Every day from `from` to `to`, inclusive. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length <= ANALYTICS_RETENTION_DAYS + 31; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The oldest day still held in daily detail. */
export function earliestDay(today: string, since?: string): string {
  const floor = addDays(today, -(ANALYTICS_RETENTION_DAYS - 1));
  return since && since > floor ? since : floor;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function addCounters(target: Partial<Counters>, add: Partial<Counters>): Partial<Counters> {
  for (const k of COUNTER_KEYS) {
    const v = add[k];
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) target[k] = k === 'watchSeconds' ? round1((target[k] ?? 0) + v) : (target[k] ?? 0) + v;
  }
  return target;
}

export function mergeDelta(into: Delta, add: Delta): Delta {
  for (const [id, c] of add) into.set(id, addCounters(into.get(id) ?? {}, c));
  return into;
}

/** Crawlers, link checkers, uptime monitors and scripted clients. Checked per request and never stored. */
export function isLikelyBot(userAgent: string | undefined): boolean {
  if (!userAgent || userAgent.length < 20) return true;
  return /bot\b|bot\/|crawl|spider|slurp|headless|lighthouse|pagespeed|preview|scanner|monitor|pingdom|uptime|python|curl|wget|httpclient|okhttp|java\/|go-http|axios|node-fetch|undici|postman|phantom|selenium|playwright|puppeteer/i.test(userAgent);
}

/**
 * Validates a tracking request from the public site: { events: [{ v: videoId, e: event, s?: seconds }] }.
 * Each one-off event counts at most once per video per request, and watch time is capped, so a single
 * request can't inflate the numbers. Returns undefined when the request is not valid.
 */
export function parseTrackBatch(body: unknown, isKnownVideo: (id: string) => boolean): Delta | undefined {
  const events = (body as { events?: unknown })?.events;
  if (!Array.isArray(events) || events.length === 0 || events.length > MAX_EVENTS_PER_REQUEST) return undefined;
  const out: Delta = new Map();
  const seen = new Set<string>();
  for (const raw of events) {
    const ev = raw as { v?: unknown; e?: unknown; s?: unknown };
    if (typeof ev?.v !== 'string' || !VIDEO_ID.test(ev.v) || !(TRACK_EVENTS as readonly string[]).includes(ev.e as string)) return undefined;
    const id = ev.v.toLowerCase();
    if (!isKnownVideo(id)) continue;
    const c = out.get(id) ?? {};
    if (ev.e === 'watch') {
      const s = typeof ev.s === 'number' && Number.isFinite(ev.s) ? ev.s : 0;
      if (s <= 0) continue;
      c.watchSeconds = Math.min(MAX_WATCH_PER_REQUEST, round1((c.watchSeconds ?? 0) + Math.min(s, MAX_WATCH_PER_REQUEST)));
    } else {
      const key = `${id}:${ev.e}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const f = EVENT_FIELD[ev.e as Exclude<TrackEvent, 'watch'>];
      c[f] = 1;
    }
    out.set(id, c);
  }
  return out;
}

// ---------- storage ----------
/** Optimistic-concurrency document access, so several app instances can add to the same day safely. */
export interface AnalyticsWriter {
  read(id: string): Promise<{ doc: AnalyticsDoc; etag?: string } | undefined>;
  /** Creates (no etag) or replaces (etag must match). Returns false when another writer got there first. */
  write(doc: AnalyticsDoc, etag?: string): Promise<boolean>;
}

/** Seconds a day document should still live, counted from now. */
export function ttlFor(day: string, now: Date): number {
  const expires = Date.parse(`${addDays(day, ANALYTICS_RETENTION_DAYS)}T00:00:00Z`);
  return Math.max(3600, Math.round((expires - now.getTime()) / 1000));
}

async function update<T extends AnalyticsDoc>(w: AnalyticsWriter, id: string, create: () => T, change: (doc: T) => void): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const cur = await w.read(id);
    const doc = cur ? (cur.doc as T) : create();
    doc.videos ??= {};
    change(doc);
    if (await w.write(doc, cur?.etag)) return;
    await new Promise((r) => setTimeout(r, 25 + Math.random() * 100 * (attempt + 1)));
  }
  throw new Error(`analytics: could not update ${id} (too many concurrent writers)`);
}

/** Collects events in memory and adds them to the stored daily and lifetime totals in one write per day. */
export class AnalyticsRecorder {
  private pending = new Map<string, Delta>();
  private flushing?: Promise<void>;

  constructor(private readonly w: AnalyticsWriter, private readonly maxVideosPerDay = 20_000) {}

  record(delta: Delta, now = new Date()): void {
    if (!delta.size) return;
    const day = dayKey(now);
    const cur = this.pending.get(day) ?? new Map();
    if (cur.size >= this.maxVideosPerDay) return;
    this.pending.set(day, mergeDelta(cur, delta));
  }

  pendingDays(): number { return this.pending.size; }

  flush(now = new Date()): Promise<void> {
    if (this.flushing) return this.flushing;
    if (!this.pending.size) return Promise.resolve();
    const batch = this.pending;
    this.pending = new Map();
    this.flushing = this.write(batch, now)
      .catch((e) => {
        // Put the counts back so the next flush retries them.
        for (const [day, d] of batch) this.pending.set(day, mergeDelta(this.pending.get(day) ?? new Map(), d));
        throw e;
      })
      .finally(() => { this.flushing = undefined; });
    return this.flushing;
  }

  private async write(batch: Map<string, Delta>, now: Date): Promise<void> {
    const at = now.toISOString();
    const all: Delta = new Map();
    const done: string[] = [];
    try {
      for (const [day, delta] of [...batch].sort(([a], [b]) => a.localeCompare(b))) {
        await update<AnalyticsDayDoc>(this.w, dayDocId(day), () => ({ id: dayDocId(day), kind: 'day', day, videos: {}, updatedAt: at }), (doc) => {
          for (const [id, c] of delta) doc.videos[id] = addCounters(doc.videos[id] ?? {}, c);
          doc.updatedAt = at;
          doc.ttl = ttlFor(day, now);
        });
        done.push(day);
        mergeDelta(all, delta);
      }
    } finally {
      // Days already written must not be retried; lifetime totals get whatever was written.
      for (const d of done) batch.delete(d);
      if (all.size) {
        const first = done[0];
        await update<AnalyticsTotalsDoc>(this.w, 'totals', () => ({ id: 'totals', kind: 'totals', since: first, videos: {}, updatedAt: at }), (doc) => {
          for (const [id, c] of all) doc.videos[id] = addCounters(doc.videos[id] ?? {}, c);
          if (!doc.since || first < doc.since) doc.since = first;
          doc.updatedAt = at;
        });
      }
    }
  }
}

// ---------- reporting ----------
export interface VideoStats extends Counters {
  /** Average seconds watched per play. */
  avgWatchSeconds: number;
  /** Share of plays that reached the end (0-1). */
  completionRate: number;
  /** Share of page views that led to a play (0-1). */
  playRate: number;
}

export const emptyCounters = (): Counters => ({ views: 0, plays: 0, watchSeconds: 0, q25: 0, q50: 0, q75: 0, completes: 0 });

export function withRates(c: Partial<Counters>): VideoStats {
  const n = { ...emptyCounters(), ...c };
  n.watchSeconds = round1(n.watchSeconds);
  return {
    ...n,
    avgWatchSeconds: n.plays ? round1(n.watchSeconds / n.plays) : 0,
    completionRate: n.plays ? Math.min(1, n.completes / n.plays) : 0,
    playRate: n.views ? Math.min(1, n.plays / n.views) : 0,
  };
}

/** Adds up day documents: per-video totals, site totals and a per-day series. */
export function summarise(docs: (AnalyticsDayDoc | undefined)[], days: string[], videoId?: string) {
  const byDay = new Map(docs.filter((d): d is AnalyticsDayDoc => !!d).map((d) => [d.day, d]));
  const perVideo = new Map<string, Partial<Counters>>();
  const total: Partial<Counters> = {};
  const series = days.map((day) => {
    const point: Partial<Counters> = {};
    const doc = byDay.get(day);
    for (const [id, c] of Object.entries(doc?.videos ?? {})) {
      if (videoId && id !== videoId) continue;
      perVideo.set(id, addCounters(perVideo.get(id) ?? {}, c));
      addCounters(point, c);
    }
    addCounters(total, point);
    const p = withRates(point);
    return { day, views: p.views, plays: p.plays, watchSeconds: p.watchSeconds, completes: p.completes };
  });
  return { perVideo, total: withRates(total), series };
}
