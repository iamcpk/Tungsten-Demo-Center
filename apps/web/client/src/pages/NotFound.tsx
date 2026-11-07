import { Link } from 'react-router-dom';
import { SearchBox } from '../components/Layout';
import { useTitle } from '../hooks';

export default function NotFound() {
  useTitle('Page not found');
  return (
    <div className="wrap narrow section center">
      <p className="eyebrow">404</p>
      <h1>We couldn't find that page</h1>
      <p className="muted">The video may have moved or been retired. Try searching instead.</p>
      <SearchBox />
      <p><Link to="/archive">Search the archive</Link></p>
    </div>
  );
}
