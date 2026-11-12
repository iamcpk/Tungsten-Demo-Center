import { useEffect, useRef, useState } from 'react';

/**
 * Lets the editor pause an uploaded (encoded) video on any frame and use it as the thumbnail.
 * The server cuts the chosen frame from the sharpest rendition (browsers can't always copy frames
 * from hardware-decoded video), so the picture doesn't depend on the editor's browser.
 */
export function FramePicker({ videoId, duration, onUse, onClose }: {
  videoId: string;
  duration?: number;
  /** Saves the frame at this time (seconds) as the thumbnail. Resolves true when it worked. */
  onUse: (time: number) => Promise<boolean>;
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

  const use = async () => {
    const el = ref.current;
    if (!el) return;
    el.pause();
    setSaving(true);
    setError('');
    try {
      if (await onUse(el.currentTime)) onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
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
        <button type="button" className="btn btn-primary" onClick={use} disabled={!ready || saving}>{saving ? 'Taking frame...' : 'Use this frame'}</button>
      </div>
      {error && <p className="alert">{error}</p>}
      <p className="hint">Play or drag the slider to the moment you want, fine-tune with the frame buttons, then press Use this frame. The frame is taken on the server from the full-resolution video, so it can take a few seconds.</p>
    </div>
  );
}
