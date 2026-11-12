import { useEffect, useState } from 'react';
import { api, fmtDate, mediaUrl, type Video } from '../api';

interface Lang { code: string; label: string }

const fmtLen = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

/** Closed captions for an uploaded video: one WebVTT or SRT file per language. */
export function CaptionsPanel({ video, mediaBaseUrl, readOnly, onChange, onMessage }: {
  video: Video;
  mediaBaseUrl: string;
  readOnly: boolean;
  onChange: (v: Video) => void;
  onMessage: (m: { kind: 'ok' | 'err'; text: string }) => void;
}) {
  const [langs, setLangs] = useState<Lang[]>([]);
  const [lang, setLang] = useState('en');
  const [busy, setBusy] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  useEffect(() => { api.get<Lang[]>('/api/captions/languages').then(setLangs).catch(() => undefined); }, []);

  const tracks = video.captions ?? [];
  const replacing = tracks.find((t) => t.lang === lang);
  const duration = video.source.durationSec;

  // Uploads as soon as a file is chosen, like Attachments: there is no separate button to forget.
  const upload = async (file: File) => {
    setBusy(true);
    const fd = new FormData();
    fd.append('lang', lang);
    fd.append('file', file);
    try {
      const v = await api.upload<Video>(`/api/videos/${video.id}/captions`, fd);
      onChange(v);
      const t = v.captions?.find((c) => c.lang === lang);
      onMessage({ kind: 'ok', text: `${replacing ? 'Replaced' : 'Added'} ${t?.label ?? lang} captions (${t?.cues ?? 0} captions).` });
    } catch (e) {
      onMessage({ kind: 'err', text: (e as Error).message });
    } finally {
      setBusy(false);
      setInputKey((k) => k + 1);
    }
  };

  const remove = async (id: string, label: string) => {
    if (!confirm(`Remove the ${label} captions from this video?`)) return;
    try {
      onChange(await api.send<Video>('DELETE', `/api/videos/${video.id}/captions/${id}`));
      onMessage({ kind: 'ok', text: `Removed ${label} captions.` });
    } catch (e) {
      onMessage({ kind: 'err', text: (e as Error).message });
    }
  };

  return (
    <section className="panel">
      <h2>Captions</h2>
      <ul className="att-list">
        {tracks.map((t) => {
          // Captions that end well before or after the video usually belong to another video or edit.
          const mismatch = duration && (t.lastCueSec > duration + 5 || t.lastCueSec < duration * 0.5);
          return (
            <li key={t.id}>
              <span>
                <strong>{t.label}</strong>
                <span className="muted small">
                  {t.lang} · {t.cues} captions · last at {fmtLen(t.lastCueSec)} · added {fmtDate(t.uploadedAt)} · <a href={mediaUrl(mediaBaseUrl, t.path)} target="_blank" rel="noopener">Download .vtt</a>
                </span>
                {mismatch && <span className="hint warn">The captions end at {fmtLen(t.lastCueSec)} but the video is {fmtLen(duration)} long. Check this is the right file.</span>}
              </span>
              {!readOnly && <button type="button" className="link danger" onClick={() => remove(t.id, t.label)}>Remove</button>}
            </li>
          );
        })}
        {!tracks.length && <li className="muted">None. Viewers see a CC button once captions are added.</li>}
      </ul>
      {!readOnly && (
        <div className="cap-add">
          <select value={lang} onChange={(e) => setLang(e.target.value)} aria-label="Caption language">
            {(langs.length ? langs : [{ code: 'en', label: 'English' }]).map((l) => (
              <option key={l.code} value={l.code}>{l.label}{tracks.some((t) => t.lang === l.code) ? ' (replace)' : ''}</option>
            ))}
          </select>
          <label className={`btn file-btn${busy ? ' disabled' : ''}`}>
            {busy ? 'Uploading...' : replacing ? 'Replace captions...' : 'Add captions...'}
            <input key={inputKey} type="file" accept=".vtt,.srt,text/vtt,application/x-subrip" disabled={busy} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          </label>
        </div>
      )}
      <p className="hint">Choose the language, then the file: it is uploaded and saved straight away. WebVTT (.vtt) or SubRip (.srt), up to 2 MB, one file per language. Files are checked and converted to WebVTT; styling other than bold, italic and underline is removed. Captions are off until the viewer turns them on.</p>
    </section>
  );
}
