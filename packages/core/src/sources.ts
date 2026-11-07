import type { VideoSource } from './types.js';

const VIMEO_HOSTS = new Set(['vimeo.com', 'www.vimeo.com', 'player.vimeo.com']);
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'youtube-nocookie.com']);

/**
 * Parse a Vimeo or YouTube URL into a VideoSource.
 * Handles the URL shapes found in the iVengi export:
 *   https://vimeo.com/223143246
 *   https://vimeo.com/223143246/abcdef1234          (unlisted)
 *   https://player.vimeo.com/video/865632232?h=abc   (embed)
 *   https://vimeo.com/user/review/277491088/c5f0434417
 *   https://vimeo.com/manage/717577854/advanced
 * Returns undefined when the URL is not a supported host.
 */
export function parseExternalVideoUrl(raw: string): VideoSource | undefined {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
  const host = url.hostname.toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);

  if (VIMEO_HOSTS.has(host)) {
    let id: string | undefined;
    let hash: string | undefined = url.searchParams.get('h') ?? undefined;
    if (host === 'player.vimeo.com') {
      const i = parts.indexOf('video');
      id = i >= 0 ? parts[i + 1] : undefined;
    } else {
      const idx = parts.findIndex((p) => /^\d{5,}$/.test(p));
      if (idx >= 0) {
        id = parts[idx];
        const next = parts[idx + 1];
        if (!hash && next && /^[0-9a-f]{6,}$/i.test(next)) hash = next;
      }
    }
    if (!id || !/^\d+$/.test(id)) return undefined;
    return { provider: 'vimeo', url: `https://vimeo.com/${id}${hash ? `/${hash}` : ''}`, externalId: id, privacyHash: hash };
  }

  if (YOUTUBE_HOSTS.has(host)) {
    let id: string | undefined;
    if (host === 'youtu.be') id = parts[0];
    else if (parts[0] === 'watch') id = url.searchParams.get('v') ?? undefined;
    else if (['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1];
    else id = url.searchParams.get('v') ?? undefined;
    if (!id || !/^[A-Za-z0-9_-]{6,20}$/.test(id)) return undefined;
    return { provider: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, externalId: id };
  }
  return undefined;
}

/** Privacy-friendly embed URL for an external source. */
export function embedUrl(source: VideoSource): string | undefined {
  if (source.provider === 'vimeo' && source.externalId) {
    const params = new URLSearchParams({ dnt: '1', title: '0', byline: '0', portrait: '0' });
    if (source.privacyHash) params.set('h', source.privacyHash);
    return `https://player.vimeo.com/video/${source.externalId}?${params}`;
  }
  if (source.provider === 'youtube' && source.externalId) {
    return `https://www.youtube-nocookie.com/embed/${source.externalId}?rel=0&modestbranding=1`;
  }
  return undefined;
}

export interface OEmbedInfo {
  title?: string;
  thumbnailUrl?: string;
  durationSec?: number;
  authorName?: string;
}

/**
 * Fetch oEmbed metadata. Only ever calls the two fixed provider endpoints, never a
 * user-supplied host, so it cannot be used for SSRF.
 */
export async function fetchOEmbed(source: VideoSource, timeoutMs = 8000): Promise<OEmbedInfo | undefined> {
  if (!source.url) return undefined;
  const endpoint =
    source.provider === 'vimeo'
      ? `https://vimeo.com/api/oembed.json?width=1280&url=${encodeURIComponent(source.url)}`
      : source.provider === 'youtube'
        ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(source.url)}`
        : undefined;
  if (!endpoint) return undefined;
  const res = await fetch(endpoint, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!res.ok) return undefined;
  const j = (await res.json()) as Record<string, unknown>;
  return {
    title: typeof j.title === 'string' ? j.title : undefined,
    thumbnailUrl: typeof j.thumbnail_url === 'string' ? j.thumbnail_url : undefined,
    durationSec: typeof j.duration === 'number' ? j.duration : undefined,
    authorName: typeof j.author_name === 'string' ? j.author_name : undefined,
  };
}
