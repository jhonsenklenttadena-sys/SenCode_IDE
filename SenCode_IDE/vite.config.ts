import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  // CRITICAL: base must be './' for Electron packaged builds.
  // Without this, Vite generates absolute asset paths (/assets/...)
  // which fail inside an asar archive — causing a black screen.
  base: './',
  server: {
    port: 3333,
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
});
