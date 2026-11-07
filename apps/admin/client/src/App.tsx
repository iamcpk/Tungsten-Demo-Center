import { createContext, useContext, useEffect, useState } from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { api, type Me } from './api';
import VideoList from './pages/VideoList';
import VideoEditor from './pages/VideoEditor';
import TaxonomyPage from './pages/Taxonomy';
import Subscribers from './pages/Subscribers';
import Submissions from './pages/Submissions';

export const MeContext = createContext<Me | undefined>(undefined);
export const useMe = () => useContext(MeContext)!;

export default function App() {
  const [me, setMe] = useState<Me>();
  const [error, setError] = useState('');
  useEffect(() => { api.get<Me>('/api/me').then(setMe).catch((e: Error) => setError(e.message)); }, []);

  if (error) return <div className="center-screen"><div className="panel"><h1>Unable to sign in</h1><p>{error}</p></div></div>;
  if (!me) return <div className="center-screen muted">Loading...</div>;
  if (!me.user.roles.length) {
    return (
      <div className="center-screen">
        <div className="panel">
          <h1>Access not assigned</h1>
          <p>You're signed in as {me.user.email ?? me.user.name}, but you don't have the Editor or Admin role for the Demo Center admin portal. Ask an administrator to assign you a role in Entra ID.</p>
          <a className="btn" href="/.auth/logout">Sign out</a>
        </div>
      </div>
    );
  }
  const isAdmin = me.user.roles.includes('Admin');

  return (
    <MeContext.Provider value={me}>
      <div className="shell">
        <aside className="side">
          <div className="side-brand"><img src="/logo.png" alt="Tungsten Automation" /><span>Demo Center Admin</span></div>
          <nav>
            <NavLink to="/" end>Videos</NavLink>
            <NavLink to="/videos/new">Add video</NavLink>
            <NavLink to="/taxonomy">Lists &amp; tags</NavLink>
            {isAdmin && <NavLink to="/subscribers">Subscribers</NavLink>}
            {isAdmin && <NavLink to="/submissions">Form inbox</NavLink>}
          </nav>
          <div className="side-user">
            <strong>{me.user.name}</strong>
            <span>{me.user.roles.join(', ')}</span>
            <a href="/.auth/logout">Sign out</a>
          </div>
        </aside>
        <main className="content">
          <Routes>
            <Route path="/" element={<VideoList />} />
            <Route path="/videos/new" element={<VideoEditor />} />
            <Route path="/videos/:id" element={<VideoEditor />} />
            <Route path="/taxonomy" element={<TaxonomyPage />} />
            {isAdmin && <Route path="/subscribers" element={<Subscribers />} />}
            {isAdmin && <Route path="/submissions" element={<Submissions />} />}
            <Route path="*" element={<p>Page not found.</p>} />
          </Routes>
        </main>
      </div>
    </MeContext.Provider>
  );
}
