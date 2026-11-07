import { z } from 'zod';

const tagList = z.array(z.string().trim().min(1).max(80)).max(50).default([]);

/** Payload accepted by the admin API when creating or updating a video. */
export const videoInputSchema = z.object({
  title: z.string().trim().min(3).max(200),
  slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, numbers and dashes').max(120).optional(),
  pageTitle: z.string().trim().max(200).optional(),
  shortDescription: z.string().trim().max(600).default(''),
  description: z.string().max(20000).default(''),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  itemType: z.enum(['video', 'document']).default('video'),
  businessLines: z.array(z.enum(['IA', 'PA'])).max(2).default([]),
  products: tagList,
  verticals: tagList,
  authors: tagList,
  languages: tagList,
  categories: tagList,
  keywords: tagList,
  featured: z.boolean().default(false),
  publishedAt: z.iso.datetime().optional(),
  internalNotes: z.string().max(4000).optional(),
  /** Vimeo/YouTube link, or "azure" to use an uploaded file. */
  source: z.discriminatedUnion('provider', [
    z.object({ provider: z.literal('vimeo'), url: z.url({ protocol: /^https?$/ }).max(500) }),
    z.object({ provider: z.literal('youtube'), url: z.url({ protocol: /^https?$/ }).max(500) }),
    z.object({ provider: z.literal('azure') }),
  ]),
});
export type VideoInput = z.infer<typeof videoInputSchema>;

export const taxonomySchema = z.object({
  products: tagList,
  verticals: tagList,
  authors: z.array(z.string().trim().min(1).max(80)).max(500).default([]),
  languages: tagList,
  categories: tagList,
});

const honeypot = z.string().max(0, 'Spam detected').optional();

export const subscribeSchema = z.object({
  email: z.string().trim().email().max(254),
  products: z.array(z.string().max(80)).max(50).default([]),
  consent: z.literal(true, { error: 'Consent is required' }),
  website: honeypot,
});

export const formSchema = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().email().max(254),
  company: z.string().trim().max(160).optional(),
  product: z.string().trim().max(80).optional(),
  message: z.string().trim().min(5).max(4000),
  website: honeypot,
  /** Milliseconds the form was open; bots tend to submit instantly. */
  elapsedMs: z.number().int().min(0).optional(),
});

export const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  ppt: 'application/vnd.ms-powerpoint',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  zip: 'application/zip',
  txt: 'text/plain',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export const VIDEO_UPLOAD_TYPES = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wmv'];
/** 50 GB upper bound for a single source file. */
export const MAX_VIDEO_BYTES = 50 * 1024 ** 3;
export const MAX_ATTACHMENT_BYTES = 500 * 1024 ** 2;
export const MAX_THUMBNAIL_BYTES = 8 * 1024 ** 2;
