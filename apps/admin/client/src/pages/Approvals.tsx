import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fmtDate, mediaUrl, type Video } from '../api';
import { useMe } from '../App';

/** Queue of videos awaiting approval, oldest submission first. */
export default function Approvals() {
  const me = useMe();
  const [videos, setVideos] = useState<Video[]>();
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<Video[]>('/api/videos')
      .then((all) => setVideos(all.filter((v) => v.status === 'pending').sort((a, b) => (a.review?.submittedAt ?? '').localeCompare(b.review?.submittedAt ?? ''))))
      .catch((e: Error) => setError(e.message));
  }, []);
  const mine = (v: Video) => (v.review?.submittedBy ?? '').toLowerCase() === (me.user.email ?? me.user.id).toLowerCase();
  const isAdmin = me.user.roles.includes('Admin');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Approvals</h1>
          <p className="muted">Videos submitted by content creators. Check each one for quality and suitability before it goes on the public site.</p>
        </div>
      </div>
      {error && <p className="alert">{error}</p>}
      {!videos ? <p className="muted">Loading...</p> : !videos.length ? (
        <section className="panel"><p className="muted">Nothing is awaiting approval.</p></section>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th /><th>Title</th><th>Submitted by</th><th>Submitted</th><th /></tr></thead>
            <tbody>
              {videos.map((v) => {
                const thumb = v.thumbnailPath ? mediaUrl(me.mediaBaseUrl, v.thumbnailPath) : v.thumbnailUrl;
                return (
                  <tr key={v.id}>
                    <td className="t-thumb">{thumb ? <img src={thumb} alt="" loading="lazy" /> : <span className="no-thumb" />}</td>
                    <td><Link to={`/videos/${v.id}`} className="t-title">{v.title}</Link><div className="muted small">{v.products.join(', ')}</div></td>
                    <td className="small">{v.review?.submittedByName ?? v.review?.submittedBy ?? v.createdBy}</td>
                    <td className="small muted">{fmtDate(v.review?.submittedAt)}</td>
                    <td className="small">{mine(v) && !isAdmin ? <span className="muted">Your submission: another approver reviews it</span> : <Link to={`/videos/${v.id}`} className="btn btn-sm">Review</Link>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
