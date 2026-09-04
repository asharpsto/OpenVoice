import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Plugin, ViteDevServer } from 'vite';
import { TUNE_CHANNEL, TUNE_ROUTE } from '../src/tune/channel.js';

/**
 * Dev-server half of the tuning harness (SPEC §7): hot reload and write-back.
 *
 * Two directions, one channel:
 *  - edit `tune/*.json` in an editor and the running game picks it up
 *  - drag a slider in the overlay and the file on disk changes
 *
 * Write-back is what makes the overlay worth having. Without it, tuning is a
 * session you lose, and the numbers you liked are gone.
 *
 * Dev only — it never runs in a build.
 */

export function tunePlugin(tuneDir = 'tune'): Plugin {
  const dir = resolve(process.cwd(), tuneDir);
  /** Last content this plugin wrote, so its own writes do not echo back. */
  const written = new Map<string, string>();
  /** Set once the dev server is configured; pushes a file over the HMR channel. */
  let hot: ((path: string) => Promise<void>) | undefined;

  const isTuneFile = (path: string): string | null => {
    const normalised = resolve(path);
    if (!normalised.startsWith(dir)) return null;
    const match = /([\w-]+)\.json$/.exec(normalised);
    return match ? match[1] : null;
  };

  return {
    name: 'banana-tune',
    apply: 'serve',

    configureServer(server: ViteDevServer) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith(TUNE_ROUTE) || req.method !== 'POST') return next();
        const name = req.url.slice(TUNE_ROUTE.length).replace(/[^\w-]/g, '');
        if (!name) {
          res.statusCode = 400;
          res.end('bad tune name');
          return;
        }
        try {
          const body = await readBody(req);
          // Parse before writing: a slider must never be able to leave an
          // unloadable file on disk.
          const parsed: unknown = JSON.parse(body);
          const text = `${JSON.stringify(parsed, null, 2)}\n`;
          const file = join(dir, `${name}.json`);
          written.set(file, text);
          await writeFile(file, text, 'utf8');
          res.statusCode = 200;
          res.end('ok');
        } catch (error) {
          res.statusCode = 400;
          res.end(String(error));
        }
      });

      hot = async (path: string): Promise<void> => {
        const name = isTuneFile(path);
        if (!name) return;
        const text = await readFile(path, 'utf8');
        if (written.get(resolve(path)) === text) return; // our own write, already applied
        try {
          server.hot.send({
            type: 'custom',
            event: TUNE_CHANNEL,
            data: { name, value: JSON.parse(text) as unknown },
          });
          server.config.logger.info(`  tune: ${name}.json reloaded`);
        } catch (error) {
          server.config.logger.warn(`  tune: ${name}.json is not valid JSON — ${String(error)}`);
        }
      };

      server.watcher.add(dir);
    },

    handleHotUpdate(context) {
      if (!isTuneFile(context.file)) return undefined;
      // Vite's default for a changed JSON module is to reload the page, because
      // JSON cannot accept its own update. A reload in the middle of tuning
      // throws away the match you were tuning against, which is most of the
      // value of doing it live — so take the update over our own channel and
      // give Vite nothing to do.
      void hot?.(context.file);
      return [];
    },
  };
}

async function readBody(req: { on(event: string, fn: (chunk?: unknown) => void): void }): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += String(chunk)));
    req.on('end', () => resolvePromise(body));
    req.on('error', (error) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}
