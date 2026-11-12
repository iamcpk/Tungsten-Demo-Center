import { useEffect, useRef, useState } from 'react';

/** True when a canvas is (almost) entirely black, checked on a small copy. */
function isBlack(src: HTMLCanvasElement): boolean {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 36;
  const x = c.getContext('2d', { willReadFrequently: true })!;
  x.drawImage(src, 0, 0, 64, 36);
  const d = x.getImageData(0, 0, 64, 36).data;
  let max = 0;
  for (let i = 0; i < d.length; i += 4) max = Math.max(max, d[i], d[i + 1], d[i + 2]);
  return max < 12;
}

/** Waits until the paused video has a decoded frame on screen at its current position. */
async function settle(el: HTMLVideoElement): Promise<void> {
  el.pause();
  if (el.seeking) await new Promise((r) => el.addEventListener('seeked', r, { once: true }));
  const v = el as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number };
  if (v.requestVideoFrameCallback) {
    // Re-seeking to the same time makes the browser present that frame again, which fires the callback.
    await Promise.race([
      new Promise<void>((r) => { v.requestVideoFrameCallback!(() => r()); el.currentTime = el.currentTime; }),
      new Promise<void>((r) => setTimeout(r, 1000)),
    ]);
    if (el.seeking) await new Promise((r) => el.addEventListener('seeked', r, { once: true }));
  }
}

/**
 * Copies the current frame at full resolution. Browsers differ in which copy method works with
 * hardware-decoded video, so each is tried in turn and the first non-black picture wins.
 */
async function captureFrame(el: HTMLVideoElement): Promise<HTMLCanvasElement> {
  await settle(el);
  const w = el.videoWidth, h = el.videoHeight;
  const draw = (source: CanvasImageSource) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d')!.drawImage(source, 0, 0, w, h);
    return c;
  };
  const attempts: (() => Promise<HTMLCanvasElement>)[] = [
    async () => draw(el),
    async () => { const b = await createImageBitmap(el); try { return draw(b); } finally { b.close(); } },
  ];
  const VF = (window as unknown as { VideoFrame?: new (s: HTMLVideoElement) => CanvasImageSource & { close(): void } }).VideoFrame;
  if (VF) attempts.push(async () => { const f = new VF(el); try { return draw(f); } finally { f.close(); } });
  let last: HTMLCanvasElement | undefined;
  for (let round = 0; round < 2; round++) {
    for (const a of attempts) {
      try {
        last = await a();
        if (!isBlack(last)) return last;
      } catch { /* try the next method */ }
    }
    await new Promise((r) => setTimeout(r, 300)); // give the decoder a moment, then try once more
  }
  if (!last) throw new Error('The frame could not be captured.');
  return last;
}

/**
 * Lets the editor pause an uploaded (encoded) video on any frame and use it as the thumbnail.
 * The stream comes from the portal's own /api so the frame can be copied from a canvas.
 */
