import { useEffect } from 'react';
import { Route, Routes, useLocation } from 'react-router-dom';
import { Header, Footer } from './components/Layout';
import Home from './pages/Home';
import Browse from './pages/Browse';
import VideoPage from './pages/VideoPage';
import Subscribe from './pages/Subscribe';
import ContactPage from './pages/Contact';
import { Subscribed, Unsubscribe } from './pages/SubscriptionStatus';
import NotFound from './pages/NotFound';

export default function App() {
  const { pathname } = useLocation();
  useEffect(() => window.scrollTo(0, 0), [pathname]);
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <Header />
      <main id="main">
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/videos" element={<Browse status="active" />} />
          <Route path="/archive" element={<Browse status="archived" />} />
          <Route path="/videos/:slug" element={<VideoPage />} />
          <Route path="/subscribe" element={<Subscribe />} />
          <Route path="/contact" element={<ContactPage />} />
          <Route path="/subscribed" element={<Subscribed />} />
          <Route path="/unsubscribe" element={<Unsubscribe />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Footer />
    </>
  );
}
