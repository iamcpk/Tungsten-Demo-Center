export * from '../../../../packages/core/src/branding-model';
import type { Branding } from '../../../../packages/core/src/branding-model';

export interface VersionInfo { version: number; publishedAt: string; publishedBy: string; note?: string }
export interface BrandingState {
  settings: Branding;
  published: Branding;
  defaults: Branding;
  rev: number;
  draft: { updatedAt: string; updatedBy: string } | null;
  current: VersionInfo | null;
  history: VersionInfo[];
  previewExpiresAt: string | null;
  publicSiteUrl: string;
}

export type AssetKind = 'logo' | 'footerLogo' | 'favicon' | 'touchIcon' | 'socialImage' | 'font';
export const ASSET_HELP: Record<AssetKind, { accept: string; help: string }> = {
  logo: { accept: '.svg,.png,.webp,.jpg,.jpeg', help: 'SVG (best) or a PNG/WebP about 3x the display height, transparent background. Up to 1 MB.' },
  footerLogo: { accept: '.svg,.png,.webp,.jpg,.jpeg', help: 'Shown on the dark footer, so use a light or white version. Up to 1 MB.' },
  favicon: { accept: '.svg,.png,.ico', help: 'Square SVG (best), or a square PNG of at least 48 x 48 pixels (ICO also accepted). Up to 256 KB.' },
  touchIcon: { accept: '.png', help: 'Square 180 x 180 pixel PNG with no transparency. Used when someone adds the site to a phone home screen.' },
  socialImage: { accept: '.png,.jpg,.jpeg,.webp', help: '1200 x 630 pixels. Shown when the site is shared in Teams, LinkedIn or email. Up to 2 MB.' },
  font: { accept: '.woff2', help: 'WOFF2 file, ideally a variable font so one file covers every weight. Check the font licence allows web use.' },
};
