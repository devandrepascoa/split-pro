import { cloudflare } from '@cloudflare/vite-plugin';
import vinext from 'vinext';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vinext(), cloudflare()],
  build: { sourcemap: true },
  resolve: {
    alias: {
      '~': new URL('./src', import.meta.url).pathname,
      '@': new URL('.', import.meta.url).pathname,
    },
  },
});