export function FramePicker({ videoId, duration, onUse, onClose }: {
  videoId: string;
  duration?: number;
  onUse: (file: File) => Promise<boolean>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [time, setTime] = useState(0);
  const [len, setLen] = useState(duration ?? 0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const src = `/api/videos/${encodeURIComponent(videoId)}/stream/master.m3u8`;
    let destroy: (() => void) | undefined;
    const onMeta = () => { setReady(true); if (Number.isFinite(el.duration)) setLen(el.duration); };
    const onTime = () => setTime(el.currentTime);
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('seeked', onTime);
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = src; // Safari plays HLS natively
    } else {
      import('hls.js').then(({ default: Hls }) => {
        if (!Hls.isSupported()) { setError('This browser cannot play the video. Try Microsoft Edge or Google Chrome.'); return; }
        // Always the sharpest version: the thumbnail is taken at the video's full resolution.
        const hls = new Hls({ capLevelToPlayerSize: false, startLevel: -1, abrEwmaDefaultEstimate: 50_000_000 });
        hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => { hls.currentLevel = d.levels.length - 1; });
        hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) setError('The video could not be loaded. Try again in a minute.'); });
        hls.loadSource(src);
        hls.attachMedia(el);
        destroy = () => hls.destroy();
      }).catch(() => setError('The video player could not be loaded.'));
    }
    return () => {
      el.removeEventListener('loadedmetadata', onMeta);
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('seeked', onTime);
      destroy?.();
    };
  }, [videoId]);

  const seek = (t: number) => {
    const el = ref.current;
    if (!el) return;
    el.pause();
    el.currentTime = Math.max(0, Math.min(len || el.duration || 0, t));
  };
  const step = (sec: number) => seek((ref.current?.currentTime ?? 0) + sec);

  const [blackFrame, setBlackFrame] = useState<Blob>();

  const use = async () => {
    const el = ref.current;
    if (!el || !el.videoWidth) return;
    setSaving(true);
    setError('');
    setBlackFrame(undefined);
    try {
      const canvas = await captureFrame(el);
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      if (!blob) throw new Error('The frame could not be captured.');
      if (isBlack(canvas)) {
        // Some browsers hand back an empty picture for hardware-decoded video. Don't save it silently.
        setBlackFrame(blob);
        return;
      }
      await save(blob);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const save = async (blob: Blob) => {
    const t = Math.round((ref.current?.currentTime ?? 0) * 1000);
    if (await onUse(new File([blob], `frame-${t}.jpg`, { type: 'image/jpeg' }))) onClose();
  };

  const fmt = (s: number) => {
    const t = Math.max(0, s);
    return `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
  };

  return (
    <div className="frame-picker">
      <video ref={ref} controls playsInline preload="auto" muted />
      <div className="frame-controls">
        <input
          type="range" min={0} max={len || 0} step={0.04} value={Math.min(time, len || 0)}
          onChange={(e) => seek(Number(e.target.value))} disabled={!ready} aria-label="Position in the video"
        />
        <span className="frame-time">{fmt(time)} / {fmt(len)}</span>
      </div>
      <div className="frame-buttons">
        <button type="button" className="btn btn-sm" onClick={() => step(-1)} disabled={!ready} aria-label="Back 1 second">-1s</button>
        <button type="button" className="btn btn-sm" onClick={() => step(-1 / 30)} disabled={!ready} aria-label="Back 1 frame">‹ Frame</button>
        <button type="button" className="btn btn-sm" onClick={() => step(1 / 30)} disabled={!ready} aria-label="Forward 1 frame">Frame ›</button>
        <button type="button" className="btn btn-sm" onClick={() => step(1)} disabled={!ready} aria-label="Forward 1 second">+1s</button>
        <span className="frame-spacer" />
        <button type="button" className="btn" onClick={onClose} disabled={saving}>Cancel</button>
        <button type="button" className="btn btn-primary" onClick={use} disabled={!ready || saving}>{saving ? 'Saving...' : 'Use this frame'}</button>
      </div>
      {error && <p className="alert">{error}</p>}
      {blackFrame && (
        <div className="alert">
          <p><strong>The captured frame is completely black.</strong> If the player shows a picture at this point, your browser could not copy it. This can happen with hardware video acceleration or Microsoft Edge's video enhancement. Try another moment, another browser, or upload an image instead.</p>
          <p>
            <button type="button" className="btn btn-sm" onClick={() => setBlackFrame(undefined)}>Pick another frame</button>{' '}
            <button type="button" className="btn btn-sm" onClick={() => { const b = blackFrame; setBlackFrame(undefined); setSaving(true); void save(b).finally(() => setSaving(false)); }}>The frame really is black: use it</button>
          </p>
        </div>
      )}
      <p className="hint">Play or drag the slider to the moment you want, fine-tune with the frame buttons, then press Use this frame. The picture is saved at the video's full resolution.</p>
    </div>
  );
}
