import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { api, fmtDate } from '../api';
import {
  ASSET_HELP, GOOGLE_FONTS, PAGE_TARGETS, SYSTEM_FONTS, brandAssetUrl, contrastChecks, copyrightText, fontStack, googleFontsUrl,
  type AssetKind, type BrandAsset, type BrandColors, type BrandLink, type Branding, type BrandingState, type FontChoice,
} from '../brand';

type Tab = 'identity' | 'colors' | 'fonts' | 'header' | 'home' | 'footer' | 'pages' | 'history';
const TABS: [Tab, string][] = [
  ['identity', 'Logos & icons'], ['colors', 'Colours'], ['fonts', 'Fonts'], ['header', 'Header & menu'],
  ['home', 'Home page'], ['footer', 'Footer'], ['pages', 'Other pages'], ['history', 'History'],
];

const COLOR_FIELDS: { key: keyof BrandColors; label: string; hint: string }[] = [
  { key: 'primary', label: 'Primary', hint: 'Headings, header text, hero background' },
  { key: 'primaryDeep', label: 'Primary (deep)', hint: 'Footer background, hero gradient start' },
  { key: 'secondary', label: 'Secondary', hint: 'Hero gradient end, card placeholders' },
  { key: 'accent', label: 'Accent', hint: 'Highlights on dark backgrounds, focus outline' },
  { key: 'accentDark', label: 'Accent (dark)', hint: 'Buttons and links. White text sits on it, so keep it dark enough' },
  { key: 'accentSoft', label: 'Accent (soft)', hint: 'Chips and menu hover background' },
  { key: 'text', label: 'Body text', hint: 'Paragraph text' },
  { key: 'muted', label: 'Secondary text', hint: 'Descriptions and hints' },
  { key: 'mutedLight', label: 'Subtle text', hint: 'Counts, labels, search icon' },
  { key: 'border', label: 'Borders', hint: 'Lines and card edges' },
  { key: 'background', label: 'Page background', hint: 'Behind the content' },
  { key: 'surface', label: 'Cards and header', hint: 'Cards, panels and the header bar' },
];

const clone = <T,>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const newId = () => `link-${Math.random().toString(36).slice(2, 8)}`;

