import type { CaptionTrack } from './captions.js';
/** Business lines from the iVengi "Select the type of video" field. */
export const BUSINESS_LINES = {
  IA: 'Intelligent Automation',
  PA: 'Print and Workplace Automation',
} as const;
export type BusinessLine = keyof typeof BUSINESS_LINES;

/**
 * draft: work in progress, hidden. pending: submitted, "Awaiting approval", hidden.
 * active / archived: approved and public (main catalogue / archive section).
 */
export type VideoStatus = 'draft' | 'pending' | 'active' | 'archived';
export const PUBLIC_STATUSES: readonly VideoStatus[] = ['active', 'archived'];
export type SourceProvider = 'vimeo' | 'youtube' | 'azure';
export type EncodeState = 'awaiting-upload' | 'queued' | 'encoding' | 'ready' | 'failed';
export type ItemType = 'video' | 'document';

export interface VideoSource {
  provider: SourceProvider;
  /** Original URL for Vimeo/YouTube. */
  url?: string;
  /** Vimeo or YouTube video id. */
  externalId?: string;
  /** Vimeo unlisted privacy hash (the "h" embed parameter). */
  privacyHash?: string;
  /** Azure only: blob name of the raw upload in the private "uploads" container. */
  uploadBlob?: string;
  /** Azure only: path of the HLS master playlist, relative to the media base URL. */
  hlsPath?: string;
  encodeState?: EncodeState;
  encodeError?: string;
  durationSec?: number;
}

export interface Attachment {
  id: string;
  name: string;
  description?: string;
  /** Path relative to the media base URL (attachments/{videoId}/...). */
  path?: string;
  /** External URL (legacy links not yet migrated). */
  url?: string;
  sizeBytes?: number;
  contentType?: string;
}

export interface Video {
  id: string;
  slug: string;
  title: string;
  pageTitle?: string;
  shortDescription: string;
  /** Sanitised HTML. */
  description: string;
  status: VideoStatus;
  itemType: ItemType;
  businessLines: BusinessLine[];
  products: string[];
  verticals: string[];
  authors: string[];
  languages: string[];
  categories: string[];
  keywords: string[];
  featured: boolean;
  source: VideoSource;
  /** Path relative to the media base URL (thumbs/{videoId}/...). */
  thumbnailPath?: string;
  /** External thumbnail URL fallback. */
  thumbnailUrl?: string;
  attachments: Attachment[];
  /** Closed captions (uploaded videos only), one track per language. */
  captions?: CaptionTrack[];
  publishedAt: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  updatedBy?: string;
  /** Never exposed on the public site. */
  internalNotes?: string;
  /** iVengi contentindex, kept for traceability. */
  legacyId?: string;
  notifiedAt?: string;
  /** Two-stage publishing: who submitted the video and what the approver decided. Admin only. */
  review?: ReviewInfo;
}

export interface ReviewInfo {
  submittedBy?: string;
  submittedByName?: string;
  submittedAt?: string;
  decision?: 'approved' | 'changes-requested';
  decidedBy?: string;
  decidedAt?: string;
  /** Approver's comment; required when changes are requested. */
  note?: string;
  /** Set on the first approval; later approvals keep the original publish date. */
  firstApprovedAt?: string;
}

/**
 * People emailed when a video is submitted for approval.
 * - source "portal": added by an administrator on the Approvers page. Being on the list grants approval rights.
 * - source "entra": recorded automatically when someone holding the Entra "Approver" app role signs in, so they
 *   get the emails too. The Entra role is what grants their rights; the entry is dropped when the role is removed.
 */
export interface Approver {
  /** Lower-case sign-in email (UPN) as it appears in Entra ID. */
  email: string;
  name?: string;
  addedBy: string;
  addedAt: string;
  /** Missing on older entries, which are "portal". */
  source?: 'portal' | 'entra';
}
export interface ApproverList {
  id: 'approvers';
  people: Approver[];
  updatedAt?: string;
}

/** Shape returned by the public API: internal fields removed. */
export type PublicVideo = Omit<Video, 'internalNotes' | 'createdBy' | 'updatedBy' | 'legacyId' | 'notifiedAt' | 'review' | 'source'> & {
  source: Omit<VideoSource, 'uploadBlob' | 'encodeError'>;
};

export interface Taxonomy {
  id: 'taxonomy';
  products: string[];
  verticals: string[];
  authors: string[];
  languages: string[];
  categories: string[];
  updatedAt?: string;
}

export type SubscriberStatus = 'pending' | 'confirmed' | 'unsubscribed';
export interface Subscriber {
  /** sha256 of the normalised email. */
  id: string;
  email: string;
  status: SubscriberStatus;
  /** Product interests; empty = all products. */
  products: string[];
  /** Opaque random token for confirm/unsubscribe links. */
  token: string;
  consentText: string;
  createdAt: string;
  confirmedAt?: string;
  unsubscribedAt?: string;
}

export type SubmissionType = 'contact' | 'suggest' | 'demo';
export interface Submission {
  id: string;
  type: SubmissionType;
  name: string;
  email: string;
  company?: string;
  product?: string;
  message: string;
  status: 'new' | 'handled';
  createdAt: string;
}

export interface EncodeJobMessage {
  videoId: string;
  uploadBlob: string;
}

export function toPublicVideo(v: Video): PublicVideo {
  const { internalNotes, createdBy, updatedBy, legacyId, notifiedAt, review, source, ...rest } = v;
  void internalNotes; void createdBy; void updatedBy; void legacyId; void notifiedAt; void review;
  const { uploadBlob, encodeError, ...publicSource } = source;
  void uploadBlob; void encodeError;
  return { ...rest, source: publicSource };
}
