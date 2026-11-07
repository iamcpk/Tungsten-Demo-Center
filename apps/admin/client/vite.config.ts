import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  build: { outDir: '../dist/public', emptyOutDir: true, sourcemap: false },
  server: {
    port: 5174,
    proxy: { '/api': 'http://localhost:4100', '/media': 'http://localhost:4100' },
  },
});
