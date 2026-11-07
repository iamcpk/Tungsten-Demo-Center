export type BusinessLine = 'IA' | 'PA';

export interface Attachment {
  id: string;
  name: string;
  description?: string;
  path?: string;
  url?: string;
  sizeBytes?: number;
}

export interface Video {
  id: string;
  slug: string;
  title: string;
  pageTitle?: string;
  shortDescription: string;
  description: string;
  status: 'active' | 'archived';
  itemType: 'video' | 'document';
  businessLines: BusinessLine[];
  products: string[];
  verticals: string[];
  authors: string[];
  languages: string[];
  categories: string[];
  keywords: string[];
  featured: boolean;
  source: {
    provider: 'vimeo' | 'youtube' | 'azure';
    externalId?: string;
    privacyHash?: string;
    hlsPath?: string;
    encodeState?: string;
    durationSec?: number;
  };
  thumbnailPath?: string;
  thumbnailUrl?: string;
  attachments: Attachment[];
  publishedAt: string;
}

export type FacetKey = 'businessLines' | 'products' | 'verticals' | 'authors' | 'languages' | 'categories';
export interface SearchResult {
  total: number;
  items: Video[];
  facets: Record<FacetKey, { value: string; count: number }[]>;
}

export interface SiteConfig {
  mediaBaseUrl: string;
  businessLines: Record<BusinessLine, string>;
}

export const BUSINESS_LINE_LABELS: Record<BusinessLine, string> = {
  IA: 'Intelligent Automation',
  PA: 'Print & Workplace Automation',
};

let cfg: Promise<SiteConfig> | undefined;
export function siteConfig(): Promise<SiteConfig> {
  cfg ??= getJson<SiteConfig>('/api/config');
  return cfg;
}

export async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(res.status === 404 ? 'not-found' : `Request failed (${res.status})`);
  return res.json() as Promise<T>;
}

export async function postJson(url: string, body: unknown): Promise<void> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(j.error ?? (res.status === 429 ? 'Too many requests, please try again later.' : 'Something went wrong.'));
  }
}

export function mediaUrl(base: string, rel: string): string {
  return `${base}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function thumbOf(v: Video, base: string): string | undefined {
  if (v.thumbnailPath) return mediaUrl(base, v.thumbnailPath);
  return v.thumbnailUrl;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatDuration(sec?: number): string | undefined {
  if (!sec) return undefined;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(n?: number): string {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i ? 1 : 0)} ${u[i]}`;
}
