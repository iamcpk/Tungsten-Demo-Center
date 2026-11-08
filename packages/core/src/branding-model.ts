/**
 * Site branding model, shared by the servers and both browser apps.
 * This file must stay dependency-free (no imports): the React clients import it directly.
 */

/** Built-in pages a menu or footer link can point to. */
export const PAGE_TARGETS = {
  '/': 'Home page',
  '/videos': 'All videos',
  '/archive': 'Archive',
  '/contact': 'Contact form',
  '/contact?type=suggest': 'Suggest a video form',
  '/contact?type=demo': 'Request a demo form',
  '/subscribe': 'Subscribe page',
} as const;
export type PageTarget = keyof typeof PAGE_TARGETS;

export interface BrandLink {
  id: string;
  label: string;
  /** A built-in page (see PAGE_TARGETS), an https:// URL or a mailto: address. */
  href: string;
  /** Header menu only: show as a button. */
  style?: 'link' | 'button';
  visible: boolean;
}

/** An uploaded, verified file in the media container under branding/. */
export interface BrandAsset {
  /** Content-addressed file name, for example "3f2a9c0d1e4b5a6f.png". */
  file: string;
  type: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Original file name, shown in the admin portal only. */
  name?: string;
}

export const SYSTEM_FONTS = {
  'system-sans': 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
  'system-serif': 'Georgia, Cambria, "Times New Roman", Times, serif',
} as const;

/** Google Fonts offered in the admin portal. Each one has the 400, 500, 700 and 900 weights. */
export const GOOGLE_FONTS = [
  'Red Hat Display', 'Red Hat Text', 'Inter', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Source Sans 3',
  'Noto Sans', 'Poppins', 'Nunito Sans', 'Work Sans', 'IBM Plex Sans', 'Merriweather', 'Playfair Display',
] as const;

export type FontChoice =
  | { source: 'google'; family: string }
  | { source: 'system'; family: keyof typeof SYSTEM_FONTS }
  /** Self-hosted WOFF2 (ideally a variable font so one file covers every weight). */
  | { source: 'upload'; family: string; file: BrandAsset };

export interface BrandColors {
  primary: string;
  primaryDeep: string;
  secondary: string;
  accent: string;
  accentDark: string;
  accentSoft: string;
  text: string;
  muted: string;
  mutedLight: string;
  border: string;
  background: string;
  surface: string;
}

export interface ContactCopy { title: string; intro: string; button: string }

export interface Branding {
  identity: { siteName: string; brandSubtitle: string; logoAlt: string; logoHeight: number };
  colors: BrandColors;
  fonts: { heading: FontChoice; body: FontChoice };
  assets: { logo?: BrandAsset; footerLogo?: BrandAsset; favicon?: BrandAsset; touchIcon?: BrandAsset; socialImage?: BrandAsset };
  header: { menu: BrandLink[] };
  home: {
    eyebrow: string; heading: string; headingAccent: string; lead: string; searchPlaceholder: string; showBusinessLines: boolean;
    featuredHeading: string; latestHeading: string; browseAllLabel: string; productsHeading: string; showProducts: boolean;
    showCta: boolean; ctaHeading: string; ctaText: string; ctaSuggestLabel: string; ctaDemoLabel: string;
  };
  footer: { heading: string; text: string; links: BrandLink[]; copyright: string; showLogo: boolean };
  pages: {
    videosHeading: string; archiveHeading: string;
    subscribeHeading: string; subscribeIntro: string;
    contact: ContactCopy; suggest: ContactCopy; demo: ContactCopy;
    notFoundHeading: string; notFoundText: string;
  };
  seo: { description: string };
  legal: { privacyUrl: string };
}

