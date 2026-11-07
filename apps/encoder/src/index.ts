/**
 * Encoder job. Runs as an event-triggered Azure Container Apps Job: KEDA starts one
 * execution per message on the "encode-jobs" queue. Each run handles one message:
 *   1. stream the source from the private "uploads" container (read-only SAS, no download)
 *   2. ffmpeg -> HLS renditions (one at a time, uploaded and removed to limit disk use)
 *   3. write master.m3u8 (+ a poster image when the video has none)
 *   4. mark the video ready in Cosmos DB
 * Azure Media Services was retired in June 2024; this replaces its encoding role.
 */
import { BlobServiceClient } from '@azure/storage-blob';
import { QueueClient, type DequeuedMessageItem } from '@azure/storage-queue';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BLOB_CONTAINERS, ENCODE_QUEUE, createMedia, createStores, getCredential, loadConfig, type EncodeJobMessage } from '@tdc/core';
import { evenWidth, masterPlaylist, pickLadder } from './ladder.js';

const MAX_ATTEMPTS = 3;
const VISIBILITY_SEC = 15 * 60;

const config = loadConfig();
if (!config.storageAccount) throw new Error('STORAGE_ACCOUNT is required');
const cred = getCredential(config);
const stores = createStores(config);
const media = createMedia(config);
const blobs = new BlobServiceClient(`https://${config.storageAccount}.blob.core.windows.net`, cred).getContainerClient(BLOB_CONTAINERS.media);
const queue = new QueueClient(`https://${config.storageAccount}.queue.core.windows.net/${ENCODE_QUEUE}`, cred);

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-800)}`))));
  });
}

interface Probe { width: number; height: number; duration: number; hasAudio: boolean }
async function probe(url: string): Promise<Probe> {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', url])) as {
    streams: { codec_type: string; width?: number; height?: number; tags?: { rotate?: string }; side_data_list?: { rotation?: number }[] }[];
    format: { duration?: string };
  };
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v?.width || !v.height) throw new Error('No video stream found in the uploaded file');
  const rot = Math.abs(Number(v.tags?.rotate ?? v.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? 0));
  const [w, h] = rot === 90 || rot === 270 ? [v.height, v.width] : [v.width, v.height];
  return { width: w, height: h, duration: Number(j.format.duration ?? 0), hasAudio: j.streams.some((s) => s.codec_type === 'audio') };
}

const CONTENT_TYPES: Record<string, string> = { '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.jpg': 'image/jpeg' };

async function uploadDir(dir: string, prefix: string) {
  for (const f of await fs.readdir(dir)) {
    const ext = path.extname(f);
    await blobs.getBlockBlobClient(`${prefix}/${f}`).uploadFile(path.join(dir, f), {
      blobHTTPHeaders: { blobContentType: CONTENT_TYPES[ext] ?? 'application/octet-stream', blobCacheControl: 'public, max-age=31536000, immutable' },
      concurrency: 4,
    });
  }
}

async function encode(job: EncodeJobMessage, keepAlive: () => Promise<void>) {
  const video = await stores.videos.get(job.videoId);
  if (!video) { console.warn(`video ${job.videoId} no longer exists, skipping`); return; }
  if (video.source.uploadBlob !== job.uploadBlob) { console.warn('stale job: a newer upload replaced this file, skipping'); return; }

  await stores.videos.upsert({ ...video, source: { ...video.source, encodeState: 'encoding', encodeError: undefined } });
  const src = await media.createReadUrl(BLOB_CONTAINERS.uploads, job.uploadBlob, 12 * 60);
  const info = await probe(src);
  const ladder = pickLadder(info.height);
  const runId = Date.now().toString(36);
  const prefix = `hls/${video.id}/${runId}`;
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'enc-'));
  console.info(`encoding ${video.id}: ${info.width}x${info.height}, ${Math.round(info.duration)}s, renditions ${ladder.map((r) => r.name).join('/')}`);

  try {
    const variants = [];
    for (const r of ladder) {
      const out = path.join(work, r.name);
      await fs.mkdir(out);
      const gop = 48; // 2s at 24fps; segments align across renditions
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y', '-i', src,
        '-map', '0:v:0', ...(info.hasAudio ? ['-map', '0:a:0'] : []),
        '-vf', `scale=-2:${r.height}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        '-b:v', `${r.videoKbps}k`, '-maxrate', `${Math.round(r.videoKbps * 1.2)}k`, '-bufsize', `${r.videoKbps * 2}k`,
        '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0',
        ...(info.hasAudio ? ['-c:a', 'aac', '-b:a', `${r.audioKbps}k`, '-ac', '2', '-ar', '48000'] : []),
        '-f', 'hls', '-hls_time', '6', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
        '-hls_segment_filename', path.join(out, 'seg_%05d.ts'), path.join(out, 'index.m3u8'),
      ];
      const ping = setInterval(() => keepAlive().catch((e) => console.error('keepalive failed', e)), 5 * 60_000);
      try { await run('ffmpeg', args); } finally { clearInterval(ping); }
      await uploadDir(out, `${prefix}/${r.name}`);
      await fs.rm(out, { recursive: true, force: true });
      variants.push({ r, width: evenWidth(info.width, info.height, r.height), hasAudio: info.hasAudio });
      console.info(`  ${r.name} done`);
    }
    await blobs.getBlockBlobClient(`${prefix}/master.m3u8`).uploadData(Buffer.from(masterPlaylist(variants)), {
      blobHTTPHeaders: { blobContentType: CONTENT_TYPES['.m3u8'], blobCacheControl: 'public, max-age=31536000, immutable' },
    });

    let thumbnailPath = video.thumbnailPath;
    if (!thumbnailPath) {
      const jpg = path.join(work, 'poster.jpg');
      const at = Math.min(Math.max(1, info.duration * 0.1), 30).toFixed(1);
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', at, '-i', src, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '3', jpg]);
      thumbnailPath = await media.putMedia(`thumbs/${video.id}/${runId}.jpg`, await fs.readFile(jpg), 'image/jpeg');
    }

    // Re-read so edits made while encoding are kept.
    const latest = (await stores.videos.get(video.id)) ?? video;
    const oldHls = latest.source.hlsPath;
    await stores.videos.upsert({
      ...latest,
      thumbnailPath: latest.thumbnailPath ?? thumbnailPath,
      source: { ...latest.source, encodeState: 'ready', encodeError: undefined, hlsPath: `${prefix}/master.m3u8`, durationSec: Math.round(info.duration) },
      updatedAt: new Date().toISOString(),
    });
    if (oldHls && !oldHls.startsWith(prefix)) await media.deleteMediaPrefix(oldHls.replace(/master\.m3u8$/, ''));
    console.info(`encoded ${video.id} -> ${prefix}/master.m3u8`);
  } catch (e) {
    await media.deleteMediaPrefix(`${prefix}/`).catch(() => undefined);
    throw e;
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}

