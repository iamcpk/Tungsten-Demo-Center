import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { postJson } from '../api';
import { useTitle } from '../hooks';

function SubscribedPanel({ already }: { already?: boolean }) {
  return (
    <div className="panel success">
      <h1>{already ? "You're already subscribed" : "You're subscribed"}</h1>
      <p>{already ? 'Your subscription was confirmed earlier, so there is nothing more to do.' : "We'll email you when new videos are published."}</p>
      <Link to="/videos" className="btn btn-primary">Browse videos</Link>
    </div>
  );
}

function InvalidLinkPanel() {
  return (
    <div className="panel">
      <h1>This link is no longer valid</h1>
      <p>It may be from an older confirmation email, or the address was unsubscribed. If you already confirmed your subscription, you're all set. Otherwise, subscribe again and use the link in the newest email.</p>
      <Link to="/subscribe" className="btn btn-primary">Subscribe again</Link>
    </div>
  );
}

/** Older links redirected here with ?status=ok|invalid. */
export function Subscribed() {
  const [params] = useSearchParams();
  const ok = params.get('status') === 'ok';
  useTitle(ok ? 'Subscription confirmed' : 'Link not valid');
  return <div className="wrap narrow section">{ok ? <SubscribedPanel /> : <InvalidLinkPanel />}</div>;
}

/**
 * Opened from the confirmation email. Nothing changes until the person presses Confirm,
 * because mail scanners open links in incoming mail before the recipient does.
 */
export function ConfirmSubscription() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'ask' | 'busy' | 'confirmed' | 'already' | 'invalid'>(token ? 'ask' : 'invalid');
  const [error, setError] = useState('');
  useTitle('Confirm your subscription');
  const confirm = async () => {
    setState('busy');
    setError('');
    try {
      const res = await fetch('/api/subscribe/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
      if (!res.ok) throw new Error(res.status === 429 ? 'Too many attempts. Please try again in a few minutes.' : 'Something went wrong. Please try again.');
      const r = (await res.json()) as { status?: 'confirmed' | 'already' | 'invalid' };
      setState(r.status ?? 'invalid');
    } catch (e) {
      setError((e as Error).message);
      setState('ask');
    }
  };
  return (
    <div className="wrap narrow section">
      {state === 'confirmed' || state === 'already' ? <SubscribedPanel already={state === 'already'} />
        : state === 'invalid' ? <InvalidLinkPanel />
          : (
            <div className="panel">
              <h1>Confirm your subscription</h1>
              <p>One more click so we know it's really you and not your mail filter. Some email security tools open links automatically, so we wait for you to press the button.</p>
              <p>Once confirmed, we'll email you when new videos are published on the Demo Center. You can unsubscribe at any time.</p>
              {error && <p className="alert">{error}</p>}
              <button className="btn btn-primary" onClick={confirm} disabled={state === 'busy'}>{state === 'busy' ? 'Confirming...' : 'Confirm subscription'}</button>
            </div>
          )}
    </div>
  );
}

export function Unsubscribe() {
  const [params] = useSearchParams();
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  useTitle('Unsubscribe');
  const go = async () => {
    try {
      await postJson('/api/unsubscribe', { token: params.get('token') ?? '' });
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="wrap narrow section">
      <div className="panel">
        {done ? (
          <><h1>You've been unsubscribed</h1><p>You won't receive any more Demo Center emails.</p></>
        ) : (
          <>
            <h1>Unsubscribe</h1>
            <p>Stop receiving emails about new Demo Center videos?</p>
            {error && <p className="alert">{error}</p>}
            <button className="btn btn-primary" onClick={go}>Unsubscribe</button>
          </>
        )}
      </div>
    </div>
  );
}
