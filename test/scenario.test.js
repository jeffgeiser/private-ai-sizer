import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultScenario, encodeScenario, decodeScenario, normalizeScenario, applyBorderPreset, BORDER_PRESETS } from '../src/scenario.js';

test('defaults match the spec', () => {
  const s = defaultScenario();
  assert.equal(s.workload, 'agent');
  assert.equal(s.model, 'llama-3.3-70b');
  assert.equal(s.gpu, 'b300');
  assert.equal(s.precision, 'FP8');
  assert.equal(s.demand.tokensPerDay, 2e9);
  assert.equal(s.borders.length, 6);
  assert.equal(s.advanced.leaveShare, 0);
  assert.equal(s.advanced.redundancy, 1);
  assert.equal(s.advanced.headroom, 0.25);
  assert.equal(s.advanced.variants, 1);
  assert.equal(s.advanced.prices, null, 'no prices by default: the first release has no cost view');
});

test('a scenario survives the URL fragment round trip', () => {
  const s = applyBorderPreset(defaultScenario(), 'europe5');
  s.borders[0].name = 'Österreich – ü';
  s.advanced.headroom = 0.4;
  const frag = '#' + encodeScenario(s);
  assert.match(frag, /^#s=[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeScenario(frag), normalizeScenario(s));
});

test('bad or missing fragments decode to null', () => {
  assert.equal(decodeScenario(''), null);
  assert.equal(decodeScenario('#s=!!!'), null);
  assert.equal(decodeScenario('#s=abc'), null);
});

test('normalize fills missing fields from defaults', () => {
  const s = normalizeScenario({ gpu: 'h100-sxm', advanced: { headroom: 0.1 } });
  assert.equal(s.gpu, 'h100-sxm');
  assert.equal(s.advanced.headroom, 0.1);
  assert.equal(s.advanced.redundancy, 1);
  assert.equal(s.borders.length, 6);
});

test('all five spec presets exist', () => {
  for (const id of ['single', 'europe5', 'newmarket', 'global3', 'units']) assert.ok(BORDER_PRESETS.find((p) => p.id === id), id);
  const nm = BORDER_PRESETS.find((p) => p.id === 'newmarket');
  const total = nm.borders.reduce((a, b) => a + b.share, 0);
  assert.equal(nm.borders.find((b) => b.name === 'New market').share / total, 0.01);
});
