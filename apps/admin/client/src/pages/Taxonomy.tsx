import { useEffect, useState } from 'react';
import { api, type Taxonomy } from '../api';
import { TagInput } from '../components/TagInput';
import { useMe } from '../App';

const LISTS: { key: keyof Taxonomy; label: string; hint: string }[] = [
  { key: 'products', label: 'Products', hint: 'Public product filter and subscription interests.' },
  { key: 'categories', label: 'Categories', hint: 'e.g. Product Overview Demos, Power PDF Quick Tips.' },
  { key: 'verticals', label: 'Industries', hint: 'Industry / vertical filter.' },
  { key: 'languages', label: 'Languages', hint: 'Spoken language or caption language, e.g. German (CC).' },
  { key: 'authors', label: 'Presenters', hint: 'Suggested names in the editor. New names can also be typed on a video.' },
];

export default function TaxonomyPage() {
  const { canApprove } = useMe();
  const [t, setT] = useState<Taxonomy>();
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.get<Taxonomy>('/api/taxonomy').then(setT).catch((e: Error) => setErr(e.message)); }, []);
  if (!t) return <p className="muted">{err || 'Loading...'}</p>;

  const save = async () => {
    setMsg(''); setErr('');
    try { setT(await api.send<Taxonomy>('PUT', '/api/taxonomy', t)); setMsg('Saved.'); }
    catch (e) { setErr((e as Error).message); }
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Lists &amp; tags</h1><p className="muted">Controlled values used across videos and public filters. Removing a value here doesn't change videos that already use it.</p></div>
        {canApprove && <button className="btn btn-primary" onClick={save}>Save lists</button>}
      </div>
      {!canApprove && <p className="notice">These lists drive the public site's filters, so only approvers and administrators can change them. Ask one of them to add a missing value.</p>}
      {msg && <p className="notice">{msg}</p>}
      {err && <p className="alert">{err}</p>}
      <div className="stack">
        {LISTS.map((l) => (
          <section className="panel" key={l.key}>
            <h2>{l.label} <span className="muted small">({(t[l.key] as string[]).length})</span></h2>
            <p className="hint">{l.hint}</p>
            {canApprove
              ? <TagInput value={t[l.key] as string[]} onChange={(v) => setT({ ...t, [l.key]: v })} placeholder={`Add ${l.label.toLowerCase()}`} />
              : <div className="tags">{(t[l.key] as string[]).map((v) => <span key={v} className="tag-pill">{v}</span>)}</div>}
          </section>
        ))}
      </div>
    </>
  );
}
