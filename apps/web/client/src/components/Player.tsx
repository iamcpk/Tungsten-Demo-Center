import { useEffect, useRef, useState } from 'react';
import { mediaUrl, thumbOf, type Video } from '../api';
import { useSiteConfig } from '../hooks';
import { WatchTracker, watchVideoElement, watchVimeo, watchYouTube } from '../analytics';

function vimeoEmbed(id: string, hash?: string) {
  const p = new URLSearchParams({ dnt: '1', title: '0', byline: '0', portrait: '0' });
  if (hash) p.set('h', hash);
  return `https://player.vimeo.com/video/${encodeURIComponent(id)}?${p}`;
}

function youTubeEmbed(id: string) {
  // enablejsapi lets the page read play progress (for anonymous analytics); origin limits who can talk to the player.
  const p = new URLSearchParams({ rel: '0', modestbranding: '1', enablejsapi: '1', origin: window.location.origin });
  return `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?${p}`;
}

interface Track { id: string; lang: string; label: string; src: string }

function HlsPlayer({ src, poster, tracker, tracks = [] }: { src: string; poster?: string; tracker: WatchTracker; tracks?: Track[] }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let destroy: (() => void) | undefined;
    const unwatch = watchVideoElement(el, tracker);
    if (el.canPlayType('application/vnd.apple.mpegurl')) {
      el.src = src; // Safari / iOS native HLS
    } else {
      import('hls.js').then(({ default: Hls }) => {
        if (!Hls.isSupported()) { setError(true); return; }
        const hls = new Hls({ capLevelToPlayerSize: true, startLevel: -1 });
        hls.on(Hls.Events.ERROR, (_e, d) => { if (d.fatal) setError(true); });
        hls.loadSource(src);
        hls.attachMedia(el);
        destroy = () => hls.destroy();
      });
    }
    return () => { unwatch(); destroy?.(); };
  }, [src, tracker]);
  if (error) return <div className="player-msg">This video could not be played in your browser.</div>;
  // Captions are off until the viewer picks them from the player's CC menu.
  return (
    <video ref={ref} controls playsInline preload="metadata" poster={poster}>
      {tracks.map((t) => <track key={t.id} kind="subtitles" srcLang={t.lang} label={t.label} src={t.src} />)}
    </video>
  );
}

export function Player({ v }: { v: Video }) {
  const cfg = useSiteConfig();
  const s = v.source;
  const frame = useRef<HTMLIFrameElement>(null);
  const [tracker] = useState(() => new WatchTracker(v.id));
  useEffect(() => () => tracker.dispose(), [tracker]);
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    return s.provider === 'vimeo' ? watchVimeo(el, tracker) : s.provider === 'youtube' ? watchYouTube(el, tracker) : undefined;
  }, [s.provider, s.externalId, tracker]);

  let inner: JSX.Element | null = null;
  if (s.provider === 'vimeo' && s.externalId) {
    inner = <iframe ref={frame} src={vimeoEmbed(s.externalId, s.privacyHash)} title={v.title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />;
  } else if (s.provider === 'youtube' && s.externalId) {
    inner = <iframe ref={frame} src={youTubeEmbed(s.externalId)} title={v.title} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen />;
  } else if (s.provider === 'azure' && cfg) {
    inner = s.hlsPath && s.encodeState === 'ready'
      ? <HlsPlayer src={mediaUrl(cfg.mediaBaseUrl, s.hlsPath)} poster={thumbOf(v, cfg.mediaBaseUrl)} tracker={tracker}
          tracks={(v.captions ?? []).map((c) => ({ ...c, src: `/api/videos/${encodeURIComponent(v.slug)}/captions/${encodeURIComponent(c.id)}` }))} />
      : <div className="player-msg">This video is being processed. Please check back shortly.</div>;
  }
  return <div className="player">{inner}</div>;
}
