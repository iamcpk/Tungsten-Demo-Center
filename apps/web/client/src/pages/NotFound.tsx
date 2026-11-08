import { Link } from 'react-router-dom';
import { SearchBox } from '../components/Layout';
import { useTitle } from '../hooks';
import { useBranding } from '../branding';

export default function NotFound() {
  useTitle('Page not found');
  const p = useBranding().pages;
  return (
    <div className="wrap narrow section center">
      <p className="eyebrow">404</p>
      <h1>{p.notFoundHeading}</h1>
      {p.notFoundText && <p className="muted">{p.notFoundText}</p>}
      <SearchBox />
      <p><Link to="/archive">Search the archive</Link></p>
    </div>
  );
}
