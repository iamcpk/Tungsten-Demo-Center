import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtBytes, fmtDate } from '../api';

type Key = string;
interface Component { key: Key; label: string; description: string; group: string; kind: 'data' | 'files'; defaultOn: boolean; personalData?: boolean; pairsWith?: Key[] }
interface ComponentSummary { kind: 'data' | 'files'; items: number; bytes: number }
type Trigger = 'manual' | 'nightly' | 'pre-restore' | 'uploaded' | 'imported';
interface BackupSummary {
  id: string; state: 'complete' | 'running' | 'failed' | 'interrupted'; trigger: Trigger; createdAt: string; createdBy: string; note?: string; bytes: number;
  components: Record<Key, ComponentSummary> | Key[]; error?: string; source?: { publicSiteUrl: string };
}
interface Job { kind: 'backup' | 'restore' | 'import'; backupId: string; by: string; startedAt: string; phase: string; done: number; total: number; finishedAt?: string; error?: string; result?: string }
interface Settings { nightly: boolean; hourUtc: number; keep: number; components: Key[]; updatedAt?: string; updatedBy?: string }
interface State { backups: BackupSummary[]; job?: Job; settings: Settings; components: Component[] }
type Estimate = Record<Key, { items: number; bytes: number }>;

const TRIGGER_LABEL: Record<Trigger, string> = { manual: 'Manual', nightly: 'Nightly', 'pre-restore': 'Safety copy before restore', uploaded: 'Uploaded file', imported: 'Imported' };
const JOB_LABEL = { backup: 'Backup', restore: 'Restore', import: 'Import' } as const;

function when(iso: string) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${fmtDate(iso)}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}
const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;
const sizeOf = (bytes: number) => fmtBytes(bytes) || '0 B';

