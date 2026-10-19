import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const sharedRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sharedAssets = new Map([
  ['/ribbon.xml', ['ribbon.xml', 'application/xml; charset=utf-8']],
  ['/main.js', ['main.js', 'application/javascript; charset=utf-8']],
  ['/panel.html', ['panel.html', 'text/html; charset=utf-8']],
  ['/panel.js', ['panel.js', 'application/javascript; charset=utf-8']],
  ['/panel.css', ['panel.css', 'text/css; charset=utf-8']],
]);

export function serveSharedFiles() {
  return {
    name: 'wps-personal-cloud-shared-assets',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const pathname = new URL(request.url || '/', 'http://localhost').pathname;
        const asset = sharedAssets.get(pathname);
        if (!asset) return next();
        response.setHeader('Content-Type', asset[1]);
        response.end(readFileSync(resolve(sharedRoot, asset[0])));
      });
    },
  };
}
