import { useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { postJson } from '../api';
import { useJson, useTitle } from '../hooks';

type FormType = 'contact' | 'suggest' | 'demo';
const COPY: Record<FormType, { title: string; intro: string; message: string; button: string }> = {
  contact: { title: 'Contact the team', intro: 'Questions about a video or the Demo Center? Send us a message.', message: 'Message', button: 'Send message' },
  suggest: { title: 'Suggest a video', intro: "Tell us what you'd like to see demonstrated and we'll pass it to the right consultant.", message: 'What should the video cover?', button: 'Send suggestion' },
  demo: { title: 'Request a demo', intro: 'Ask the Solutions Consulting team for a live, tailored demonstration.', message: 'What would you like to see?', button: 'Request demo' },
};

export default function ContactPage() {
  const [params, setParams] = useSearchParams();
  const type = (['contact', 'suggest', 'demo'] as FormType[]).find((t) => t === params.get('type')) ?? 'contact';
  const copy = COPY[type];
  useTitle(copy.title);
  const { data } = useJson<{ products: string[] }>('/api/taxonomy');
  const opened = useRef(Date.now());
  const initialProduct = useMemo(() => params.get('product') ?? '', []); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState({ name: '', email: '', company: '', product: initialProduct, message: '', website: '' });
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');
  const upd = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setState('sending');
    try {
      await postJson(`/api/forms/${type}`, {
        ...f,
        company: f.company || undefined,
        product: f.product || undefined,
        elapsedMs: Date.now() - opened.current,
      });
      setState('done');
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <div className="wrap narrow section">
        <div className="panel success"><h1>Thanks, {f.name.split(' ')[0]}</h1><p>Your message has been sent. The team will get back to you by email.</p></div>
      </div>
    );
  }

  return (
    <div className="wrap narrow section">
      <div className="tabs" role="tablist">
        {(Object.keys(COPY) as FormType[]).map((t) => (
          <button key={t} role="tab" aria-selected={t === type} className={t === type ? 'on' : ''} onClick={() => setParams({ type: t }, { replace: true })}>{COPY[t].title}</button>
        ))}
      </div>
      <h1>{copy.title}</h1>
      <p className="muted">{copy.intro}</p>
      <form className="panel form" onSubmit={submit}>
        <div className="row2">
          <label className="field"><span>Name</span><input required minLength={2} maxLength={120} autoComplete="name" value={f.name} onChange={upd('name')} /></label>
          <label className="field"><span>Work email</span><input type="email" required maxLength={254} autoComplete="email" value={f.email} onChange={upd('email')} /></label>
        </div>
        <div className="row2">
          <label className="field"><span>Company (optional)</span><input maxLength={160} autoComplete="organization" value={f.company} onChange={upd('company')} /></label>
          <label className="field"><span>Product (optional)</span>
            <select value={f.product} onChange={upd('product')}>
              <option value="">Not sure / any</option>
              {data?.products.map((p) => <option key={p}>{p}</option>)}
            </select>
          </label>
        </div>
        <label className="field"><span>{copy.message}</span><textarea required minLength={5} maxLength={4000} rows={6} value={f.message} onChange={upd('message')} /></label>
        <label className="hp" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={upd('website')} /></label>
        <p className="muted small">We use these details only to respond to your request. Please don't include passwords, customer data or other sensitive information.</p>
        {error && <p className="alert" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={state === 'sending'}>{state === 'sending' ? 'Sending...' : copy.button}</button>
      </form>
    </div>
  );
}
