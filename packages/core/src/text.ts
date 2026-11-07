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

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Turns HTML character references back into characters. Output is plain text, never HTML. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]+);/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? m;
  });
}

/**
 * Plain text, no markup at all. sanitize-html strips the tags but HTML-encodes what is left
 * ("&" becomes "&amp;"), so decode it again: callers render this as text (React, escapeHtml),
 * never as HTML, so storing "&amp;" would show up literally on the site.
 */
export function cleanText(text: string | undefined, max = 2000): string {
  return decodeEntities(sanitizeHtml(text ?? '', { allowedTags: [], allowedAttributes: {} })).trim().slice(0, max);
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
