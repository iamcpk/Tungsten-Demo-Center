/**
 * Closed captions for uploaded videos.
 *
 * Editors upload a WebVTT (.vtt) or SubRip (.srt) file per language. Every file is parsed and
 * rewritten as clean WebVTT before it is stored: only cue timings, a few safe cue settings and
 * plain text with <b>, <i> and <u> survive. Styles, regions, notes, other markup and anything
 * that isn't a valid cue are dropped, so a caption file can't carry scripts or odd content.
 */

export interface CaptionTrack {
  id: string;
  /** BCP 47 language tag, for example "en" or "fr-CA". */
  lang: string;
  /** Shown in the player's caption menu. */
  label: string;
  /** WebVTT file relative to the media base URL (captions/{videoId}/...). */
  path: string;
  cues: number;
  /** End of the last cue, in seconds. */
  lastCueSec: number;
  uploadedAt: string;
}

export const MAX_CAPTION_BYTES = 2 * 1024 * 1024;
export const MAX_CAPTION_TRACKS = 20;
const MAX_CUES = 20_000;
const MAX_CUE_CHARS = 1_000;
const MAX_SECONDS = 24 * 3600;

/** Languages offered in the admin portal, in menu order. */
export const CAPTION_LANGUAGES: { code: string; label: string }[] = [
  { code: 'en', label: 'English' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'fr', label: 'Français' },
  { code: 'fr-CA', label: 'Français (Canada)' },
  { code: 'de', label: 'Deutsch' },
  { code: 'es', label: 'Español' },
  { code: 'it', label: 'Italiano' },
  { code: 'nl', label: 'Nederlands' },
  { code: 'pt', label: 'Português' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
  { code: 'sv', label: 'Svenska' },
  { code: 'da', label: 'Dansk' },
  { code: 'nb', label: 'Norsk' },
  { code: 'fi', label: 'Suomi' },
  { code: 'pl', label: 'Polski' },
  { code: 'cs', label: 'Čeština' },
  { code: 'tr', label: 'Türkçe' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
  { code: 'zh-Hans', label: '中文 (简体)' },
  { code: 'zh-Hant', label: '中文 (繁體)' },
  { code: 'ar', label: 'العربية' },
  { code: 'hi', label: 'हिन्दी' },
];
export const captionLanguage = (code: string) => CAPTION_LANGUAGES.find((l) => l.code === code);

export class CaptionError extends Error {}

interface Cue { start: number; end: number; settings: string; text: string }

/** Reads the file as UTF-8 (or UTF-16 with a byte order mark); falls back to Windows-1252 for old SRT files. */
export function decodeCaptionText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf.subarray(2));
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf.subarray(2));
  const body = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? buf.subarray(3) : buf;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

const TIME = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/;
function parseTime(s: string): number | undefined {
  const m = TIME.exec(s.trim());
  if (!m) return undefined;
  const [, h, mm, ss, ms] = m;
  if (Number(mm) > 59 || Number(ss) > 59) return undefined;
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000;
}

function fmtTime(t: number): string {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
}

/** Only the WebVTT cue settings that position text, with simple values. */
function cleanSettings(raw: string): string {
  const ok: string[] = [];
  for (const part of raw.trim().split(/\s+/)) {
    const m = /^(align|line|position|size|vertical):([A-Za-z0-9%.,-]{1,20})$/.exec(part);
    if (m) ok.push(`${m[1]}:${m[2]}`);
  }
  return ok.length ? ` ${ok.join(' ')}` : '';
}

const esc = (s: string) => s.replace(/&(?!(amp|lt|gt|nbsp|lrm|rlm);)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Keeps <b>, <i> and <u> (SRT and VTT both use them); every other tag is removed and the text escaped. */
function cleanCueText(raw: string): string {
  const keep: string[] = [];
  let s = raw.replace(/\{\\[^}]*\}/g, ''); // SRT/ASS override codes like {\an8}
  s = s.replace(/<\/?([a-zA-Z]+)[^>]*>/g, (tag, name: string) => {
    const n = name.toLowerCase();
    if (n === 'b' || n === 'i' || n === 'u') {
      keep.push(tag.startsWith('</') ? `</${n}>` : `<${n}>`);
      return `\u0000${keep.length - 1}\u0000`;
    }
    return '';
  });
  s = esc(s.replace(/-->/g, '- >'));
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => keep[Number(i)]);
  s = s
    .split('\n')
    .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trimEnd())
    .filter((l) => l.trim())
    .join('\n')
    .slice(0, MAX_CUE_CHARS);
  // A cue that is only formatting tags has nothing to show.
  return s.replace(/<\/?[biu]>/g, '').trim() ? s : '';
}

/**
 * Parses a WebVTT or SRT file and returns clean WebVTT. Throws CaptionError with a message an
 * editor can act on when the file has no usable cues.
 */
export function parseCaptions(input: Buffer | string): { vtt: string; cues: number; lastCueSec: number; format: 'vtt' | 'srt' } {
  if (typeof input !== 'string' && input.length > MAX_CAPTION_BYTES) throw new CaptionError('The caption file is larger than 2 MB.');
  const text = (typeof input === 'string' ? input : decodeCaptionText(input)).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const format: 'vtt' | 'srt' = /^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text) ? 'vtt' : 'srt';
  if (format === 'srt' && !text.includes('-->')) throw new CaptionError('This is not a caption file. Upload a WebVTT (.vtt) or SubRip (.srt) file.');

  const blocks = text.split(/\n[ \t]*\n+/);
  if (format === 'vtt') blocks.shift(); // the WEBVTT header block
  const cues: Cue[] = [];
  let bad = 0;
  for (const block of blocks) {
    const lines = block.split('\n').filter((l, i) => i > 0 || l.trim());
    if (!lines.length) continue;
    if (format === 'vtt' && /^(NOTE|STYLE|REGION)(\s|$)/.test(lines[0])) continue;
    const ti = lines.findIndex((l) => l.includes('-->'));
    if (ti < 0 || ti > 1) { bad++; continue; } // an optional cue number/id, then the timing line
    const [a, rest = ''] = lines[ti].split('-->');
    const restTrim = rest.trim();
    const endStr = restTrim.split(/\s+/)[0] ?? '';
    const start = parseTime(a);
    const end = parseTime(endStr);
    if (start === undefined || end === undefined || end <= start || end > MAX_SECONDS) { bad++; continue; }
    const body = cleanCueText(lines.slice(ti + 1).join('\n'));
    if (!body) continue;
    cues.push({ start, end, settings: format === 'vtt' ? cleanSettings(restTrim.slice(endStr.length)) : '', text: body });
    if (cues.length > MAX_CUES) throw new CaptionError(`The caption file has more than ${MAX_CUES} cues.`);
  }
  if (!cues.length) {
    throw new CaptionError(bad ? 'No captions could be read: the timings are not in a recognised format (for example 00:01:02,500 --> 00:01:04,000).' : 'The caption file has no captions in it.');
  }
  cues.sort((x, y) => x.start - y.start || x.end - y.end);
  const vtt = `WEBVTT\n\n${cues.map((c) => `${fmtTime(c.start)} --> ${fmtTime(c.end)}${c.settings}\n${c.text}`).join('\n\n')}\n`;
  return { vtt, cues: cues.length, lastCueSec: Math.round(cues[cues.length - 1].end), format };
}

export const isCaptionLang = (s: unknown): s is string => typeof s === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(s);
