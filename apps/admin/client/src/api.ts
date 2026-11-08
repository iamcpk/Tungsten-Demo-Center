export type Role = 'Admin' | 'Approver' | 'Creator';
export const ROLE_LABEL: Record<Role, string> = { Admin: 'Administrator', Approver: 'Approver', Creator: 'Content Creator' };
export interface Me {
  user: { id: string; name: string; email?: string; roles: Role[] };
  canApprove: boolean;
  mediaBaseUrl: string;
  publicSiteUrl: string;
  uploadMode: 'azure' | 'local';
}

export type Provider = 'vimeo' | 'youtube' | 'azure';
export interface Attachment { id: string; name: string; description?: string; path?: string; url?: string; sizeBytes?: number }
export interface Video {
  id: string;
  slug: string;
  title: string;
  pageTitle?: string;
  shortDescription: string;
  description: string;
  status: VideoStatus;
  itemType: 'video' | 'document';
  businessLines: ('IA' | 'PA')[];
  products: string[];
  verticals: string[];
  authors: string[];
  languages: string[];
  categories: string[];
  keywords: string[];
  featured: boolean;
  source: {
    provider: Provider;
    url?: string;
    externalId?: string;
    uploadBlob?: string;
    hlsPath?: string;
    encodeState?: 'awaiting-upload' | 'queued' | 'encoding' | 'ready' | 'failed';
    encodeError?: string;
    durationSec?: number;
  };
  thumbnailPath?: string;
  thumbnailUrl?: string;
  attachments: Attachment[];
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  internalNotes?: string;
  legacyId?: string;
  notifiedAt?: string;
  review?: {
    submittedBy?: string; submittedByName?: string; submittedAt?: string;
    decision?: 'approved' | 'changes-requested'; decidedBy?: string; decidedAt?: string; note?: string; firstApprovedAt?: string;
  };
  /** Returned after a submit: how many approvers were emailed. */
  notifiedApprovers?: number;
}

export type VideoStatus = 'draft' | 'pending' | 'active' | 'archived';
export const STATUS_LABEL: Record<VideoStatus, string> = { draft: 'Draft', pending: 'Awaiting approval', active: 'Active', archived: 'Archived' };
export const isPublished = (s: VideoStatus) => s === 'active' || s === 'archived';
export interface Approver { email: string; name?: string; addedBy: string; addedAt: string }

export interface Taxonomy { products: string[]; verticals: string[]; authors: string[]; languages: string[]; categories: string[] }
export interface Subscriber { id: string; email: string; status: string; products: string[]; createdAt: string; confirmedAt?: string }
export interface Submission { id: string; type: string; name: string; email: string; company?: string; product?: string; message: string; status: 'new' | 'handled'; createdAt: string }

async function handle<T>(res: Response): Promise<T> {
  if (res.status === 401) {
    // Easy Auth session expired: start a fresh sign-in and come back here.
    window.location.href = `/.auth/login/aad?post_login_redirect_uri=${encodeURIComponent(window.location.pathname)}`;
    throw new Error('Signing in...');
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `Request failed (${res.status})`);
  return body as T;
}

export const api = {
  get: <T>(url: string) => fetch(url, { headers: { Accept: 'application/json' } }).then((r) => handle<T>(r)),
  send: <T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) =>
    fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-TDC-CSRF': '1' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  upload: <T>(url: string, form: FormData) =>
    fetch(url, { method: 'POST', headers: { 'X-TDC-CSRF': '1' }, body: form }).then((r) => handle<T>(r)),
};

/**
 * Upload a (possibly multi-GB) file straight to Blob Storage with a SAS URL, in parallel
 * 8 MB blocks. The file never passes through the web server.
 */
export async function uploadToBlob(url: string, file: File, contentType: string, onProgress: (pct: number) => void, signal?: AbortSignal) {
  if (url.startsWith('/api/local-upload/')) {
    const res = await fetch(url, { method: 'PUT', headers: { 'X-TDC-CSRF': '1', 'Content-Type': 'application/octet-stream' }, body: file, signal });
    if (!res.ok) throw new Error('Upload failed');
    onProgress(100);
    return;
  }
  const { BlockBlobClient } = await import('@azure/storage-blob');
  const client = new BlockBlobClient(url);
  await client.uploadData(file, {
    blockSize: 8 * 1024 * 1024,
    concurrency: 4,
    abortSignal: signal,
    blobHTTPHeaders: { blobContentType: contentType },
    onProgress: (p) => onProgress(Math.round((p.loadedBytes / file.size) * 100)),
  });
}

export function mediaUrl(base: string, rel: string) {
  return `${base}/${rel.split('/').map(encodeURIComponent).join('/')}`;
}

export function fmtDate(iso?: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function fmtBytes(n?: number) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
}

export const BL: Record<'IA' | 'PA', string> = { IA: 'Intelligent Automation', PA: 'Print & Workplace Automation' };
