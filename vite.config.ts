import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Le renderer est servi en file:// dans Electron : base relative obligatoire.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', target: 'es2022', chunkSizeWarningLimit: 4000 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
  },
} as any);
