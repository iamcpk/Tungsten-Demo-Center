import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';

export function Header() {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <Link to="/" className="brand" onClick={close} aria-label="Tungsten Demo Center home">
          <img src="/logo.png" alt="Tungsten Automation" width="150" height="40" />
          <span className="brand-sub">Demo Center</span>
        </Link>
        <button className="menu-btn" aria-expanded={open} aria-controls="nav" onClick={() => setOpen(!open)}>
          <span className="sr">Menu</span>
          <span className="bars" aria-hidden="true" />
        </button>
        <nav id="nav" className={open ? 'open' : ''} aria-label="Main">
          <NavLink to="/videos" onClick={close}>Videos</NavLink>
          <NavLink to="/archive" onClick={close}>Archive</NavLink>
          <a href="https://partner.kofax.com" target="_blank" rel="noopener noreferrer">Partners</a>
          <NavLink to="/contact" onClick={close}>Contact</NavLink>
          <NavLink to="/subscribe" className="btn btn-primary btn-sm" onClick={close}>Subscribe</NavLink>
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <div>
          <strong>Tungsten Demo Center</strong>
          <p>Demonstrations and walk-throughs across the Tungsten Automation portfolio, from the Solutions Consulting team.</p>
        </div>
        <div className="footer-links">
          <Link to="/contact?type=suggest">Suggest a video</Link>
          <Link to="/contact?type=demo">Request a demo</Link>
          <a href="https://www.tungstenautomation.com/legal/privacy" target="_blank" rel="noopener noreferrer">Privacy policy</a>
          <a href="https://www.tungstenautomation.com" target="_blank" rel="noopener noreferrer">tungstenautomation.com</a>
        </div>
      </div>
      <div className="wrap copyright">© {new Date().getFullYear()} Tungsten Automation Corporation</div>
    </footer>
  );
}

export function SearchBox({ initial = '', large = false }: { initial?: string; large?: boolean }) {
  const [q, setQ] = useState(initial);
  const nav = useNavigate();
  return (
    <form
      role="search"
      className={`search ${large ? 'search-lg' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        nav(q.trim() ? `/videos?q=${encodeURIComponent(q.trim())}` : '/videos');
      }}
    >
      <svg aria-hidden="true" viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M10 4a6 6 0 104.47 10l4.77 4.77 1.41-1.41L15.9 12.6A6 6 0 0010 4zm0 2a4 4 0 110 8 4 4 0 010-8z" /></svg>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search videos, products, use cases..."
        aria-label="Search videos"
        maxLength={200}
      />
      <button className="btn btn-primary" type="submit">Search</button>
    </form>
  );
}