/** Administrators control the look and wording of the public site. Changes go live only when published. */
export default function BrandingPage() {
  const [state, setState] = useState<BrandingState>();
  const [b, setB] = useState<Branding>();
  const [tab, setTab] = useState<Tab>('identity');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<{ url: string; expiresAt: string }>();
  const [note, setNote] = useState('');

  const load = (s: BrandingState) => { setState(s); setB(clone(s.settings)); };
  useEffect(() => { api.get<BrandingState>('/api/branding').then(load).catch((e: Error) => setMsg({ kind: 'err', text: e.message })); }, []);

  const dirty = !!state && !!b && !same(b, state.settings);
  const hasDraft = !!state?.draft || dirty;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!state || !b) return msg ? <p className="alert">{msg.text}</p> : <p className="muted">Loading...</p>;

  const edit = (fn: (d: Branding) => void) => setB((cur) => { const d = clone(cur!); fn(d); return d; });

  const run = async (label: string, fn: () => Promise<string | void>) => {
    setBusy(label);
    setMsg(undefined);
    try {
      const text = await fn();
      if (text) setMsg({ kind: 'ok', text });
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy('');
    }
  };
  const save = async () => {
    const s = await api.send<BrandingState>('PUT', '/api/branding/draft', { settings: b, rev: state.rev });
    load(s);
    return s;
  };
  const saveDraft = () => run('save', async () => { await save(); return 'Draft saved. Visitors still see the published version.'; });
  const makePreview = () => run('preview', async () => {
    if (dirty || !state.draft) await save();
    setPreview(await api.send<{ url: string; expiresAt: string }>('POST', '/api/branding/preview'));
  });
  const publish = () => run('publish', async () => {
    if (!confirm('Publish these branding changes to the public site now? Visitors see them within a minute.')) return;
    const rev = dirty || !state.draft ? (await save()).rev : state.rev;
    load(await api.send<BrandingState>('POST', '/api/branding/publish', { rev, note: note || undefined }));
    setNote('');
    setPreview(undefined);
    return 'Published. The public site shows the new branding within a minute.';
  });
  const discard = () => run('discard', async () => {
    if (!confirm('Throw away all unpublished branding changes? This cannot be undone.')) return;
    load(await api.send<BrandingState>('DELETE', '/api/branding/draft'));
    setPreview(undefined);
    return 'Unpublished changes discarded.';
  });
  const isDefault = same(b, state.defaults);
  const resetToDefault = () => {
    if (!confirm('Reset everything (colours, fonts, logos, icons, menu and all text) to the Tungsten default branding? The site only changes when you publish.')) return;
    setB(clone(state.defaults));
    setTab('identity');
    setMsg({ kind: 'ok', text: 'Tungsten default branding loaded. Save it as a draft to preview it, or publish to make it live.' });
  };
  const restore = (version: number) => run('restore', async () => {
    if (dirty && !confirm('You have unsaved changes. Replace them with this earlier version?')) return;
    load(await api.send<BrandingState>('POST', `/api/branding/restore/${version}`, { rev: state.rev }));
    setTab('identity');
    return `Version ${version} copied into the draft. Check it, then publish to make it live.`;
  });

  const status = dirty ? <span className="tag tag-pending">Unsaved changes</span>
    : state.draft ? <span className="tag tag-pending">Draft saved {fmtDate(state.draft.updatedAt)} by {state.draft.updatedBy}, not published</span>
    : <span className="tag tag-active">Matches the live site</span>;

  return (
    <>
      <div className="page-head sticky">
        <div>
          <h1>Branding</h1>
          <p className="muted small">
            {state.current ? `Live: version ${state.current.version}, published ${fmtDate(state.current.publishedAt)} by ${state.current.publishedBy}` : 'Live: the Tungsten default branding (nothing published yet)'} {status}
          </p>
        </div>
        <div className="actions">
          <button type="button" className="btn" disabled={!!busy || isDefault} onClick={resetToDefault} title={isDefault ? 'The editor already shows the Tungsten default branding' : undefined}>Reset to Tungsten default branding</button>
          {hasDraft && <button type="button" className="btn" disabled={!!busy} onClick={discard}>Discard</button>}
          <button type="button" className="btn" disabled={!!busy || !dirty} onClick={saveDraft}>{busy === 'save' ? 'Saving...' : 'Save draft'}</button>
          <button type="button" className="btn" disabled={!!busy || !hasDraft} onClick={makePreview}>{busy === 'preview' ? 'Creating...' : 'Preview on site'}</button>
          <button type="button" className="btn btn-primary" disabled={!!busy || !hasDraft} onClick={publish}>{busy === 'publish' ? 'Publishing...' : 'Publish'}</button>
        </div>
      </div>

      {msg && <p className={msg.kind === 'ok' ? 'notice' : 'alert'} role="status">{msg.text}</p>}
      {preview && (
        <p className="notice">
          Preview link ready, valid until {new Date(preview.expiresAt).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}.{' '}
          <a href={preview.url} target="_blank" rel="noopener noreferrer"><strong>Open the preview</strong></a>{' '}
          <button type="button" className="link" onClick={() => { void navigator.clipboard?.writeText(preview.url); setMsg({ kind: 'ok', text: 'Preview link copied. Anyone with the link can see the draft until it expires or you publish.' }); }}>Copy link</button>
        </p>
      )}
      {hasDraft && (
        <div className="panel brand-publish">
          <label className="field"><span>Publish note (optional, shown in History)</span><input maxLength={400} value={note} onChange={(e) => setNote(e.target.value)} placeholder="For example: new logo for the spring launch" /></label>
        </div>
      )}

      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{label}</button>)}
      </div>

      <div className="brand-layout">
        <div className="brand-form">
          {tab === 'identity' && <IdentityTab b={b} edit={edit} onError={(t) => setMsg({ kind: 'err', text: t })} />}
          {tab === 'colors' && <ColorsTab b={b} edit={edit} defaults={state.defaults} />}
          {tab === 'fonts' && <FontsTab b={b} edit={edit} onError={(t) => setMsg({ kind: 'err', text: t })} />}
          {tab === 'header' && (
            <Section title="Header menu" help="Up to 8 links. Use the arrows to reorder. Links to other websites open in a new tab.">
              <LinkList links={b.header.menu} max={8} allowButton onChange={(l) => edit((d) => { d.header.menu = l; })} />
            </Section>
          )}
          {tab === 'home' && <HomeTab b={b} edit={edit} />}
          {tab === 'footer' && <FooterTab b={b} edit={edit} />}
          {tab === 'pages' && <PagesTab b={b} edit={edit} />}
          {tab === 'history' && <HistoryTab state={state} busy={!!busy} onRestore={restore} onReset={resetToDefault} />}
        </div>
        <aside className="brand-preview-col">
          <h2 className="small muted">Live preview (unsaved changes included)</h2>
          <MiniPreview b={b} />
        </aside>
      </div>
    </>
  );
}

