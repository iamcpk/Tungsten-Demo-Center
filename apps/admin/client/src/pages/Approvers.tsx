import { useEffect, useState } from 'react';
import { api, fmtDate, type Approver } from '../api';

/** Administrators maintain who may approve videos for the public site. */
export default function Approvers() {
  const [people, setPeople] = useState<Approver[]>();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.get<Approver[]>('/api/approvers').then(setPeople).catch((e: Error) => setMsg({ kind: 'err', text: e.message })); }, []);

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(undefined);
    try {
      setPeople(await api.send<Approver[]>('POST', '/api/approvers', { email, name: name || undefined }));
      setMsg({ kind: 'ok', text: `${email} can now approve videos.` });
      setEmail('');
      setName('');
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Approver) => {
    if (!confirm(`Remove approval rights from ${p.name ?? p.email}? They keep their normal access to the portal.`)) return;
    try {
      setPeople(await api.send<Approver[]>('DELETE', `/api/approvers/${encodeURIComponent(p.email)}`));
      setMsg({ kind: 'ok', text: `${p.email} is no longer an approver.` });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvers</h1>
          <p className="muted">People who can approve videos for the public site, in addition to administrators. Approvers are emailed when a video is submitted for approval.</p>
        </div>
      </div>
      {msg && <p className={msg.kind === 'ok' ? 'notice' : 'alert'} role="status">{msg.text}</p>}

      <section className="panel">
        <h2>Add an approver</h2>
        <form className="inline-form" onSubmit={add}>
          <label className="field"><span>Sign-in email</span><input type="email" required maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" /></label>
          <label className="field"><span>Name (optional)</span><input maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Adding...' : 'Add approver'}</button>
        </form>
        <p className="hint">Use the address they sign in with. They also need a role on the Demo Center admin app in Entra ID (Content Creator is enough) so they can sign in at all.</p>
      </section>

      <section className="panel">
        <h2>Current approvers <span className="muted small">({people?.length ?? 0})</span></h2>
        {!people ? <p className="muted">Loading...</p> : !people.length ? (
          <p className="muted">No approvers yet. Until you add some, only administrators can approve videos, and no one is emailed when a video is submitted.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Name</th><th>Email</th><th>Added</th><th /></tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.email}>
                    <td>{p.name ?? <span className="muted">Not set</span>}</td>
                    <td className="small">{p.email}</td>
                    <td className="small muted">{fmtDate(p.addedAt)} by {p.addedBy}</td>
                    <td><button type="button" className="link danger" onClick={() => remove(p)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