/** What the public site looked like before branding became editable. */
export const DEFAULT_BRANDING: Branding = {
  identity: { siteName: 'Tungsten Demo Center', brandSubtitle: 'Demo Center', logoAlt: 'Tungsten Automation', logoHeight: 34 },
  colors: {
    primary: '#002854', primaryDeep: '#00123b', secondary: '#004766', accent: '#00a0fb', accentDark: '#0081cc', accentSoft: '#eaf6fe',
    text: '#231f20', muted: '#5d6f84', mutedLight: '#8094aa', border: '#e4e8ee', background: '#f6f8fb', surface: '#ffffff',
  },
  fonts: { heading: { source: 'google', family: 'Red Hat Display' }, body: { source: 'google', family: 'Red Hat Display' } },
  assets: {},
  header: {
    menu: [
      { id: 'videos', label: 'Videos', href: '/videos', style: 'link', visible: true },
      { id: 'archive', label: 'Archive', href: '/archive', style: 'link', visible: true },
      { id: 'partners', label: 'Partners', href: 'https://partner.kofax.com', style: 'link', visible: true },
      { id: 'contact', label: 'Contact', href: '/contact', style: 'link', visible: true },
      { id: 'subscribe', label: 'Subscribe', href: '/subscribe', style: 'button', visible: true },
    ],
  },
  home: {
    eyebrow: 'Solutions Consulting',
    heading: 'See intelligent automation',
    headingAccent: 'in action',
    lead: 'Technical demonstrations, product walk-throughs and solution videos across the Tungsten Automation portfolio.',
    searchPlaceholder: 'Search videos, products, use cases...',
    showBusinessLines: true,
    featuredHeading: 'Featured',
    latestHeading: 'Latest videos',
    browseAllLabel: 'Browse all',
    productsHeading: 'Browse by product',
    showProducts: true,
    showCta: true,
    ctaHeading: "Can't find what you need?",
    ctaText: 'Search the archive, suggest a new video or ask the team for a live demo.',
    ctaSuggestLabel: 'Suggest a video',
    ctaDemoLabel: 'Request a demo',
  },
  footer: {
    heading: 'Tungsten Demo Center',
    text: 'Demonstrations and walk-throughs across the Tungsten Automation portfolio, from the Solutions Consulting team.',
    links: [
      { id: 'suggest', label: 'Suggest a video', href: '/contact?type=suggest', visible: true },
      { id: 'demo', label: 'Request a demo', href: '/contact?type=demo', visible: true },
      { id: 'privacy', label: 'Privacy policy', href: 'https://www.tungstenautomation.com/legal/privacy', visible: true },
      { id: 'corporate', label: 'tungstenautomation.com', href: 'https://www.tungstenautomation.com', visible: true },
    ],
    copyright: '© {year} Tungsten Automation Corporation',
    showLogo: false,
  },
  pages: {
    videosHeading: 'All videos',
    archiveHeading: 'Archived videos',
    subscribeHeading: 'Subscribe to new videos',
    subscribeIntro: 'Get an email when the Solutions Consulting team publishes new demos. Pick products to narrow it down, or leave them all unticked to hear about everything.',
    contact: { title: 'Contact the team', intro: 'Questions about a video or the Demo Center? Send us a message.', button: 'Send message' },
    suggest: { title: 'Suggest a video', intro: "Tell us what you'd like to see demonstrated and we'll pass it to the right consultant.", button: 'Send suggestion' },
    demo: { title: 'Request a demo', intro: 'Ask the Solutions Consulting team for a live, tailored demonstration.', button: 'Request demo' },
    notFoundHeading: "We couldn't find that page",
    notFoundText: 'The video may have moved or been retired. Try searching instead.',
  },
  seo: { description: 'Technical demonstrations, product walk-throughs and solution videos for the Tungsten Automation portfolio.' },
  legal: { privacyUrl: 'https://www.tungstenautomation.com/legal/privacy' },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Fill gaps from the defaults, so settings saved before a new field existed still work. */
export function withDefaults(b: unknown): Branding {
  const merge = (def: unknown, val: unknown): unknown => {
    if (val === undefined || val === null) return def;
    if (isObj(def) && isObj(val)) {
      const out: Record<string, unknown> = { ...val };
      for (const k of Object.keys(def)) out[k] = merge(def[k], val[k]);
      return out;
    }
    return val;
  };
  return merge(DEFAULT_BRANDING, b) as Branding;
}

export const isExternalHref = (href: string) => /^(https:|mailto:)/i.test(href);

export function copyrightText(b: Branding, year = new Date().getFullYear()) {
  return b.footer.copyright.replace(/\{year\}/g, String(year));
}

// ---------- fonts ----------
export function fontStack(f: FontChoice): string {
  if (f.source === 'system') return SYSTEM_FONTS[f.family] ?? SYSTEM_FONTS['system-sans'];
  const fallback = /serif|merriweather|playfair/i.test(f.family) && !/sans/i.test(f.family) ? SYSTEM_FONTS['system-serif'] : SYSTEM_FONTS['system-sans'];
  return `"${f.family.replace(/["\\]/g, '')}", ${fallback}`;
}

/** One Google Fonts stylesheet URL for every Google font in use, or undefined. */
export function googleFontsUrl(b: Branding): string | undefined {
  const fams = [...new Set([b.fonts.heading, b.fonts.body].filter((f) => f.source === 'google').map((f) => f.family))];
  if (!fams.length) return undefined;
  return `https://fonts.googleapis.com/css2?${fams.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:wght@400;500;700;900`).join('&')}&display=swap`;
}

/** URL path the sites serve brand files from (same origin, so fonts need no CORS). */
export const brandAssetUrl = (a: BrandAsset) => `/brand/${a.file}`;

/** CSS for the brand: :root variables plus @font-face rules for uploaded fonts. */
export function brandCss(b: Branding): string {
  const c = b.colors;
  const faces = [b.fonts.heading, b.fonts.body]
    .filter((f): f is Extract<FontChoice, { source: 'upload' }> => f.source === 'upload')
    .map((f) => `@font-face{font-family:"${f.family.replace(/["\\]/g, '')}";src:url(${brandAssetUrl(f.file)}) format("woff2");font-weight:100 900;font-display:swap}`);
  const vars = {
    '--navy': c.primary, '--navy-deep': c.primaryDeep, '--teal': c.secondary, '--blue': c.accent, '--blue-dark': c.accentDark,
    '--light-blue': c.accentSoft, '--ink': c.text, '--gray': c.muted, '--gray-mid': c.mutedLight, '--line': c.border,
    '--bg': c.background, '--card': c.surface, '--font': fontStack(b.fonts.body), '--font-heading': fontStack(b.fonts.heading),
    '--logo-h': `${b.identity.logoHeight}px`,
  };
  return `${faces.join('')}:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}}`;
}

// ---------- accessibility ----------
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/** WCAG 2 contrast ratio between two #rrggbb colours (1 to 21). */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1! + 0.05) / (l2! + 0.05);
}

/** The colour pairs the site actually uses for text, checked against WCAG AA. */
export function contrastChecks(c: BrandColors) {
  const white = '#ffffff';
  return [
    { label: 'Body text on page background', fg: c.text, bg: c.background, min: 4.5 },
    { label: 'Body text on cards', fg: c.text, bg: c.surface, min: 4.5 },
    { label: 'Headings on cards', fg: c.primary, bg: c.surface, min: 4.5 },
    { label: 'Secondary text on cards', fg: c.muted, bg: c.surface, min: 4.5 },
    { label: 'Links on cards', fg: c.accentDark, bg: c.surface, min: 4.5 },
    { label: 'Button text on accent buttons', fg: white, bg: c.accent, min: 4.5 },
    { label: 'Hero heading on primary', fg: white, bg: c.primary, min: 3 },
    { label: 'Footer text on footer', fg: white, bg: c.primaryDeep, min: 4.5 },
  ].map((x) => ({ ...x, ratio: contrastRatio(x.fg, x.bg) }));
}