async function main() {
  const [msg] = (await queue.receiveMessages({ numberOfMessages: 1, visibilityTimeout: VISIBILITY_SEC })).receivedMessageItems as DequeuedMessageItem[];
  if (!msg) { console.info('queue empty'); return; }
  let popReceipt = msg.popReceipt;
  const keepAlive = async () => {
    const r = await queue.updateMessage(msg.messageId, popReceipt, undefined, VISIBILITY_SEC);
    popReceipt = r.popReceipt!;
  };

  let job: EncodeJobMessage;
  try {
    job = JSON.parse(Buffer.from(msg.messageText, 'base64').toString('utf8')) as EncodeJobMessage;
    if (!job.videoId || !job.uploadBlob) throw new Error('bad message');
  } catch {
    console.error('discarding malformed message', msg.messageId);
    await queue.deleteMessage(msg.messageId, popReceipt);
    return;
  }

  try {
    await encode(job, keepAlive);
    await queue.deleteMessage(msg.messageId, popReceipt);
  } catch (e) {
    const err = (e as Error).message.slice(0, 500);
    console.error(`encode failed (attempt ${msg.dequeueCount}/${MAX_ATTEMPTS}): ${err}`);
    const v = await stores.videos.get(job.videoId);
    const final = msg.dequeueCount >= MAX_ATTEMPTS;
    if (v) await stores.videos.upsert({ ...v, source: { ...v.source, encodeState: final ? 'failed' : 'queued', encodeError: err } });
    if (final) await queue.deleteMessage(msg.messageId, popReceipt);
    process.exitCode = 1;
  }
}

await main();
