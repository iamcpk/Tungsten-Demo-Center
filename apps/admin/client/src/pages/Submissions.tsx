import { useEffect, useState } from 'react';
import { api, fmtDate, type Submission } from '../api';

const TYPE: Record<string, string> = { contact: 'Contact', suggest: 'Video suggestion', demo: 'Demo request' };

export default function Submissions() {
  const [items, setItems] = useState<Submission[]>();
  const [filter, setFilter] = useState<'new' | 'all'>('new');
  const [err, setErr] = useState('');
  useEffect(() => { api.get<Submission[]>('/api/submissions').then(setItems).catch((e: Error) => setErr(e.message)); }, []);

  const mark = async (s: Submission, status: Submission['status']) => {
    const u = await api.send<Submission>('PATCH', `/api/submissions/${s.id}`, { status });
    setItems((cur) => cur?.map((x) => (x.id === u.id ? u : x)));
  };
  const remove = async (s: Submission) => {
    if (!confirm('Permanently delete this submission? It cannot be undone.')) return;
    await api.send('DELETE', `/api/submissions/${s.id}`);
    setItems((cur) => cur?.filter((x) => x.id !== s.id));
  };

  const shown = (items ?? []).filter((s) => filter === 'all' || s.status === 'new');
  return (
    <>
      <div className="page-head">
        <div><h1>Form inbox</h1><p className="muted">Contact, suggestion and demo requests from the public site. Each one is also emailed to the team mailbox.</p></div>
        <div className="seg small-seg">
          <label className={filter === 'new' ? 'on' : ''}><input type="radio" checked={filter === 'new'} onChange={() => setFilter('new')} />New</label>
          <label className={filter === 'all' ? 'on' : ''}><input type="radio" checked={filter === 'all'} onChange={() => setFilter('all')} />All</label>
        </div>
      </div>
      {err && <p className="alert">{err}</p>}
      <div className="stack">
        {shown.map((s) => (
          <article key={s.id} className={`panel submission ${s.status}`}>
            <header>
              <span className="tag">{TYPE[s.type] ?? s.type}</span>
              <strong>{s.name}</strong>
              <a href={`mailto:${encodeURIComponent(s.email)}`}>{s.email}</a>
              {s.company && <span className="muted">{s.company}</span>}
              {s.product && <span className="muted">· {s.product}</span>}
              <span className="muted small push">{fmtDate(s.createdAt)}</span>
            </header>
            <p className="msg">{s.message}</p>
            <footer>
              {s.status === 'new' ? <button className="btn btn-sm" onClick={() => mark(s, 'handled')}>Mark handled</button> : <button className="btn btn-sm" onClick={() => mark(s, 'new')}>Reopen</button>}
              <button className="link danger" onClick={() => remove(s)}>Delete</button>
            </footer>
          </article>
        ))}
        {items && !shown.length && <p className="muted">Nothing here.</p>}
      </div>
    </>
  );
}
