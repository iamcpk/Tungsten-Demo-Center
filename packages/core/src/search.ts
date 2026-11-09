/**
 * Dependency-free text search used by the public site and the admin portal.
 *
 * Matching, per query term, best first:
 *   1. whole word            "ecopy"       -> "eCopy"
 *   2. start of a word       "share"       -> "ShareScan"
 *   3. anywhere, ignoring spaces and punctuation
 *                            "copy", "modern auth", "sharescan66" -> "eCopy ShareScan 6.6 ... Modern-Auth"
 *   4. close spelling        "sharscan", "tokenvalt" -> "ShareScan", "TokenVault"
 * Title hits weigh most, then tags (products, keywords, presenters...), then descriptions.
 * Every term must match somewhere. If nothing matches all terms, the closest partial matches
 * are returned instead and the result is flagged as relaxed.
 * "Quoted phrases" must appear together.
 */

export interface SearchDoc {
  title: string;
  tags: string[];
  body: string;
}

interface Field {
  /** Normalised text with single spaces and a leading/trailing space: " ecopy sharescan 6 6 ". */
  spaced: string;
  /** Same text with all separators removed: "ecopysharescan66". */
  compact: string;
  words: string[];
}

export interface DocIndex {
  title: Field;
  tags: Field;
  body: Field;
}

interface Term {
  /** Normalised words of this term, e.g. ["modern", "auth"]. */
  words: string[];
  compact: string;
  phrase: boolean;
  stop: boolean;
}

export interface ParsedQuery {
  terms: Term[];
  /** The whole query, normalised and spaced, for the exact-title bonus. */
  spaced: string;
}

export interface Match {
  score: number;
  /** Number of required terms that matched. */
  matched: number;
  /** Number of required terms in the query. */
  required: number;
}

const STOP_WORDS = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'with', 'to', 'in', 'on', 'how', 'by', 'or', 'is', 'at', 'from', 'using', 'use']);
const FIELD_WEIGHT = { title: 10, tags: 5, body: 1 } as const;
const MAX_TERMS = 10;

// Built from char codes so no invisible combining characters live in the source (U+0300 to U+036F).
const COMBINING_MARKS = new RegExp(`[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`, 'g');

/** Lower-case, strip accents, and turn every run of non-letters/digits into one space. */
export function normalize(s: string): string {
  return s.normalize('NFKD').replace(COMBINING_MARKS, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function field(text: string): Field {
  const n = normalize(text);
  return { spaced: ` ${n} `, compact: n.replace(/ /g, ''), words: n ? n.split(' ') : [] };
}

export function indexDoc(doc: SearchDoc): DocIndex {
  return { title: field(doc.title), tags: field(doc.tags.join(' | ')), body: field(doc.body) };
}

export function parseQuery(raw: string): ParsedQuery {
  const terms: Term[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw.slice(0, 300))) && terms.length < MAX_TERMS) {
    const phrase = m[1] !== undefined;
    const words = normalize(m[1] ?? m[2]).split(' ').filter(Boolean);
    if (!words.length) continue;
    const compact = words.join('');
    // One stray letter ("a", "e") on its own matches almost everything, so it is ignored. Digits are kept ("6").
    if (!phrase && compact.length === 1 && !/\d/.test(compact)) continue;
    terms.push({ words, compact, phrase, stop: !phrase && words.length === 1 && STOP_WORDS.has(compact) });
  }
  // A query made only of stop words ("how to") still has to match something.
  if (terms.length && terms.every((t) => t.stop)) for (const t of terms) t.stop = false;
  return { terms, spaced: normalize(raw) };
}

/** Optimal string alignment distance, giving up once it exceeds max. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

function allowedTypos(len: number): number {
  return len < 4 ? 0 : len < 8 ? 1 : 2;
}

/** How well one term matches one field: 0 (no match) to 1 (whole word). */
function termInField(t: Term, f: Field): number {
  if (!f.compact) return 0;
  if (t.phrase || t.words.length > 1) {
    const joined = ` ${t.words.join(' ')} `;
    if (f.spaced.includes(joined)) return 1;
    if (f.spaced.includes(` ${t.words.join(' ')}`)) return 0.8;
    if (t.phrase) return 0;
  } else {
    const w = t.compact;
    if (f.spaced.includes(` ${w} `)) return 1;
    if (f.spaced.includes(` ${w}`)) return 0.8;
  }
  if (t.compact.length >= 2 && f.compact.includes(t.compact)) return 0.5;
  const typos = allowedTypos(t.compact.length);
  if (!typos) return 0;
  for (const word of f.words) {
    if (Math.abs(word.length - t.compact.length) <= typos && editDistance(t.compact, word, typos) <= typos) return 0.35;
    // Partly typed word with a typo: "tokenvau" against "tokenvault".
    if (word.length > t.compact.length && editDistance(t.compact, word.slice(0, t.compact.length), typos) <= typos) return 0.25;
  }
  return 0;
}

export function matchDoc(q: ParsedQuery, d: DocIndex): Match {
  let score = 0;
  let matched = 0;
  let required = 0;
  for (const t of q.terms) {
    const s = termInField(t, d.title) * FIELD_WEIGHT.title
      + termInField(t, d.tags) * FIELD_WEIGHT.tags
      + termInField(t, d.body) * FIELD_WEIGHT.body;
    if (!t.stop) {
      required++;
      if (s > 0) matched++;
    }
    score += t.stop ? s * 0.1 : s;
  }
  if (matched && q.spaced.length > 2) {
    if (d.title.spaced === ` ${q.spaced} `) score += 30;
    else if (d.title.spaced.includes(` ${q.spaced}`)) score += 15;
  }
  return { score, matched, required };
}

/**
 * Rank documents for a query. Returns all-terms matches, or, when there are none,
 * documents matching most of the terms (relaxed = true). Empty query: everything, score 1.
 */
export function rankDocs<T>(docs: T[], raw: string, index: (doc: T) => DocIndex): { hits: Map<T, number>; relaxed: boolean; hasQuery: boolean } {
  const q = parseQuery(raw);
  const hits = new Map<T, number>();
  if (!q.terms.length) {
    for (const d of docs) hits.set(d, 1);
    return { hits, relaxed: false, hasQuery: false };
  }
  const partial: { d: T; m: Match }[] = [];
  for (const d of docs) {
    const m = matchDoc(q, index(d));
    if (m.required && m.matched === m.required) hits.set(d, m.score);
    else if (!m.required && m.score > 0) hits.set(d, m.score);
    else if (m.matched > 0) partial.push({ d, m });
  }
  if (hits.size || !partial.length) return { hits, relaxed: false, hasQuery: true };
  const best = Math.max(...partial.map((p) => p.m.matched));
  // Only fall back when at least half of the words matched, so one common word doesn't return the whole catalogue.
  const need = Math.max(best, Math.ceil(partial[0].m.required / 2));
  for (const p of partial) if (p.m.matched >= need) hits.set(p.d, p.m.score);
  return { hits, relaxed: hits.size > 0, hasQuery: true };
}

/** Memoised index for objects that don't change once loaded (catalogue snapshots, fetched lists). */
export function cachedIndexer<T extends object>(toDoc: (v: T) => SearchDoc): (v: T) => DocIndex {
  const cache = new WeakMap<T, DocIndex>();
  return (v) => {
    let i = cache.get(v);
    if (!i) { i = indexDoc(toDoc(v)); cache.set(v, i); }
    return i;
  };
}
