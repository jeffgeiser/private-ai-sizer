import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, sep } from 'node:path';
import { resolveRequestPath, createStaticServer, root } from '../scripts/serve.js';

test('resolveRequestPath maps normal URLs under the root', () => {
  assert.equal(resolveRequestPath('/'), join(root, 'web', 'index.html'));
  assert.equal(resolveRequestPath('/web/'), join(root, 'web', 'index.html'));
  assert.equal(resolveRequestPath('/data/gpus.json?x=1'), join(root, 'data', 'gpus.json'));
});

test('resolveRequestPath rejects malformed encoding instead of throwing', () => {
  assert.equal(resolveRequestPath('/%E0%A4%A'), null);
  assert.equal(resolveRequestPath('/%'), null);
});

test('resolveRequestPath blocks traversal, including sibling directories that share the prefix', () => {
  const base = join(sep, 'srv', 'private-ai-sizer');
  // The URL parser already folds a literal "/../" back under the root...
  assert.equal(resolveRequestPath('/../private-ai-sizer-secrets/key', base), join(base, 'private-ai-sizer-secrets', 'key'));
  // ...but an encoded slash survives it. This resolves to /srv/private-ai-sizer-secrets/key,
  // which a bare startsWith(base) check would have allowed.
  assert.equal(resolveRequestPath('/..%2fprivate-ai-sizer-secrets/key', base), null);
  assert.equal(resolveRequestPath('/..%2f..%2fetc/passwd', base), null);
  assert.equal(resolveRequestPath('/a%00b', base), null);
  assert.equal(resolveRequestPath('/web/app.js', base), join(base, 'web', 'app.js'));
});

test('the server answers 400 on a malformed URL and keeps serving', async () => {
  const server = createStaticServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const bad = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
    assert.equal(bad.status, 400);
    const ok = await fetch(`http://127.0.0.1:${port}/data/gpus.json`);
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).gpus.length > 0);
    const missing = await fetch(`http://127.0.0.1:${port}/nope.txt`);
    assert.equal(missing.status, 404);
    const dir = await fetch(`http://127.0.0.1:${port}/data`);
    assert.equal(dir.status, 404);
    const post = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
    assert.equal(post.status, 405);
  } finally {
    server.close();
  }
});
