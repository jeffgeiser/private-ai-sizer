// Load the reference data from disk (Node). The browser page fetches the same files.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'));

export function loadData() {
  return { gpus: read('gpus.json'), models: read('models.json'), throughput: read('throughput.json') };
}
