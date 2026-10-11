import { defineConfig } from 'vite';

// Builds the service worker (push notifications + runtime caching) to public/sw.js.
// Runs before the app build so the file is served as a static asset.
export default defineConfig({
  publicDir: false,
  resolve: { alias: { '~': new URL('./src', import.meta.url).pathname } },
  define: { 'self.__SW_MANIFEST': 'undefined', 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: 'public',
    emptyOutDir: false,
    lib: { entry: 'src/sw.ts', formats: ['es'], fileName: () => 'sw.js' },
    rolldownOptions: { output: { inlineDynamicImports: true } },
  },
});
