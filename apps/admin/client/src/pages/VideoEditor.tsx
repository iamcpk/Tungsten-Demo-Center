import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, BL, fmtBytes, fmtDate, mediaUrl, uploadToBlob, type Provider, type Taxonomy, type Video } from '../api';
import { TagInput } from '../components/TagInput';
import { useMe } from '../App';

interface FormState {
  title: string;
  slug: string;
  pageTitle: string;
  shortDescription: string;
  description: string;
  status: Video['status'];
  itemType: Video['itemType'];
  businessLines: ('IA' | 'PA')[];
  products: string[];
  verticals: string[];
  authors: string[];
  languages: string[];
  categories: string[];
  keywords: string[];
  featured: boolean;
  publishedAt: string;
  internalNotes: string;
  provider: Provider;
  url: string;
}

const EMPTY: FormState = {
  title: '', slug: '', pageTitle: '', shortDescription: '', description: '', status: 'draft', itemType: 'video',
  businessLines: [], products: [], verticals: [], authors: [], languages: ['English'], categories: [], keywords: [],
  featured: false, publishedAt: new Date().toISOString().slice(0, 10), internalNotes: '', provider: 'vimeo', url: '',
};

function fromVideo(v: Video): FormState {
  return {
    title: v.title, slug: v.slug, pageTitle: v.pageTitle ?? '', shortDescription: v.shortDescription, description: v.description,
    status: v.status, itemType: v.itemType, businessLines: v.businessLines, products: v.products, verticals: v.verticals,
    authors: v.authors, languages: v.languages, categories: v.categories, keywords: v.keywords, featured: v.featured,
    publishedAt: v.publishedAt.slice(0, 10), internalNotes: v.internalNotes ?? '', provider: v.source.provider, url: v.source.url ?? '',
  };
}

/** Plain text paragraphs become <p> blocks; existing HTML is kept (the server sanitises it). */
function toHtml(text: string) {
  if (/<\/?[a-z][\s\S]*>/i.test(text)) return text;
  return text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>')}</p>`).join('\n');
}

const ENCODE_TEXT: Record<string, string> = {
  'awaiting-upload': 'No file uploaded yet.',
  queued: 'Upload received. Waiting for the encoder to start.',
  encoding: 'Encoding into adaptive streaming formats. This can take a while for long videos.',
  ready: 'Ready to stream.',
  failed: 'Encoding failed.',
};

