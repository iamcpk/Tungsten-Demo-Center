/**
 * Anonymous video analytics: tells the server "video X was opened / played / watched for N seconds".
 * Nothing is stored in the browser (no cookies, no local storage) and no visitor or session id is sent.
 */
type TrackEvent = 'view' | 'play' | 'q25' | 'q50' | 'q75' | 'complete' | 'watch';
interface Ev { v: string; e: TrackEvent; s?: number }

const queue: Ev[] = [];
let timer: number | undefined;
let enabled = true;

/** Branding previews and automated browsers are not counted. */
export function setTrackingEnabled(on: boolean) { enabled = on; }
const active = () => enabled && !navigator.webdriver;

function send(beacon: boolean) {
  if (timer) { window.clearTimeout(timer); timer = undefined; }
  while (queue.length) {
    const body = JSON.stringify({ events: queue.splice(0, 40) });
    try {
      if (beacon && navigator.sendBeacon?.('/api/track', new Blob([body], { type: 'application/json' }))) continue;
      void fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'omit' }).catch(() => undefined);
    } catch { /* analytics must never break the page */ }
  }
}

function track(v: string, e: TrackEvent, s?: number) {
  if (!active()) return;
  queue.push(s === undefined ? { v, e } : { v, e, s: Math.round(s * 10) / 10 });
  if (queue.length >= 30) send(false);
  else timer ??= window.setTimeout(() => send(false), 5_000);
}

// Send what is queued when the visitor leaves or switches tab.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') send(true); });
  window.addEventListener('pagehide', () => send(true));
}

export const trackView = (videoId: string) => track(videoId, 'view');

/**
 * Turns player time updates into plays, watch time and progress milestones for one page view.
 * Only time that actually plays counts: jumps (seeking) of more than 10 seconds are ignored.
 */
export class WatchTracker {
  private played = false;
  private last?: number;
  private unsent = 0;
  private reached = new Set<TrackEvent>();
  private flushTimer?: number;

  constructor(private readonly videoId: string) {}

  play() {
    if (!this.played) { this.played = true; track(this.videoId, 'play'); }
    this.flushTimer ??= window.setInterval(() => this.flush(), 15_000);
  }

  time(current: number, duration?: number) {
    if (!Number.isFinite(current)) return;
    if (this.last !== undefined) {
      const d = current - this.last;
      if (d > 0 && d <= 10) { this.unsent += d; this.play(); }
    }
    this.last = current;
    if (duration && duration > 0) {
      const p = current / duration;
      for (const [q, at] of [['q25', 0.25], ['q50', 0.5], ['q75', 0.75], ['complete', 0.95]] as const) {
        if (p >= at && !this.reached.has(q) && this.played) { this.reached.add(q); track(this.videoId, q); }
      }
    }
  }

  ended() {
    if (this.played && !this.reached.has('complete')) { this.reached.add('complete'); track(this.videoId, 'complete'); }
    this.pause();
  }

  pause() {
    this.flush();
    if (this.flushTimer) { window.clearInterval(this.flushTimer); this.flushTimer = undefined; }
  }

  flush() {
    if (this.unsent >= 0.5) track(this.videoId, 'watch', this.unsent);
    this.unsent = 0;
  }

  dispose() {
    this.pause();
    send(true);
  }
}

// ---------- Vimeo and YouTube embeds (postMessage APIs, no extra scripts) ----------
const parse = (data: unknown): Record<string, unknown> | undefined => {
  try { return (typeof data === 'string' ? JSON.parse(data) : data) as Record<string, unknown>; } catch { return undefined; }
};

/** Listens to a Vimeo player iframe. Returns a cleanup function. */
export function watchVimeo(frame: HTMLIFrameElement, t: WatchTracker): () => void {
  const post = (msg: object) => frame.contentWindow?.postMessage(JSON.stringify(msg), 'https://player.vimeo.com');
  // The embed answers with its own event names ("playProgress", "finish"); both spellings are handled.
  const subscribe = () => { for (const value of ['play', 'pause', 'ended', 'finish', 'timeupdate', 'playProgress']) post({ method: 'addEventListener', value }); };
  const onMsg = (ev: MessageEvent) => {
    if (ev.origin !== 'https://player.vimeo.com' || ev.source !== frame.contentWindow) return;
    const m = parse(ev.data);
    const data = (m?.data ?? {}) as { seconds?: number; duration?: number };
    switch (m?.event) {
      case 'ready': subscribe(); break;
      case 'play': t.play(); break;
      case 'timeupdate': case 'playProgress': if (typeof data.seconds === 'number') t.time(data.seconds, data.duration); break;
      case 'pause': t.pause(); break;
      case 'ended': case 'finish': t.ended(); break;
    }
  };
  window.addEventListener('message', onMsg);
  frame.addEventListener('load', subscribe);
  return () => { window.removeEventListener('message', onMsg); frame.removeEventListener('load', subscribe); };
}

/** Listens to a YouTube (privacy-enhanced) player iframe. Returns a cleanup function. */
export function watchYouTube(frame: HTMLIFrameElement, t: WatchTracker): () => void {
  const origin = 'https://www.youtube-nocookie.com';
  let duration: number | undefined;
  let tries = 0;
  // The player starts sending events once it hears "listening"; repeat until it answers.
  const hello = window.setInterval(() => {
    frame.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), origin);
    if (++tries > 20) window.clearInterval(hello);
  }, 500);
  const onMsg = (ev: MessageEvent) => {
    if (ev.origin !== origin || ev.source !== frame.contentWindow) return;
    const m = parse(ev.data);
    if (!m) return;
    window.clearInterval(hello);
    const state = m.event === 'onStateChange' ? m.info : (m.info as { playerState?: number } | undefined)?.playerState;
    const info = (m.event === 'infoDelivery' ? m.info : undefined) as { currentTime?: number; duration?: number } | undefined;
    if (typeof info?.duration === 'number' && info.duration > 0) duration = info.duration;
    if (state === 1) t.play();
    if (typeof info?.currentTime === 'number') t.time(info.currentTime, duration);
    if (state === 2) t.pause();
    if (state === 0) t.ended();
  };
  window.addEventListener('message', onMsg);
  return () => { window.clearInterval(hello); window.removeEventListener('message', onMsg); };
}

/** Listens to an HTML video element (uploaded videos). Returns a cleanup function. */
export function watchVideoElement(el: HTMLVideoElement, t: WatchTracker): () => void {
  const onPlay = () => t.play();
  const onTime = () => t.time(el.currentTime, el.duration);
  const onPause = () => t.pause();
  const onEnded = () => t.ended();
  el.addEventListener('playing', onPlay);
  el.addEventListener('timeupdate', onTime);
  el.addEventListener('pause', onPause);
  el.addEventListener('ended', onEnded);
  return () => {
    el.removeEventListener('playing', onPlay);
    el.removeEventListener('timeupdate', onTime);
    el.removeEventListener('pause', onPause);
    el.removeEventListener('ended', onEnded);
  };
}
