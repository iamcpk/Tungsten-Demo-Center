export interface Rendition {
  name: string;
  height: number;
  videoKbps: number;
  audioKbps: number;
}

const LADDER: Rendition[] = [
  { name: '1080p', height: 1080, videoKbps: 5000, audioKbps: 128 },
  { name: '720p', height: 720, videoKbps: 2800, audioKbps: 128 },
  { name: '480p', height: 480, videoKbps: 1200, audioKbps: 96 },
];

/**
 * Pick renditions that don't upscale the source. Screen recordings are often odd sizes,
 * so a source below 480p still gets one rendition at its own (even) height.
 */
export function pickLadder(sourceHeight: number): Rendition[] {
  const fit = LADDER.filter((r) => r.height <= sourceHeight + 8);
  if (fit.length) return fit;
  const h = Math.max(144, sourceHeight - (sourceHeight % 2));
  return [{ name: `${h}p`, height: h, videoKbps: 800, audioKbps: 96 }];
}

export function evenWidth(srcW: number, srcH: number, h: number): number {
  const w = Math.round((srcW / srcH) * h);
  return w - (w % 2);
}

export function masterPlaylist(items: { r: Rendition; width: number; hasAudio: boolean }[]): string {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-INDEPENDENT-SEGMENTS'];
  for (const { r, width, hasAudio } of items) {
    const bw = Math.round((r.videoKbps * 1.1 + (hasAudio ? r.audioKbps : 0)) * 1000);
    const codecs = hasAudio ? 'avc1.4d401f,mp4a.40.2' : 'avc1.4d401f';
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw},RESOLUTION=${width}x${r.height},CODECS="${codecs}"`, `${r.name}/index.m3u8`);
  }
  return lines.join('\n') + '\n';
}
