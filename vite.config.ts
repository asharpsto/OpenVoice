import { defineConfig } from 'vite';
import { tunePlugin } from './tools/vite-plugin-tune.js';

export default defineConfig({
  plugins: [tunePlugin()],
  server: { host: true },
  build: { target: 'es2022' },
});
