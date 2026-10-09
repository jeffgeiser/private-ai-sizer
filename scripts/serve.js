// Minimal static server for the reference page: node scripts/serve.js [port]
// Serves the repo root so /web/, /src/ and /data/ resolve the same way they
// will on a static host. Logs paths only; the scenario lives in the URL
// fragment, which browsers never send.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.md': 'text/plain', '.svg': 'image/svg+xml' };

/**
 * Map a request URL to a file under `base`, or null if the URL is malformed or
 * would escape `base`. Exported for tests.
 */
export function resolveRequestPath(url, base = root) {
  let path;
  try {
    path = decodeURIComponent(new URL(url, 'http://x').pathname);
  } catch {
    return null; // malformed percent-encoding, e.g. "/%E0%A4%A"
  }
  if (path.includes('\0')) return null;
  if (path === '/') path = '/web/index.html';
  if (path.endsWith('/')) path += 'index.html';
  const file = resolve(join(base, path));
  // Compare against base + separator so "/repo-other" can't pass as "/repo".
  if (file !== base && !file.startsWith(base.endsWith(sep) ? base : base + sep)) return null;
  return file;
}

export function createStaticServer(base = root) {
  return createServer(async (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' }).end();
        return;
      }
      const file = resolveRequestPath(req.url, base);
      if (!file) {
        res.writeHead(400).end('Bad request');
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404).end('Not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': (types[extname(file)] || 'application/octet-stream') + '; charset=utf-8', 'x-content-type-options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 8080);
  createStaticServer().listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/web/`));
}
