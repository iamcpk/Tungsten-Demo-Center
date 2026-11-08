import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import {
  DEFAULT_BRANDING, brandAssetUrl, brandCss, googleFontsUrl, withDefaults, type Branding,
} from '../../../../packages/core/src/branding-model';

export * from '../../../../packages/core/src/branding-model';

interface BrandState { branding: Branding; preview: boolean }
const PREVIEW_KEY = 'tdc-brand-preview';

const BrandContext = createContext<BrandState>({ branding: DEFAULT_BRANDING, preview: false });
export const useBrandState = () => useContext(BrandContext);
export const useBranding = () => useContext(BrandContext).branding;

/** Settings the server put in the page, so the first paint already has the right brand. */
function injected(): BrandState | undefined {
  const el = document.getElementById('brand-data');
  if (!el?.textContent) return undefined;
  try {
    const j = JSON.parse(el.textContent) as { branding?: unknown; preview?: boolean };
    return { branding: withDefaults(j.branding), preview: !!j.preview };
  } catch {
    return undefined;
  }
}

const store = {
  get: () => { try { return sessionStorage.getItem(PREVIEW_KEY) ?? undefined; } catch { return undefined; } },
  set: (t: string) => { try { sessionStorage.setItem(PREVIEW_KEY, t); } catch { /* storage blocked */ } },
  clear: () => { try { sessionStorage.removeItem(PREVIEW_KEY); } catch { /* storage blocked */ } },
};

/** Keeps the brand CSS, fonts, favicon and theme colour in <head> in step with the settings. */
function applyToHead(b: Branding) {
  const head = document.head;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, id: string): HTMLElementTagNameMap[K] => {
    let e = document.getElementById(id) as HTMLElementTagNameMap[K] | null;
    if (!e) { e = document.createElement(tag); e.id = id; head.appendChild(e); }
    return e;
  };
  el('style', 'brand-css').textContent = brandCss(b);
  const gf = googleFontsUrl(b);
  const fontLink = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"][href^="https://fonts.googleapis.com/"]') ?? el('link', 'brand-fonts');
  if (gf) { fontLink.rel = 'stylesheet'; fontLink.href = gf; } else fontLink.removeAttribute('href');
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? el('link', 'brand-icon');
  icon.rel = 'icon';
  icon.type = b.assets.favicon?.type ?? 'image/svg+xml';
  icon.href = b.assets.favicon ? brandAssetUrl(b.assets.favicon) : '/favicon.svg';
  const theme = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]') ?? el('meta', 'brand-theme');
  theme.name = 'theme-color';
  theme.content = b.colors.primary;
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BrandState>(() => injected() ?? { branding: DEFAULT_BRANDING, preview: false });

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('brandPreview');
    if (fromUrl) store.set(fromUrl);
    const token = fromUrl ?? store.get();
    // Without server-injected settings (local dev), or when a preview continues after a reload, ask the API.
    if (!document.getElementById('brand-data') || (token && !state.preview)) {
      fetch(`/api/branding${token ? `?preview=${encodeURIComponent(token)}` : ''}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((j: { branding: unknown; preview: boolean }) => {
          if (token && !j.preview) store.clear(); // expired or replaced link
          setState({ branding: withDefaults(j.branding), preview: j.preview });
        })
        .catch(() => undefined);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => applyToHead(state.branding), [state.branding]);

  return <BrandContext.Provider value={state}>{children}</BrandContext.Provider>;
}

export function PreviewBanner() {
  const { preview } = useBrandState();
  if (!preview) return null;
  return (
    <div className="preview-banner" role="status">
      <span><strong>Branding preview.</strong> You're seeing unpublished changes. Visitors still see the published site.</span>
      <button type="button" className="btn btn-light btn-sm" onClick={() => { store.clear(); window.location.href = '/'; }}>Exit preview</button>
    </div>
  );
}

/** Internal page links use the router; external ones open safely in a new tab. */
export function isInternal(href: string) {
  return href.startsWith('/');
}