// ---------- building blocks ----------
type EditProps = { b: Branding; edit: (fn: (d: Branding) => void) => void };

function Section({ title, help, children }: { title: string; help?: string; children: ReactNode }) {
  return (
    <section className="panel brand-section">
      <h2>{title}</h2>
      {help && <p className="hint">{help}</p>}
      {children}
    </section>
  );
}

function Text({ label, value, onChange, max, rows, hint, required }: { label: string; value: string; onChange: (v: string) => void; max: number; rows?: number; hint?: string; required?: boolean }) {
  return (
    <label className="field">
      <span>{label}{required && ' *'}</span>
      {rows ? <textarea rows={rows} maxLength={max} value={value} onChange={(e) => onChange(e.target.value)} />
        : <input maxLength={max} value={value} required={required} onChange={(e) => onChange(e.target.value)} />}
      <span className="hint">{hint ? `${hint} ` : ''}{value.length}/{max}</span>
    </label>
  );
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return <label className="check"><input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}</label>;
}

function AssetField({ kind, label, value, onChange, onError }: { kind: AssetKind; label: string; value?: BrandAsset; onChange: (a?: BrandAsset) => void; onError: (t: string) => void }) {
  const [busy, setBusy] = useState(false);
  const h = ASSET_HELP[kind];
  const upload = async (file?: File) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append('kind', kind);
      form.append('file', file);
      onChange(await api.upload<BrandAsset>('/api/branding/assets', form));
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="field brand-asset">
      <span>{label}</span>
      <div className="brand-asset-row">
        <div className={`brand-asset-thumb ${kind === 'footerLogo' ? 'dark' : ''}`}>
          {value && kind !== 'font' ? <img src={brandAssetUrl(value)} alt="" /> : <span className="muted small">{value ? 'Font' : 'Default'}</span>}
        </div>
        <div>
          {value && <p className="small">{value.name ?? value.file}{value.width ? ` · ${value.width} x ${value.height}` : ''} · {Math.max(1, Math.round(value.bytes / 1024))} KB</p>}
          <label className="btn btn-sm">
            {busy ? 'Uploading...' : value ? 'Replace' : 'Upload'}
            <input type="file" accept={h.accept} hidden disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
          </label>
          {value && <button type="button" className="link danger" onClick={() => onChange(undefined)}> Use default</button>}
          <p className="hint">{h.help}</p>
        </div>
      </div>
    </div>
  );
}

