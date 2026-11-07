import sanitizeHtml from 'sanitize-html';
import { createHash, randomBytes } from 'node:crypto';

/** URL slug compatible with the iVengi /items/{slug} format. */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'video';
}

/** Allow-list HTML sanitiser for rich descriptions. */
export function cleanHtml(html: string): string {
  return sanitizeHtml(html ?? '', {
    allowedTags: ['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'h3', 'h4', 'blockquote', 'code', 'pre'],
    allowedAttributes: { a: ['href', 'title', 'target', 'rel'] },
    allowedSchemes: ['https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer nofollow', target: '_blank' }),
    },
  }).trim();
}

/** Plain text, no markup at all. */
export function cleanText(text: string | undefined, max = 2000): string {
  return sanitizeHtml(text ?? '', { allowedTags: [], allowedAttributes: {} }).trim().slice(0, max);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function emailId(email: string): string {
  return createHash('sha256').update(normaliseEmail(email)).digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