export default function VideoEditor() {
  const { id } = useParams();
  const nav = useNavigate();
  const me = useMe();
  const isAdmin = me.user.roles.includes('Admin');
  const [video, setVideo] = useState<Video>();
  const [f, setF] = useState<FormState>(EMPTY);
  const [tax, setTax] = useState<Taxonomy>();
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string }>();
  const [upload, setUpload] = useState<{ name: string; pct: number }>();
  const [lookup, setLookup] = useState<string>();
  const abort = useRef<AbortController>();

  useEffect(() => { api.get<Taxonomy>('/api/taxonomy').then(setTax).catch(() => undefined); }, []);
  useEffect(() => {
    if (!id) { setVideo(undefined); setF(EMPTY); return; }
    api.get<Video>(`/api/videos/${id}`).then((v) => { setVideo(v); setF(fromVideo(v)); }).catch((e: Error) => setMsg({ kind: 'err', text: e.message }));
  }, [id]);

  // Poll while an uploaded video is queued or encoding.
  useEffect(() => {
    if (!video || video.source.provider !== 'azure' || !['queued', 'encoding'].includes(video.source.encodeState ?? '')) return;
    const t = setInterval(() => api.get<Video>(`/api/videos/${video.id}`).then(setVideo).catch(() => undefined), 10_000);
    return () => clearInterval(t);
  }, [video]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const lookupUrl = async () => {
    if (!f.url) return;
    setLookup('Checking link...');
    try {
      const r = await api.get<{ source: { provider: Provider }; info: { title?: string; thumbnailUrl?: string } | null }>(`/api/oembed?url=${encodeURIComponent(f.url)}`);
      setF((s) => ({ ...s, provider: r.source.provider, title: s.title || r.info?.title || '' }));
      setLookup(r.info?.title ? `Found: "${r.info.title}"` : 'Link recognised. Details are private, so fill in the title manually.');
    } catch (e) {
      setLookup((e as Error).message);
    }
  };

  const payload = () => ({
    title: f.title, slug: f.slug || undefined, pageTitle: f.pageTitle || undefined, shortDescription: f.shortDescription,
    description: toHtml(f.description), status: f.status, itemType: f.itemType, businessLines: f.businessLines,
    products: f.products, verticals: f.verticals, authors: f.authors, languages: f.languages, categories: f.categories,
    keywords: f.keywords, featured: f.featured, publishedAt: new Date(`${f.publishedAt}T12:00:00Z`).toISOString(),
    internalNotes: f.internalNotes || undefined,
    source: f.provider === 'azure' ? { provider: 'azure' } : { provider: f.provider, url: f.url },
  });

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    setSaving(true);
    setMsg(undefined);
    try {
      const v = video
        ? await api.send<Video>('PUT', `/api/videos/${video.id}`, payload())
        : await api.send<Video>('POST', '/api/videos', payload());
      setVideo(v);
      setF(fromVideo(v));
      setMsg({ kind: 'ok', text: video ? 'Saved.' : f.provider === 'azure' ? 'Draft created. Now upload the video file below.' : 'Video created.' });
      if (!video) nav(`/videos/${v.id}`, { replace: true });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const uploadVideo = async (file: File) => {
    if (!video) return;
    setMsg(undefined);
    abort.current = new AbortController();
    try {
      const { url, blobName } = await api.send<{ url: string; blobName: string }>('POST', `/api/videos/${video.id}/upload-url`, { fileName: file.name, size: file.size });
      setUpload({ name: file.name, pct: 0 });
      await uploadToBlob(url, file, file.type || 'video/mp4', (pct) => setUpload({ name: file.name, pct }), abort.current.signal);
      setVideo(await api.send<Video>('POST', `/api/videos/${video.id}/upload-complete`, { blobName }));
      setMsg({ kind: 'ok', text: 'Upload complete. Encoding has been queued.' });
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).name === 'AbortError' ? 'Upload cancelled.' : (err as Error).message });
    } finally {
      setUpload(undefined);
    }
  };

  const uploadThumb = async (file: File) => {
    if (!video) return;
    const fd = new FormData();
    fd.append('file', file);
    try { setVideo(await api.upload<Video>(`/api/videos/${video.id}/thumbnail`, fd)); }
    catch (err) { setMsg({ kind: 'err', text: (err as Error).message }); }
  };

  const addAttachment = async (file: File) => {
    if (!video) return;
    try {
      const r = await api.send<{ url: string; blobName: string; contentType: string }>('POST', `/api/videos/${video.id}/attachments/upload-url`, { fileName: file.name, size: file.size });
      setUpload({ name: file.name, pct: 0 });
      await uploadToBlob(r.url, file, r.contentType, (pct) => setUpload({ name: file.name, pct }));
      setVideo(await api.send<Video>('POST', `/api/videos/${video.id}/attachments`, { blobName: r.blobName, name: file.name.replace(/\.[^.]+$/, '') }));
    } catch (err) {
      setMsg({ kind: 'err', text: (err as Error).message });
    } finally {
      setUpload(undefined);
    }
  };

  const removeAttachment = async (attId: string) => {
    if (!video || !confirm('Remove this attachment?')) return;
    setVideo(await api.send<Video>('DELETE', `/api/videos/${video.id}/attachments/${attId}`));
  };

  const notify = async () => {
    if (!video || !confirm('Email all matching confirmed subscribers about this video?')) return;
    try {
      const r = await api.send<{ sent: number; total: number }>('POST', `/api/videos/${video.id}/notify`);
      setMsg({ kind: 'ok', text: `Sent to ${r.sent} of ${r.total} subscribers.` });
    } catch (err) { setMsg({ kind: 'err', text: (err as Error).message }); }
  };

  const remove = async () => {
    if (!video || !confirm(`Permanently delete "${video.title}" and its uploaded files? This cannot be undone.`)) return;
    await api.send('DELETE', `/api/videos/${video.id}`);
    nav('/');
  };

  const thumb = video?.thumbnailPath ? mediaUrl(me.mediaBaseUrl, video.thumbnailPath) : video?.thumbnailUrl;
  const state = video?.source.provider === 'azure' ? video.source.encodeState ?? 'awaiting-upload' : undefined;

  return (
    <form onSubmit={save}>
      <div className="page-head sticky">
        <div>
          <h1>{video ? video.title || 'Untitled' : 'Add video'}</h1>
          {video && <p className="muted small">Updated {fmtDate(video.updatedAt)}{video.updatedBy ? ` by ${video.updatedBy}` : ''}{video.legacyId ? ` · iVengi #${video.legacyId}` : ''}</p>}
        </div>
        <div className="actions">
          {video?.status === 'active' && <a className="btn" href={`${me.publicSiteUrl}/videos/${video.slug}`} target="_blank" rel="noopener noreferrer">View</a>}
          <button className="btn btn-primary" disabled={saving}>{saving ? 'Saving...' : video ? 'Save changes' : 'Create'}</button>
        </div>
      </div>
      {msg && <p className={msg.kind === 'ok' ? 'notice' : 'alert'} role="status">{msg.text}</p>}

      <div className="editor">
        <div className="col">
          <section className="panel">
            <h2>Video source</h2>
            <div className="seg">
              {(['vimeo', 'youtube', 'azure'] as Provider[]).map((p) => (
                <label key={p} className={f.provider === p ? 'on' : ''}>
                  <input type="radio" name="provider" checked={f.provider === p} onChange={() => set('provider', p)} />
                  {p === 'vimeo' ? 'Vimeo link' : p === 'youtube' ? 'YouTube link' : 'Upload file'}
                </label>
              ))}
            </div>
            {f.provider !== 'azure' ? (
              <div className="field">
                <span>{f.provider === 'vimeo' ? 'Vimeo URL' : 'YouTube URL'}</span>
                <div className="inline">
                  <input type="url" required value={f.url} onChange={(e) => set('url', e.target.value)} placeholder={f.provider === 'vimeo' ? 'https://vimeo.com/123456789' : 'https://www.youtube.com/watch?v=...'} />
                  <button type="button" className="btn" onClick={lookupUrl}>Check</button>
                </div>
                {lookup && <span className="hint">{lookup}</span>}
              </div>
            ) : !video ? (
              <p className="hint">Create the draft first, then upload the file here. Files go straight to Azure Blob Storage, and large files (multi-GB) are fine.</p>
            ) : (
              <div className="upload-box">
                <p><strong>Status:</strong> {ENCODE_TEXT[state!]} {state === 'failed' && video.source.encodeError && <span className="muted">({video.source.encodeError})</span>}</p>
                {upload ? (
                  <div className="progress">
                    <div className="bar"><div style={{ width: `${upload.pct}%` }} /></div>
                    <span>{upload.name}: {upload.pct}%</span>
                    <button type="button" className="link" onClick={() => abort.current?.abort()}>Cancel</button>
                  </div>
                ) : (
                  <div className="inline">
                    <label className="btn btn-primary file-btn">
                      {video.source.uploadBlob ? 'Replace video file' : 'Choose video file'}
                      <input type="file" accept="video/*,.mkv" onChange={(e) => e.target.files?.[0] && uploadVideo(e.target.files[0])} />
                    </label>
                    {state === 'failed' && <button type="button" className="btn" onClick={async () => setVideo(await api.send<Video>('POST', `/api/videos/${video.id}/re-encode`))}>Retry encode</button>}
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel">
            <h2>Details</h2>
            <label className="field"><span>Title</span><input required minLength={3} maxLength={200} value={f.title} onChange={(e) => set('title', e.target.value)} /></label>
            <label className="field"><span>Short description</span><textarea rows={2} maxLength={600} value={f.shortDescription} onChange={(e) => set('shortDescription', e.target.value)} /><span className="hint">Shown on cards and in link previews.</span></label>
            <label className="field"><span>Full description</span><textarea rows={8} maxLength={20000} value={f.description} onChange={(e) => set('description', e.target.value)} /><span className="hint">Plain text paragraphs, or basic HTML (p, strong, em, ul, li, a). Anything else is removed.</span></label>
            <div className="row2">
              <label className="field"><span>URL slug</span><input value={f.slug} onChange={(e) => set('slug', e.target.value.toLowerCase())} placeholder="generated from title" pattern="[a-z0-9]+(-[a-z0-9]+)*" /></label>
              <label className="field"><span>Page title (SEO, optional)</span><input maxLength={200} value={f.pageTitle} onChange={(e) => set('pageTitle', e.target.value)} /></label>
            </div>
          </section>

          <section className="panel">
            <h2>Classification</h2>
            <div className="field">
              <span>Business line</span>
              <div className="checks">
                {(['IA', 'PA'] as const).map((b) => (
                  <label key={b}><input type="checkbox" checked={f.businessLines.includes(b)} onChange={(e) => set('businessLines', e.target.checked ? [...f.businessLines, b] : f.businessLines.filter((x) => x !== b))} /> {BL[b]}</label>
                ))}
              </div>
            </div>
            <div className="field"><span>Products</span><TagInput value={f.products} onChange={(v) => set('products', v)} options={tax?.products} placeholder="Add product" allowNew={false} /></div>
            <div className="field"><span>Categories</span><TagInput value={f.categories} onChange={(v) => set('categories', v)} options={tax?.categories} placeholder="Add category" allowNew={false} /></div>
            <div className="field"><span>Industries</span><TagInput value={f.verticals} onChange={(v) => set('verticals', v)} options={tax?.verticals} placeholder="Add industry" allowNew={false} /></div>
            <div className="row2">
              <div className="field"><span>Presenters</span><TagInput value={f.authors} onChange={(v) => set('authors', v)} options={tax?.authors} placeholder="Add presenter" /></div>
              <div className="field"><span>Languages</span><TagInput value={f.languages} onChange={(v) => set('languages', v)} options={tax?.languages} placeholder="Add language" allowNew={false} /></div>
            </div>
            <div className="field"><span>Keywords</span><TagInput value={f.keywords} onChange={(v) => set('keywords', v)} placeholder="Type and press Enter" /></div>
            <p className="hint">Products, categories, industries and languages come from <a href="/taxonomy">Lists &amp; tags</a>.</p>
          </section>
        </div>

        <div className="col side-col">
          <section className="panel">
            <h2>Publishing</h2>
            <label className="field"><span>Status</span>
              <select value={f.status} onChange={(e) => set('status', e.target.value as FormState['status'])}>
                <option value="draft">Draft (hidden)</option><option value="active">Active (public)</option><option value="archived">Archived (public, archive section)</option>
              </select>
            </label>
            <label className="field"><span>Publish date</span><input type="date" required value={f.publishedAt} onChange={(e) => set('publishedAt', e.target.value)} /></label>
            <label className="field"><span>Item type</span>
              <select value={f.itemType} onChange={(e) => set('itemType', e.target.value as FormState['itemType'])}><option value="video">Video</option><option value="document">Document</option></select>
            </label>
            <label className="check"><input type="checkbox" checked={f.featured} onChange={(e) => set('featured', e.target.checked)} /> Feature on the home page</label>
            {video && isAdmin && video.status === 'active' && (
              <div className="divider">
                <button type="button" className="btn" onClick={notify}>Email subscribers</button>
                {video.notifiedAt && <span className="hint">Last sent {fmtDate(video.notifiedAt)}</span>}
              </div>
            )}
          </section>

          {video && (
            <section className="panel">
              <h2>Thumbnail</h2>
              {thumb ? <img className="thumb-preview" src={thumb} alt="" /> : <div className="thumb-preview empty">No thumbnail</div>}
              <label className="btn file-btn">Upload image<input type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => e.target.files?.[0] && uploadThumb(e.target.files[0])} /></label>
              <p className="hint">16:9, at least 1280×720. JPG, PNG or WebP up to 8 MB. Uploaded videos get one automatically.</p>
            </section>
          )}

          {video && (
            <section className="panel">
              <h2>Attachments</h2>
              <ul className="att-list">
                {video.attachments.map((a) => (
                  <li key={a.id}>
                    <span><strong>{a.name}</strong><span className="muted small">{fmtBytes(a.sizeBytes)}{a.url && !a.path ? ' · external link' : ''}</span></span>
                    <button type="button" className="link danger" onClick={() => removeAttachment(a.id)}>Remove</button>
                  </li>
                ))}
                {!video.attachments.length && <li className="muted">None</li>}
              </ul>
              <label className="btn file-btn">Add file<input type="file" accept=".pdf,.ppt,.pptx,.doc,.docx,.xls,.xlsx,.zip,.txt,.png,.jpg,.jpeg" onChange={(e) => e.target.files?.[0] && addAttachment(e.target.files[0])} /></label>
            </section>
          )}

          <section className="panel">
            <h2>Internal notes</h2>
            <textarea rows={4} maxLength={4000} value={f.internalNotes} onChange={(e) => set('internalNotes', e.target.value)} />
            <p className="hint">Never shown on the public site. Don't store customer data, credentials or personal data here.</p>
          </section>

          {video && isAdmin && (
            <section className="panel danger-zone">
              <h2>Danger zone</h2>
              <p className="hint">Archiving keeps the video visible in the archive. Deleting removes it and its uploaded files permanently.</p>
              <button type="button" className="btn btn-danger" onClick={remove}>Delete video</button>
            </section>
          )}
        </div>
      </div>
    </form>
  );
}
