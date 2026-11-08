import { useState } from 'react';
import { postJson } from '../api';
import { useJson, useTitle } from '../hooks';
import { useBranding } from '../branding';

export default function Subscribe() {
  useTitle('Subscribe');
  const b = useBranding();
  const { data } = useJson<{ products: string[] }>('/api/taxonomy');
  const [email, setEmail] = useState('');
  const [products, setProducts] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [hp, setHp] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done'>('idle');
  const [error, setError] = useState('');

  const toggle = (p: string) => setProducts((cur) => (cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setState('sending');
    try {
      await postJson('/api/subscribe', { email, products, consent, website: hp });
      setState('done');
    } catch (err) {
      setError((err as Error).message);
      setState('idle');
    }
  };

  if (state === 'done') {
    return (
      <div className="wrap narrow section">
        <div className="panel success">
          <h1>Check your inbox</h1>
          <p>We've sent a confirmation link to <strong>{email}</strong>. Your subscription starts once you click it.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap narrow section">
      <h1>{b.pages.subscribeHeading}</h1>
      {b.pages.subscribeIntro && <p className="muted">{b.pages.subscribeIntro}</p>}
      <form className="panel form" onSubmit={submit} noValidate>
        <label className="field">
          <span>Work email</span>
          <input type="email" required autoComplete="email" maxLength={254} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        {data && data.products.length > 0 && (
          <fieldset className="field">
            <legend>Products (optional)</legend>
            <div className="check-grid">
              {data.products.map((p) => (
                <label key={p} className={`check-chip ${products.includes(p) ? 'on' : ''}`}>
                  <input type="checkbox" checked={products.includes(p)} onChange={() => toggle(p)} /> {p}
                </label>
              ))}
            </div>
          </fieldset>
        )}
        <label className="hp" aria-hidden="true">Website<input tabIndex={-1} autoComplete="off" value={hp} onChange={(e) => setHp(e.target.value)} /></label>
        <label className="consent">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} required />
          <span>I agree to receive emails from Tungsten Automation about new Demo Center videos. I can unsubscribe at any time. See the <a href={b.legal.privacyUrl} target="_blank" rel="noopener noreferrer">privacy policy</a>.</span>
        </label>
        {error && <p className="alert" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={!consent || !email || state === 'sending'}>{state === 'sending' ? 'Sending...' : 'Subscribe'}</button>
      </form>
    </div>
  );
}
