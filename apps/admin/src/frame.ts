import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Server-side "choose a frame": cuts one frame out of an uploaded video's HLS stream with ffmpeg.
 * Browsers can't always copy a frame from hardware-decoded video (the picture comes back black),
 * so the portal does it here instead, from the sharpest rendition.
 */

/** The first variant in the master playlist is the highest rendition (the encoder writes them largest first). */
export function pickVariant(master: string): string | undefined {
  const lines = master.split(/\r?\n/).map((l) => l.trim());
  let best: { uri: string; height: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri) continue;
    const height = Number(/RESOLUTION=\d+x(\d+)/.exec(lines[i])?.[1] ?? 0);
    if (!best || height > best.height) best = { uri, height };
  }
  return best?.uri;
}

/** Finds the segment that holds `time` seconds and the offset into it. */
export function findSegment(playlist: string, time: number): { uri: string; offset: number } | undefined {
  const lines = playlist.split(/\r?\n/).map((l) => l.trim());
  let start = 0;
  let last: { uri: string; offset: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const m = /^#EXTINF:([\d.]+)/.exec(lines[i]);
    if (!m) continue;
    const dur = Number(m[1]);
    const uri = lines.slice(i + 1).find((l) => l && !l.startsWith('#'));
    if (!uri || !Number.isFinite(dur)) continue;
    if (time < start + dur) return { uri, offset: Math.max(0, time - start) };
    last = { uri, offset: Math.max(0, dur - 0.05) };
    start += dur;
  }
  return last; // past the end: the last frame
}

/** Relative playlist entries we accept: plain names inside the same folder tree, no "..". */
export const SAFE_REL = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(m3u8|ts)$/;

export function joinRel(base: string, rel: string): string {
  const dir = base.includes('/') ? base.slice(0, base.lastIndexOf('/') + 1) : '';
  return `${dir}${rel}`;
}

/** Runs ffmpeg on one segment and returns a JPEG of the frame at `offset` seconds. */
export async function extractFrame(segment: Buffer, offset: number, timeoutMs = 30_000): Promise<Buffer> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frame-'));
  try {
    const input = path.join(dir, 'in.ts');
    const output = path.join(dir, 'out.jpg');
    await fs.writeFile(input, segment);
    // -ss after -i decodes up to the exact time (accurate, and the segment is only a few seconds long).
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-ss', offset.toFixed(3), '-frames:v', '1', '-q:v', '2', output];
    await new Promise<void>((resolve, reject) => {
      execFile('ffmpeg', args, { timeout: timeoutMs, windowsHide: true }, (err, _out, stderr) => {
        if (!err) return resolve();
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new Error('ffmpeg is not installed on the server'));
        reject(new Error(`ffmpeg failed: ${String(stderr).slice(0, 300)}`));
      });
    });
    return await fs.readFile(output);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
