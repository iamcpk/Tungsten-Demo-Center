import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { postJson } from '../api';
import { useTitle } from '../hooks';

export function Subscribed() {
  const [params] = useSearchParams();
  const ok = params.get('status') === 'ok';
  useTitle(ok ? 'Subscription confirmed' : 'Link expired');
  return (
    <div className="wrap narrow section">
      <div className={`panel ${ok ? 'success' : ''}`}>
        <h1>{ok ? "You're subscribed" : 'This link is no longer valid'}</h1>
        <p>{ok ? "We'll email you when new videos are published." : 'The confirmation link has expired or was already used.'}</p>
        <Link to={ok ? '/videos' : '/subscribe'} className="btn btn-primary">{ok ? 'Browse videos' : 'Subscribe again'}</Link>
      </div>
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
