import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { BrandingProvider } from './branding';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrandingProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </BrandingProvider>
  </React.StrictMode>,
);
