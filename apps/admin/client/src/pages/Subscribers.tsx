import { useEffect, useMemo, useState } from 'react';
import { api, fmtDate, type Subscriber } from '../api';

export default function Subscribers() {
  const [subs, setSubs] = useState<Subscriber[]>();
  const [q, setQ] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api.get<Subscriber[]>('/api/subscribers').then(setSubs).catch((e: Error) => setErr(e.message)); }, []);
  const list = useMemo(() => (subs ?? []).filter((s) => !q || s.email.includes(q.toLowerCase())), [subs, q]);

  const remove = async (s: Subscriber) => {
    if (!confirm(`Permanently delete ${s.email}? Use this for erasure requests. It cannot be undone.`)) return;
    await api.send('DELETE', `/api/subscribers/${s.id}`);
    setSubs((cur) => cur?.filter((x) => x.id !== s.id));
  };

  const confirmed = subs?.filter((s) => s.status === 'confirmed').length ?? 0;
  return (
    <>
      <div className="page-head">
        <div><h1>Subscribers</h1><p className="muted">{subs ? `${confirmed} confirmed · ${subs.length} total` : 'Loading...'}</p></div>
        <a className="btn" href="/api/subscribers.csv">Export confirmed (CSV)</a>
      </div>
      <p className="hint">This is personal data. Export only when needed, store exports securely and delete them afterwards. Handle access or erasure requests with Legal / Privacy.</p>
      {err && <p className="alert">{err}</p>}
      <div className="toolbar"><input type="search" placeholder="Find email..." value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Email</th><th>Status</th><th>Interests</th><th>Signed up</th><th /></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td>{s.email}</td>
                <td><span className={`tag tag-${s.status}`}>{s.status}</span></td>
                <td className="small">{s.products.length ? s.products.join(', ') : 'All products'}</td>
                <td className="small muted">{fmtDate(s.createdAt)}</td>
                <td><button className="link danger" onClick={() => remove(s)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
