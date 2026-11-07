import { useEffect, useRef, useState } from 'react';
import { mediaUrl, thumbOf, type Video } from '../api';
import { useSiteConfig } from '../hooks';

function vimeoEmbed(id: string, hash?: string) {
  const p = new URLSearchParams({ dnt: '1', title: '0', byline: '0', portrait: '0' });
  if (hash) p.set('h', hash);
  return `https://player.vimeo.com/video/${encodeURIComponent(id)}?${p}`;
}

function HlsPlayer({ src, poster }: { src: string; poster?: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let destroy: (() => void) | undefined;
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
    return () => destroy?.();
  }, [src]);
  if (error) return <div className="player-msg">This video could not be played in your browser.</div>;
  return <video ref={ref} controls playsInline preload="metadata" poster={poster} />;
}

export function Player({ v }: { v: Video }) {
  const cfg = useSiteConfig();
  const s = v.source;
  let inner: JSX.Element | null = null;
  if (s.provider === 'vimeo' && s.externalId) {
    inner = <iframe src={vimeoEmbed(s.externalId, s.privacyHash)} title={v.title} allow="autoplay; fullscreen; picture-in-picture" allowFullScreen />;
  } else if (s.provider === 'youtube' && s.externalId) {
    inner = <iframe src={`https://www.youtube-nocookie.com/embed/${encodeURIComponent(s.externalId)}?rel=0&modestbranding=1`} title={v.title} allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowFullScreen />;
  } else if (s.provider === 'azure' && cfg) {
    inner = s.hlsPath && s.encodeState === 'ready'
      ? <HlsPlayer src={mediaUrl(cfg.mediaBaseUrl, s.hlsPath)} poster={thumbOf(v, cfg.mediaBaseUrl)} />
      : <div className="player-msg">This video is being processed. Please check back shortly.</div>;
  }
  return <div className="player">{inner}</div>;
}
