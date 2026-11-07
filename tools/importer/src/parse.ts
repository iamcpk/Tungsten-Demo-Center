import { createHash } from 'node:crypto';

/**
 * iVengi exports multi-select fields as a cumulative history, e.g.
 *   Healthcare,Healthcare";"Financial Services,Healthcare";"Financial Services";"Manufacturing
 * Splitting on both separators and de-duplicating (keeping first-seen order) yields the final list.
 */
export function parseMulti(raw: unknown): string[] {
  if (raw === null || raw === undefined) return [];
  const s = String(raw).trim();
  if (!s || s === '0') return [];
  const out: string[] = [];
  for (const part of s.split(/";"|,/)) {
    const v = part.replace(/^"+|"+$/g, '').trim();
    if (v && v !== '0' && !out.includes(v)) out.push(v);
  }
  return out;
}

export function parseKeywords(raw: unknown): string[] {
  return [...new Set(String(raw ?? '').split(/[,;]/).map((k) => k.trim()).filter((k) => k && k.length <= 80))];
}

/** Excel serial date (days since 1899-12-30) + "HH:mm" -> ISO string. */
export function excelDate(day: unknown, time: unknown): string | undefined {
  let base: number | undefined;
  if (day instanceof Date) base = day.getTime();
  else if (typeof day === 'number' || (typeof day === 'string' && /^\d+(\.\d+)?$/.test(day.trim()))) {
    base = Date.UTC(1899, 11, 30) + Number(day) * 86400_000;
  }
  if (base === undefined || Number.isNaN(base)) return undefined;
  const m = /^(\d{1,2}):(\d{2})/.exec(String(time ?? ''));
  if (m) base += (Number(m[1]) * 60 + Number(m[2])) * 60_000;
  return new Date(base).toISOString();
}

/** Removes iVengi/Excel artefacts from rich text. */
export function cleanLegacyHtml(raw: unknown): string {
  return String(raw ?? '').replace(/_x000D_/g, '').replace(/\r/g, '').trim();
}

/** Deterministic UUID (v5-style layout) so re-running the import updates rather than duplicates. */
export function stableId(legacyId: string): string {
  const h = createHash('sha1').update(`tungsten-demo-center:${legacyId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function isHttpUrl(v: unknown): v is string {
  return typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim().replace(/ /g, '%20'));
}
