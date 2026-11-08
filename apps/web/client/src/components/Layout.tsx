import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { brandAssetUrl, copyrightText, isInternal, useBranding, type BrandLink } from '../branding';

/** A menu or footer link: router link for built-in pages, a safe new-tab link for https, a plain link for mailto. */
function SmartLink({ link, className, onClick }: { link: BrandLink; className?: string; onClick?: () => void }) {
  if (isInternal(link.href)) {
    return link.href.includes('?')
      ? <Link to={link.href} className={className} onClick={onClick}>{link.label}</Link>
      : <NavLink to={link.href} end={link.href === '/'} className={className} onClick={onClick}>{link.label}</NavLink>;
  }
  if (link.href.startsWith('mailto:')) return <a href={link.href} className={className}>{link.label}</a>;
  return <a href={link.href} className={className} target="_blank" rel="noopener noreferrer">{link.label}</a>;
}

export function Header() {
  const b = useBranding();
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const logo = b.assets.logo;
  return (
    <header className="site-header">
      <div className="wrap header-inner">
        <Link to="/" className="brand" onClick={close} aria-label={`${b.identity.siteName} home`}>
          <img src={logo ? brandAssetUrl(logo) : '/logo.png'} alt={b.identity.logoAlt} width={logo?.width ?? 150} height={logo?.height ?? 40} />
          {b.identity.brandSubtitle && <span className="brand-sub">{b.identity.brandSubtitle}</span>}
        </Link>
        <button className="menu-btn" aria-expanded={open} aria-controls="nav" onClick={() => setOpen(!open)}>
          <span className="sr">Menu</span>
          <span className="bars" aria-hidden="true" />
        </button>
        <nav id="nav" className={open ? 'open' : ''} aria-label="Main">
          {b.header.menu.filter((l) => l.visible).map((l) => (
            <SmartLink key={l.id} link={l} className={l.style === 'button' ? 'btn btn-primary btn-sm' : undefined} onClick={close} />
          ))}
        </nav>
      </div>
    </header>
  );
}

export function Footer() {
  const b = useBranding();
  const logo = b.assets.footerLogo ?? b.assets.logo;
  return (
    <footer className="site-footer">
      <div className="wrap footer-inner">
        <div>
          {b.footer.showLogo && <img className="footer-logo" src={logo ? brandAssetUrl(logo) : '/logo.png'} alt={b.identity.logoAlt} />}
          {b.footer.heading && <strong>{b.footer.heading}</strong>}
          {b.footer.text && <p>{b.footer.text}</p>}
        </div>
        <div className="footer-links">
          {b.footer.links.filter((l) => l.visible).map((l) => <SmartLink key={l.id} link={l} />)}
        </div>
      </div>
      {b.footer.copyright && <div className="wrap copyright">{copyrightText(b)}</div>}
    </footer>
  );
}

export function SearchBox({ initial = '', large = false }: { initial?: string; large?: boolean }) {
  const b = useBranding();
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
        placeholder={b.home.searchPlaceholder}
        aria-label="Search videos"
        maxLength={200}
      />
      <button className="btn btn-primary" type="submit">Search</button>
    </form>
  );
}