/** Grouped tick boxes for site components. */
function ComponentPicker({ components, selected, onChange, info, only }: {
  components: Component[]; selected: Set<Key>; onChange: (next: Set<Key>) => void;
  info?: (c: Component) => string | undefined; only?: Set<Key>;
}) {
  const shown = components.filter((c) => !only || only.has(c.key));
  const groups = [...new Set(shown.map((c) => c.group))];
  const toggle = (k: Key, on: boolean) => { const n = new Set(selected); if (on) n.add(k); else n.delete(k); onChange(n); };
  return (
    <div className="bk-groups">
      {groups.map((g) => (
        <fieldset key={g} className="bk-group">
          <legend>{g}</legend>
          {shown.filter((c) => c.group === g).map((c) => (
            <label key={c.key} className="bk-item">
              <input type="checkbox" checked={selected.has(c.key)} onChange={(e) => toggle(c.key, e.target.checked)} />
              <span>
                <strong>{c.label}</strong>
                {c.personalData && <span className="tag tag-pd">Personal data</span>}
                {info?.(c) && <span className="muted small bk-count">{info(c)}</span>}
                <span className="muted small bk-desc">{c.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ))}
    </div>
  );
}

/** Warnings for selections that leave broken links or include personal data. */
function selectionWarnings(components: Component[], selected: Set<Key>, verb: string) {
  const out: string[] = [];
  const label = (k: Key) => components.find((c) => c.key === k)?.label ?? k;
  for (const c of components) {
    if (!selected.has(c.key) || !c.pairsWith) continue;
    const missing = c.pairsWith.filter((p) => !selected.has(p) && components.some((x) => x.key === p));
    if (c.key === 'videos' && missing.length) out.push(`${label('videos')} without ${missing.map(label).join(', ')}: pages may show missing images or files if those aren't already on the target site.`);
    if (c.key === 'branding' && missing.includes('brandFiles')) out.push(`Branding settings without Branding files: uploaded logos or fonts may be missing.`);
  }
  const pd = components.filter((c) => c.personalData && selected.has(c.key)).map((c) => c.label);
  if (pd.length) out.push(`You're about to ${verb} personal data (${pd.join(', ')}). Keep backups only as long as needed, and check retention with Legal/Compliance.`);
  return out;
}

export default function BackupPage() {
  const [state, setState] = useState<State>();
  const [estimate, setEstimate] = useState<Estimate>();
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [sel, setSel] = useState<Set<Key>>(new Set());
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [restoreOf, setRestoreOf] = useState<BackupSummary>();
  const poll = useRef<ReturnType<typeof setInterval>>(undefined);

  const load = useCallback(async () => {
    try {
      const s = await api.get<State>('/api/backups');
      setState(s);
      setSel((cur) => (cur.size ? cur : new Set(s.components.filter((c) => c.defaultOn).map((c) => c.key))));
      return s;
    } catch (e) { setError((e as Error).message); return undefined; }
  }, []);

  useEffect(() => {
    void load();
    api.get<Estimate>('/api/backups/estimate').then(setEstimate).catch(() => undefined);
    return () => clearInterval(poll.current);
  }, [load]);

  const running = !!state?.job && !state.job.finishedAt;
  // While a job runs, check its progress every 2 seconds and reload the list when it ends.
  useEffect(() => {
    clearInterval(poll.current);
    if (!running) return;
    poll.current = setInterval(async () => {
      try {
        const { job } = await api.get<{ job: Job | null }>('/api/backups/job');
        if (!job || job.finishedAt) { clearInterval(poll.current); void load(); return; }
        setState((s) => (s ? { ...s, job } : s));
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(poll.current);
  }, [running, load]);

  const components = state?.components ?? [];
  const warnings = useMemo(() => selectionWarnings(components, sel, 'back up'), [components, sel]);
  const selectedSize = estimate ? [...sel].reduce((n, k) => n + (estimate[k]?.bytes ?? 0), 0) : undefined;

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    setBusy(true); setError(''); setMsg('');
    try { await fn(); if (ok) setMsg(ok); await load(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (!state) return <>{error ? <p className="alert">{error}</p> : <p className="muted">Loading...</p>}</>;
  const job = state.job;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Backup &amp; restore</h1>
          <p className="muted">Back up the whole site or chosen parts, restore them here, or move the site to a new Azure instance. Backups are kept in private storage; only Administrators can see them.</p>
        </div>
      </div>

      {error && <p className="alert">{error}</p>}
      {msg && <p className="notice" role="status">{msg}</p>}

      {job && (
        <section className={`panel bk-job ${job.error ? 'bk-job-err' : job.finishedAt ? 'bk-job-ok' : ''}`} aria-live="polite">
          <div className="bk-job-head">
            <strong>{JOB_LABEL[job.kind]} {job.finishedAt ? (job.error ? 'failed' : 'finished') : 'in progress'}</strong>
            <span className="muted small">Started {when(job.startedAt)} by {job.by}</span>
          </div>
          {!job.finishedAt && (
            <>
              <div className="bk-bar" role="progressbar" aria-valuemin={0} aria-valuemax={job.total} aria-valuenow={job.done}>
                <span style={{ width: `${job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 5}%` }} />
              </div>
              <p className="small">{job.phase} ({job.done.toLocaleString('en-US')} of {job.total.toLocaleString('en-US')})</p>
              <p className="muted small">You can leave this page; the job keeps running on the server.</p>
            </>
          )}
          {job.result && <p className="small">{job.result}</p>}
          {job.error && <p className="small">{job.error}</p>}
        </section>
      )}

      <section className="panel">
        <h2>Create a backup</h2>
        <p className="hint">Tick the parts of the site to include. Files are copied inside Azure Storage, so large backups don't pass through your browser.</p>
        <div className="actions">
          <button type="button" className="btn btn-sm" onClick={() => setSel(new Set(components.filter((c) => c.defaultOn).map((c) => c.key)))}>Recommended</button>
          <button type="button" className="btn btn-sm" onClick={() => setSel(new Set(components.map((c) => c.key)))}>Everything</button>
          <button type="button" className="btn btn-sm" onClick={() => setSel(new Set())}>None</button>
        </div>
        <ComponentPicker components={components} selected={sel} onChange={setSel}
          info={(c) => (estimate?.[c.key] ? `${plural(estimate[c.key].items, c.kind === 'data' ? 'item' : 'file')} · ${sizeOf(estimate[c.key].bytes)}` : undefined)} />
        {warnings.map((w) => <p key={w} className="hint warn">{w}</p>)}
        <label className="field">
          <span>Note (optional)</span>
          <input value={note} maxLength={300} placeholder="For example: before the March content refresh" onChange={(e) => setNote(e.target.value)} />
        </label>
        <div className="actions">
          <button type="button" className="btn btn-primary" disabled={busy || running || !sel.size}
            onClick={() => run(async () => { await api.send('POST', '/api/backups', { components: [...sel], note: note.trim() || undefined }); setNote(''); }, 'Backup started.')}>
            Back up now
          </button>
          {selectedSize !== undefined && <span className="muted small">About {sizeOf(selectedSize)} selected</span>}
        </div>
      </section>

      {restoreOf && (
        <RestorePanel backup={restoreOf} components={components} disabled={busy || running}
          onCancel={() => setRestoreOf(undefined)}
          onRestore={(parts, mode) => run(async () => {
            const r = await api.send<{ safetyBackupId: string }>('POST', `/api/backups/${restoreOf.id}/restore`, { components: parts, mode, confirm: 'RESTORE' });
            setRestoreOf(undefined);
            setMsg(`Restore started. A safety backup (${r.safetyBackupId}) is taken first, so you can undo it.`);
          })} />
      )}

      <section className="panel">
        <h2>Backups</h2>
        {!state.backups.length ? <p className="muted">No backups yet.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Date</th><th>Type</th><th>Contents</th><th>Size</th><th>Status</th><th /></tr></thead>
              <tbody>
                {state.backups.map((b) => {
                  const parts = Array.isArray(b.components) ? b.components : Object.keys(b.components);
                  const hasData = !Array.isArray(b.components) && Object.values(b.components).some((c) => c.kind === 'data');
                  return (
                    <tr key={b.id}>
                      <td className="small">
                        <strong>{when(b.createdAt)}</strong>
                        <div className="muted">{b.createdBy}</div>
                        <div className="muted bk-id">{b.id}</div>
                      </td>
                      <td className="small">{TRIGGER_LABEL[b.trigger] ?? b.trigger}{b.note && <div className="muted">{b.note}</div>}</td>
                      <td className="small">{parts.map((k) => components.find((c) => c.key === k)?.label ?? k).join(', ')}</td>
                      <td className="small">{b.state === 'complete' ? sizeOf(b.bytes) : ''}</td>
                      <td>
                        <span className={`tag ${b.state === 'complete' ? 'tag-active' : b.state === 'running' ? 'tag-pending' : 'tag-err'}`}>
                          {b.state === 'complete' ? 'Complete' : b.state === 'running' ? 'Running' : b.state === 'failed' ? 'Failed' : 'Interrupted'}
                        </span>
                        {b.error && <div className="muted small">{b.error}</div>}
                      </td>
                      <td className="bk-actions">
                        {b.state === 'complete' && <button type="button" className="btn btn-sm" disabled={running} onClick={() => setRestoreOf(b)}>Restore...</button>}
                        {b.state === 'complete' && hasData && <a className="btn btn-sm" href={`/api/backups/${b.id}/download`} download>Download data</a>}
                        {b.state !== 'running' && (
                          <button type="button" className="btn btn-sm btn-danger" disabled={busy}
                            onClick={() => { if (confirm(`Permanently delete backup ${b.id}? This cannot be undone.`)) void run(() => api.send('DELETE', `/api/backups/${b.id}`), 'Backup deleted.'); }}>
                            Delete
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="hint">Nightly backups beyond the number you keep, and safety copies beyond the last 10, are deleted automatically. Manual and imported backups are kept until you delete them.</p>
      </section>

      <NightlyPanel settings={state.settings} components={components} disabled={busy}
        onSave={(s) => run(() => api.send('PUT', '/api/backups/settings', s), 'Nightly backup settings saved.')} />

      <MovePanel disabled={busy || running}
        onImport={(containerUrl, backupId) => run(() => api.send('POST', '/api/backups/import', { containerUrl, backupId }), 'Import started. It appears in the list when it finishes.')}
        onUpload={(file) => run(async () => { const fd = new FormData(); fd.append('file', file); const r = await api.upload<{ id: string }>('/api/backups/upload', fd); setMsg(`Uploaded as ${r.id}. Use Restore... on it to apply it.`); })} />
    </>
  );
}

function RestorePanel({ backup, components, disabled, onCancel, onRestore }: {
  backup: BackupSummary; components: Component[]; disabled: boolean;
  onCancel: () => void; onRestore: (parts: Key[], mode: 'merge' | 'replace') => void;
}) {
  const inBackup = backup.components as Record<Key, ComponentSummary>;
  const available = new Set(Object.keys(inBackup));
  // Personal data is never restored unless ticked on purpose.
  const [sel, setSel] = useState<Set<Key>>(new Set(components.filter((c) => available.has(c.key) && !c.personalData).map((c) => c.key)));
  const [mode, setMode] = useState<'merge' | 'replace'>('merge');
  const [confirmText, setConfirmText] = useState('');
  const shown = components.filter((c) => available.has(c.key));
  const warnings = selectionWarnings(shown, sel, 'restore');
  return (
    <section className="panel bk-restore">
      <h2>Restore from {when(backup.createdAt)}</h2>
      <p className="muted small">{backup.id}{backup.source?.publicSiteUrl ? ` · made on ${backup.source.publicSiteUrl}` : ''}</p>
      <p className="hint">Content is stored with relative paths, so a backup made on another site address or Azure instance restores correctly here.</p>
      <ComponentPicker components={components} selected={sel} onChange={setSel} only={available}
        info={(c) => (inBackup[c.key] ? `${plural(inBackup[c.key].items, c.kind === 'data' ? 'item' : 'file')} · ${sizeOf(inBackup[c.key].bytes)}` : undefined)} />
      <fieldset className="bk-mode">
        <legend>How to restore</legend>
        <label className="bk-item">
          <input type="radio" name="mode" checked={mode === 'merge'} onChange={() => setMode('merge')} />
          <span><strong>Merge</strong><span className="muted small bk-desc">Add and overwrite items from the backup. Anything added since the backup is kept.</span></span>
        </label>
        <label className="bk-item">
          <input type="radio" name="mode" checked={mode === 'replace'} onChange={() => setMode('replace')} />
          <span><strong>Replace</strong><span className="muted small bk-desc">Make the ticked parts exactly match the backup. Items and files added since the backup are deleted.</span></span>
        </label>
      </fieldset>
      {warnings.map((w) => <p key={w} className="hint warn">{w}</p>)}
      <p className="hint">
        Before anything changes, a safety backup of the ticked parts is taken automatically, so you can undo this restore.
        Subscribers who unsubscribed after the backup stay unsubscribed. The public site shows restored content within about a minute.
      </p>
      <label className="field">
        <span>Type RESTORE to confirm</span>
        <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
      </label>
      <div className="actions">
        <button type="button" className={`btn ${mode === 'replace' ? 'btn-danger' : 'btn-primary'}`} disabled={disabled || !sel.size || confirmText !== 'RESTORE'}
          onClick={() => onRestore([...sel], mode)}>
          {mode === 'replace' ? 'Replace with backup' : 'Merge from backup'}
        </button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </section>
  );
}

function NightlyPanel({ settings, components, disabled, onSave }: { settings: Settings; components: Component[]; disabled: boolean; onSave: (s: Settings) => void }) {
  const [s, setS] = useState(settings);
  useEffect(() => setS(settings), [settings]);
  const sel = new Set(s.components);
  return (
    <section className="panel">
      <h2>Nightly backup</h2>
      <label className="check"><input type="checkbox" checked={s.nightly} onChange={(e) => setS({ ...s, nightly: e.target.checked })} /> Back up automatically every night</label>
      <div className="bk-row">
        <label className="field">
          <span>Run after (UTC)</span>
          <select value={s.hourUtc} disabled={!s.nightly} onChange={(e) => setS({ ...s, hourUtc: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00 UTC</option>)}
          </select>
        </label>
        <label className="field">
          <span>Nightly backups to keep</span>
          <input type="number" min={1} max={90} value={s.keep} disabled={!s.nightly} onChange={(e) => setS({ ...s, keep: Math.max(1, Math.min(90, Number(e.target.value) || 1)) })} />
        </label>
      </div>
      <p className="hint">Include in the nightly backup:</p>
      <ComponentPicker components={components} selected={sel} onChange={(n) => setS({ ...s, components: [...n] })} />
      {s.updatedAt && <p className="muted small">Last changed {when(s.updatedAt)} by {s.updatedBy}</p>}
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={disabled || !s.components.length} onClick={() => onSave(s)}>Save nightly settings</button>
      </div>
    </section>
  );
}

function MovePanel({ disabled, onImport, onUpload }: { disabled: boolean; onImport: (url: string, id: string) => void; onUpload: (f: File) => void }) {
  const [url, setUrl] = useState('');
  const [id, setId] = useState('');
  const file = useRef<HTMLInputElement>(null);
  return (
    <section className="panel">
      <h2>Move to a new Azure instance</h2>
      <ol className="bk-steps small">
        <li>Deploy the Demo Center to the new Azure subscription or resource group with the infrastructure template (<code>infra/azuredeploy.json</code>), then set up sign-in and app roles in Entra ID. Roles and users are not part of a backup.</li>
        <li>On the old site, make a backup with <strong>Everything</strong> ticked (tick Subscribers only if you need them).</li>
        <li>Get the backup into the new site's storage, one of these ways:
          <ul>
            <li><strong>Import below (easiest):</strong> on the old storage account, create a SAS URL for the <code>backups</code> container with <em>Read</em> and <em>List</em> permissions and a short expiry. Paste it below with the backup's name.</li>
            <li><strong>AzCopy or Storage Explorer:</strong> copy the backup folder into the new account's <code>backups</code> container. It then appears in the list.</li>
            <li><strong>Data only:</strong> use <em>Download data</em> on the old site and upload the file below. Thumbnails, attachments and other files are not in that file.</li>
          </ul>
        </li>
        <li>On the new site, use <strong>Restore...</strong> on the backup. Content uses relative paths, so links, thumbnails and branding work on the new address.</li>
      </ol>

      <h3>Import a backup from another storage account</h3>
      <div className="bk-row">
        <label className="field bk-wide">
          <span>Container SAS URL</span>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://<account>.blob.core.windows.net/backups?sv=...&sp=rl&sig=..." autoComplete="off" spellCheck={false} />
        </label>
        <label className="field">
          <span>Backup name</span>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="20261109T020000000Z-nightly-abc123" autoComplete="off" spellCheck={false} />
        </label>
      </div>
      <p className="hint">The SAS URL is used once to copy the backup and is never stored or logged. Give it a short expiry.</p>
      <div className="actions">
        <button type="button" className="btn btn-primary" disabled={disabled || !url.trim() || !id.trim()} onClick={() => { onImport(url.trim(), id.trim()); setUrl(''); }}>Import backup</button>
      </div>

      <h3>Upload a downloaded data file</h3>
      <div className="actions">
        <label className="btn file-btn">Choose backup file (.json)<input ref={file} type="file" accept="application/json,.json" disabled={disabled}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); if (file.current) file.current.value = ''; }} /></label>
      </div>
    </section>
  );
}