function LinkList({ links, onChange, max, allowButton }: { links: BrandLink[]; onChange: (l: BrandLink[]) => void; max: number; allowButton?: boolean }) {
  const set = (i: number, patch: Partial<BrandLink>) => onChange(links.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const move = (i: number, by: number) => { const l = [...links]; const [x] = l.splice(i, 1); l.splice(i + by, 0, x!); onChange(l); };
  return (
    <>
      <div className="brand-links">
        {links.map((l, i) => {
          const builtIn = Object.hasOwn(PAGE_TARGETS, l.href);
          return (
            <div key={l.id} className={`brand-link ${l.visible ? '' : 'hidden-link'}`}>
              <input aria-label="Label" maxLength={40} value={l.label} onChange={(e) => set(i, { label: e.target.value })} placeholder="Label" />
              <select aria-label="Goes to" value={builtIn ? l.href : 'external'} onChange={(e) => set(i, { href: e.target.value === 'external' ? 'https://' : e.target.value })}>
                {Object.entries(PAGE_TARGETS).map(([href, name]) => <option key={href} value={href}>{name}</option>)}
                <option value="external">Web or email address...</option>
              </select>
              {!builtIn && <input aria-label="Address" maxLength={500} value={l.href} onChange={(e) => set(i, { href: e.target.value.trim() })} placeholder="https://... or mailto:..." />}
              {allowButton && (
                <select aria-label="Style" value={l.style ?? 'link'} onChange={(e) => set(i, { style: e.target.value as 'link' | 'button' })}>
                  <option value="link">Link</option><option value="button">Button</option>
                </select>
              )}
              <label className="check small"><input type="checkbox" checked={l.visible} onChange={(e) => set(i, { visible: e.target.checked })} /> Show</label>
              <span className="brand-link-tools">
                <button type="button" className="btn btn-sm" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                <button type="button" className="btn btn-sm" aria-label="Move down" disabled={i === links.length - 1} onClick={() => move(i, 1)}>↓</button>
                <button type="button" className="btn btn-sm" aria-label="Delete" onClick={() => onChange(links.filter((_, j) => j !== i))}>✕</button>
              </span>
            </div>
          );
        })}
      </div>
      <button type="button" className="btn btn-sm" disabled={links.length >= max} onClick={() => onChange([...links, { id: newId(), label: 'New link', href: '/videos', style: allowButton ? 'link' : undefined, visible: true }])}>Add link</button>
    </>
  );
}

// ---------- tabs ----------
function IdentityTab({ b, edit, onError }: EditProps & { onError: (t: string) => void }) {
  return (
    <>
      <Section title="Site name and header logo">
        <Text label="Site name" required max={60} value={b.identity.siteName} onChange={(v) => edit((d) => { d.identity.siteName = v; })} hint="Browser tab titles and link previews." />
        <Text label="Text next to the logo" max={40} value={b.identity.brandSubtitle} onChange={(v) => edit((d) => { d.identity.brandSubtitle = v; })} hint="Leave empty to show the logo only." />
        <AssetField kind="logo" label="Header logo" value={b.assets.logo} onChange={(a) => edit((d) => { d.assets.logo = a; })} onError={onError} />
        <Text label="Logo description for screen readers" required max={100} value={b.identity.logoAlt} onChange={(v) => edit((d) => { d.identity.logoAlt = v; })} hint="Usually the company name." />
        <label className="field"><span>Logo height: {b.identity.logoHeight} px</span>
          <input type="range" min={20} max={80} value={b.identity.logoHeight} onChange={(e) => edit((d) => { d.identity.logoHeight = Number(e.target.value); })} />
        </label>
      </Section>
      <Section title="Favicon and app icons" help="The favicon is the small icon in browser tabs and bookmarks. It is also used by the admin portal.">
        <AssetField kind="favicon" label="Favicon" value={b.assets.favicon} onChange={(a) => edit((d) => { d.assets.favicon = a; })} onError={onError} />
        <AssetField kind="touchIcon" label="Phone home-screen icon" value={b.assets.touchIcon} onChange={(a) => edit((d) => { d.assets.touchIcon = a; })} onError={onError} />
      </Section>
      <Section title="Link previews and search engines">
        <AssetField kind="socialImage" label="Link-preview image" value={b.assets.socialImage} onChange={(a) => edit((d) => { d.assets.socialImage = a; })} onError={onError} />
        <Text label="Site description" rows={3} max={300} value={b.seo.description} onChange={(v) => edit((d) => { d.seo.description = v; })} hint="Shown by search engines and link previews. About 150 characters works best." />
      </Section>
    </>
  );
}

function ColorsTab({ b, edit, defaults }: EditProps & { defaults: Branding }) {
  const checks = useMemo(() => contrastChecks(b.colors), [b.colors]);
  return (
    <>
      <Section title="Colours" help="Pick a colour or type a #rrggbb value.">
        <div className="brand-colors">
          {COLOR_FIELDS.map((f) => (
            <div key={f.key} className="brand-color">
              <input type="color" aria-label={f.label} value={b.colors[f.key]} onChange={(e) => edit((d) => { d.colors[f.key] = e.target.value; })} />
              <div>
                <strong>{f.label}</strong>
                <input className="hex" aria-label={`${f.label} hex value`} maxLength={7} value={b.colors[f.key]}
                  onChange={(e) => { const v = e.target.value.trim(); if (/^#[0-9a-fA-F]{0,6}$/.test(v)) edit((d) => { d.colors[f.key] = v.length === 7 ? v.toLowerCase() : v; }); }} />
                <span className="hint">{f.hint}{b.colors[f.key] !== defaults.colors[f.key] && <> · <button type="button" className="link" onClick={() => edit((d) => { d.colors[f.key] = defaults.colors[f.key]; })}>reset</button></>}</span>
              </div>
            </div>
          ))}
        </div>
      </Section>
      <Section title="Readability check (WCAG 2.1 AA)" help="Normal text needs a contrast ratio of at least 4.5:1, large headings 3:1. Low contrast makes the site hard to read and fails accessibility requirements.">
        <table className="table">
          <thead><tr><th>Where</th><th>Sample</th><th>Ratio</th><th>Result</th></tr></thead>
          <tbody>
            {checks.map((c) => {
              const valid = /^#[0-9a-f]{6}$/i.test(c.fg) && /^#[0-9a-f]{6}$/i.test(c.bg);
              return (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td><span className="contrast-sample" style={{ color: c.fg, background: c.bg }}>Aa</span></td>
                  <td>{valid ? `${c.ratio.toFixed(1)}:1` : '-'}</td>
                  <td>{valid && (c.ratio >= c.min ? <span className="tag tag-active">Pass</span> : <span className="tag tag-danger">Below {c.min}:1</span>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
    </>
  );
}

function FontPicker({ label, value, onChange, onError }: { label: string; value: FontChoice; onChange: (f: FontChoice) => void; onError: (t: string) => void }) {
  return (
    <div className="brand-font">
      <h3>{label}</h3>
      <div className="row2">
        <label className="field"><span>Source</span>
          <select value={value.source} onChange={(e) => {
            const s = e.target.value as FontChoice['source'];
            onChange(s === 'google' ? { source: 'google', family: 'Red Hat Display' } : s === 'system' ? { source: 'system', family: 'system-sans' } : { source: 'upload', family: 'Brand Font', file: undefined as unknown as BrandAsset });
          }}>
            <option value="google">Google Fonts</option>
            <option value="upload">Upload a font file (self-hosted)</option>
            <option value="system">Device default fonts</option>
          </select>
        </label>
        {value.source === 'google' && (
          <label className="field"><span>Font</span>
            <select value={value.family} onChange={(e) => onChange({ source: 'google', family: e.target.value })}>
              {GOOGLE_FONTS.map((f) => <option key={f}>{f}</option>)}
            </select>
          </label>
        )}
        {value.source === 'system' && (
          <label className="field"><span>Style</span>
            <select value={value.family} onChange={(e) => onChange({ source: 'system', family: e.target.value as keyof typeof SYSTEM_FONTS })}>
              <option value="system-sans">Sans-serif (Segoe UI, San Francisco, Roboto)</option>
              <option value="system-serif">Serif (Georgia, Times)</option>
            </select>
          </label>
        )}
        {value.source === 'upload' && (
          <label className="field"><span>Font name</span>
            <input maxLength={40} value={value.family} onChange={(e) => onChange({ ...value, family: e.target.value.replace(/[^A-Za-z0-9 -]/g, '') })} />
          </label>
        )}
      </div>
      {value.source === 'upload' && (
        <>
          <AssetField kind="font" label="Font file" value={value.file} onChange={(a) => onChange({ ...value, file: a as BrandAsset })} onError={onError} />
          {!value.file && <p className="hint warn">Upload a WOFF2 file before saving.</p>}
        </>
      )}
      <p className="brand-font-sample" style={{ fontFamily: fontStack(value.source === 'upload' && !value.file ? { source: 'system', family: 'system-sans' } : value) }}>
        The quick brown fox jumps over the lazy dog. <strong>Bold 0123456789</strong>
      </p>
    </div>
  );
}

function FontsTab({ b, edit, onError }: EditProps & { onError: (t: string) => void }) {
  const usesGoogle = b.fonts.heading.source === 'google' || b.fonts.body.source === 'google';
  return (
    <Section title="Fonts">
      <FontPicker label="Headings" value={b.fonts.heading} onChange={(f) => edit((d) => { d.fonts.heading = f; })} onError={onError} />
      <FontPicker label="Body text" value={b.fonts.body} onChange={(f) => edit((d) => { d.fonts.body = f; })} onError={onError} />
      {usesGoogle && (
        <p className="alert small">
          <strong>Privacy:</strong> Google Fonts are loaded from Google's servers, which sends each visitor's IP address to Google. Some EU courts have treated this as a GDPR breach.
          Uploading the font files here (self-hosting) avoids it. Please confirm the approach with Privacy / Legal before go-live.
        </p>
      )}
    </Section>
  );
}

type HomeTextKey = { [K in keyof Branding['home']]: Branding['home'][K] extends string ? K : never }[keyof Branding['home']];

function HomeTab({ b, edit }: EditProps) {
  const h = b.home;
  const t = (k: HomeTextKey) => (v: string) => edit((d) => { d.home[k] = v; });
  return (
    <>
      <Section title="Hero banner">
        <Text label="Small heading above the title" max={60} value={h.eyebrow} onChange={t('eyebrow')} />
        <div className="row2">
          <Text label="Title" required max={80} value={h.heading} onChange={t('heading')} />
          <Text label="Highlighted second line" max={60} value={h.headingAccent} onChange={t('headingAccent')} hint="Shown in the accent colour." />
        </div>
        <Text label="Introduction" rows={3} max={300} value={h.lead} onChange={t('lead')} />
        <Text label="Search box placeholder" max={80} value={h.searchPlaceholder} onChange={t('searchPlaceholder')} />
        <Toggle label="Show the business line buttons" checked={h.showBusinessLines} onChange={(v) => edit((d) => { d.home.showBusinessLines = v; })} />
      </Section>
      <Section title="Sections">
        <div className="row2">
          <Text label="Featured heading" required max={60} value={h.featuredHeading} onChange={t('featuredHeading')} />
          <Text label="Latest videos heading" required max={60} value={h.latestHeading} onChange={t('latestHeading')} />
        </div>
        <div className="row2">
          <Text label="Browse all link" required max={30} value={h.browseAllLabel} onChange={t('browseAllLabel')} hint="The video count is added after it." />
          <Text label="Products heading" required max={60} value={h.productsHeading} onChange={t('productsHeading')} />
        </div>
        <Toggle label="Show the products section" checked={h.showProducts} onChange={(v) => edit((d) => { d.home.showProducts = v; })} />
      </Section>
      <Section title="Call to action band">
        <Toggle label="Show the call to action band" checked={h.showCta} onChange={(v) => edit((d) => { d.home.showCta = v; })} />
        <Text label="Heading" max={80} value={h.ctaHeading} onChange={t('ctaHeading')} />
        <Text label="Text" rows={2} max={300} value={h.ctaText} onChange={t('ctaText')} />
        <div className="row2">
          <Text label="Suggest button" required max={30} value={h.ctaSuggestLabel} onChange={t('ctaSuggestLabel')} />
          <Text label="Demo button" required max={30} value={h.ctaDemoLabel} onChange={t('ctaDemoLabel')} />
        </div>
      </Section>
    </>
  );
}

function FooterTab({ b, edit }: EditProps) {
  return (
    <>
      <Section title="Footer text">
        <Toggle label="Show a logo in the footer" checked={b.footer.showLogo} onChange={(v) => edit((d) => { d.footer.showLogo = v; })} />
        <Text label="Heading" max={60} value={b.footer.heading} onChange={(v) => edit((d) => { d.footer.heading = v; })} />
        <Text label="Text" rows={3} max={400} value={b.footer.text} onChange={(v) => edit((d) => { d.footer.text = v; })} />
        <Text label="Copyright line" max={120} value={b.footer.copyright} onChange={(v) => edit((d) => { d.footer.copyright = v; })} hint={`{year} becomes the current year: "${copyrightText(b)}".`} />
      </Section>
      <Section title="Footer links" help="Up to 10 links.">
        <LinkList links={b.footer.links} max={10} onChange={(l) => edit((d) => { d.footer.links = l; })} />
      </Section>
      <Section title="Privacy policy">
        <Text label="Privacy policy address" required max={500} value={b.legal.privacyUrl} onChange={(v) => edit((d) => { d.legal.privacyUrl = v.trim(); })} hint="Linked from the subscription consent text. Must start with https://." />
        <p className="hint">The subscription consent wording itself is fixed, because it is stored with each subscriber as a record of consent. Changes to it go through Legal / Privacy.</p>
      </Section>
    </>
  );
}

function PagesTab({ b, edit }: EditProps) {
  const p = b.pages;
  const t = (k: 'videosHeading' | 'archiveHeading' | 'subscribeHeading' | 'subscribeIntro' | 'notFoundHeading' | 'notFoundText') => (v: string) => edit((d) => { d.pages[k] = v; });
  const form = (k: 'contact' | 'suggest' | 'demo', name: string) => (
    <Section title={name}>
      <div className="row2">
        <Text label="Title (also the tab name)" required max={60} value={p[k].title} onChange={(v) => edit((d) => { d.pages[k].title = v; })} />
        <Text label="Button" required max={30} value={p[k].button} onChange={(v) => edit((d) => { d.pages[k].button = v; })} />
      </div>
      <Text label="Introduction" rows={2} max={300} value={p[k].intro} onChange={(v) => edit((d) => { d.pages[k].intro = v; })} />
    </Section>
  );
  return (
    <>
      <Section title="Video lists">
        <div className="row2">
          <Text label="All videos heading" required max={60} value={p.videosHeading} onChange={t('videosHeading')} />
          <Text label="Archive heading" required max={60} value={p.archiveHeading} onChange={t('archiveHeading')} />
        </div>
      </Section>
      <Section title="Subscribe page">
        <Text label="Heading" required max={80} value={p.subscribeHeading} onChange={t('subscribeHeading')} />
        <Text label="Introduction" rows={3} max={400} value={p.subscribeIntro} onChange={t('subscribeIntro')} />
      </Section>
      {form('contact', 'Contact form')}
      {form('suggest', 'Suggest a video form')}
      {form('demo', 'Request a demo form')}
      <Section title="Page not found">
        <Text label="Heading" required max={80} value={p.notFoundHeading} onChange={t('notFoundHeading')} />
        <Text label="Text" rows={2} max={300} value={p.notFoundText} onChange={t('notFoundText')} />
      </Section>
    </>
  );
}

function HistoryTab({ state, busy, onRestore, onReset }: { state: BrandingState; busy: boolean; onRestore: (v: number) => void; onReset: () => void }) {
  const rows = [...(state.current ? [{ ...state.current, live: true }] : []), ...state.history.map((h) => ({ ...h, live: false }))];
  return (
    <Section title="Published versions" help="The last 20 published versions are kept. Restoring copies a version into the draft; it goes live when you publish.">
      {!rows.length ? <p className="muted">Nothing has been published yet. The site uses the Tungsten default branding.</p> : (
        <table className="table">
          <thead><tr><th>Version</th><th>Published</th><th>Note</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.version}>
                <td>{r.version} {r.live && <span className="tag tag-active">Live</span>}</td>
                <td className="small">{fmtDate(r.publishedAt)} by {r.publishedBy}</td>
                <td className="small">{r.note ?? <span className="muted">-</span>}</td>
                <td><button type="button" className="link" disabled={busy} onClick={() => onRestore(r.version)}>Restore to draft</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p><button type="button" className="btn btn-sm" onClick={onReset}>Reset to Tungsten default branding</button></p>
    </Section>
  );
}

// ---------- preview ----------
function useFonts(b: Branding) {
  const gf = googleFontsUrl(b);
  useEffect(() => {
    let link = document.getElementById('brand-preview-fonts') as HTMLLinkElement | null;
    if (!gf) { link?.remove(); return; }
    if (!link) { link = document.createElement('link'); link.id = 'brand-preview-fonts'; link.rel = 'stylesheet'; document.head.appendChild(link); }
    link.href = gf;
  }, [gf]);
  const uploads = [b.fonts.heading, b.fonts.body].flatMap((f) => (f.source === 'upload' && f.file ? [`${f.family}|${f.file.file}`] : [])).join(',');
  useEffect(() => {
    for (const u of uploads.split(',').filter(Boolean)) {
      const [family, file] = u.split('|') as [string, string];
      const face = new FontFace(family, `url(/brand/${file}) format("woff2")`, { weight: '100 900' });
      face.load().then((f) => document.fonts.add(f)).catch(() => undefined);
    }
  }, [uploads]);
}

function MiniPreview({ b }: { b: Branding }) {
  useFonts(b);
  const c = b.colors;
  const vars = {
    '--p': c.primary, '--pd': c.primaryDeep, '--s': c.secondary, '--a': c.accent, '--ad': c.accentDark, '--as': c.accentSoft,
    '--t': c.text, '--m': c.muted, '--ml': c.mutedLight, '--bd': c.border, '--bg': c.background, '--sf': c.surface,
    '--fb': fontStack(b.fonts.body.source === 'upload' && !b.fonts.body.file ? { source: 'system', family: 'system-sans' } : b.fonts.body),
    '--fh': fontStack(b.fonts.heading.source === 'upload' && !b.fonts.heading.file ? { source: 'system', family: 'system-sans' } : b.fonts.heading),
  } as CSSProperties;
  const logo = b.assets.logo ? brandAssetUrl(b.assets.logo) : '/logo.png';
  const footerLogo = b.assets.footerLogo ? brandAssetUrl(b.assets.footerLogo) : logo;
  return (
    <div className="bp" style={vars} aria-label="Preview of the public site">
      <div className="bp-tab">
        {b.assets.favicon ? <img src={brandAssetUrl(b.assets.favicon)} alt="" /> : <img src="/favicon.svg" alt="" />}
        <span>{b.identity.siteName}</span>
      </div>
      <div className="bp-header">
        <img src={logo} alt={b.identity.logoAlt} style={{ height: Math.round(b.identity.logoHeight * 0.6) }} />
        {b.identity.brandSubtitle && <span className="bp-sub">{b.identity.brandSubtitle}</span>}
        <span className="bp-nav">
          {b.header.menu.filter((l) => l.visible).map((l) => <span key={l.id} className={l.style === 'button' ? 'bp-btn' : ''}>{l.label}</span>)}
        </span>
      </div>
      <div className="bp-hero">
        {b.home.eyebrow && <div className="bp-eyebrow">{b.home.eyebrow}</div>}
        <div className="bp-h1">{b.home.heading}{b.home.headingAccent && <><br /><span>{b.home.headingAccent}</span></>}</div>
        {b.home.lead && <p>{b.home.lead}</p>}
        <div className="bp-search"><span>{b.home.searchPlaceholder}</span><span className="bp-btn">Search</span></div>
      </div>
      <div className="bp-body">
        <div className="bp-h2">{b.home.latestHeading} <span className="bp-link">{b.home.browseAllLabel} →</span></div>
        <div className="bp-cards">
          {[1, 2].map((i) => (
            <div key={i} className="bp-card"><div className="bp-thumb" /><span className="bp-chip">Product</span><strong>Example video title</strong><small>Short description text</small></div>
          ))}
        </div>
      </div>
      <div className="bp-footer">
        {b.footer.showLogo && <img src={footerLogo} alt="" />}
        {b.footer.heading && <strong>{b.footer.heading}</strong>}
        <span>{b.footer.links.filter((l) => l.visible).map((l) => l.label).join(' · ')}</span>
        <small>{copyrightText(b)}</small>
      </div>
    </div>
  );
}
