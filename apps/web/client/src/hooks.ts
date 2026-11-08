import { useEffect, useState } from 'react';
import { getJson, siteConfig, type SiteConfig } from './api';
import { useBranding } from './branding';

export function useSiteConfig(): SiteConfig | undefined {
  const [cfg, setCfg] = useState<SiteConfig>();
  useEffect(() => { siteConfig().then(setCfg).catch(() => undefined); }, []);
  return cfg;
}

export function useJson<T>(url: string | undefined) {
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    if (!url) return;
    const ac = new AbortController();
    setState((s) => ({ ...s, loading: true, error: undefined }));
    getJson<T>(url, ac.signal)
      .then((data) => setState({ data, loading: false }))
      .catch((e: Error) => { if (e.name !== 'AbortError') setState({ error: e.message, loading: false }); });
    return () => ac.abort();
  }, [url]);
  return state;
}

export function useTitle(title: string) {
  const site = useBranding().identity.siteName;
  useEffect(() => { document.title = title ? `${title} | ${site}` : site; }, [title, site]);
}
