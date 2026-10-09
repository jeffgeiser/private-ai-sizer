import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultScenario, encodeScenario, decodeScenario, normalizeScenario, applyBorderPreset } from '../src/scenario.js';
import { calculate } from '../src/engine.js';
import { loadData } from '../src/data-node.js';

const data = loadData();
const XSS = '"><img src=x onerror=alert(1)>';
const link = (obj) => '#' + encodeScenario(obj);

test('share-link numbers that arrive as strings or markup fall back to safe numbers', () => {
  const evil = defaultScenario();
  evil.borders = [{ name: XSS, tz: XSS, share: XSS, group: XSS }];
  evil.advanced.redundancy = XSS;
  evil.advanced.variants = XSS;
  evil.advanced.customUnitGpus = XSS;
  evil.advanced.targetConcurrency = XSS;
  evil.advanced.ttftMsP95 = '<b>';
  const s = decodeScenario(link(evil), data);
  assert.equal(s.borders[0].tz, 0);
  assert.equal(s.borders[0].share, 1);
  assert.equal(typeof s.borders[0].name, 'string'); // text is kept, escaped at render time
  assert.equal(s.advanced.redundancy, 1);
  assert.equal(s.advanced.variants, 1);
  assert.equal(s.advanced.customUnitGpus, 8);
  assert.equal(s.advanced.targetConcurrency, null);
  assert.equal(s.advanced.ttftMsP95, null);
});

test('every numeric field of a decoded scenario is a finite number or null', () => {
  const evil = defaultScenario();
  for (const k of Object.keys(evil.advanced)) evil.advanced[k] = XSS;
  evil.demand = { mode: XSS, tokensPerDay: XSS, requestsPerDay: { a: 1 } };
  const s = decodeScenario(link(evil), data);
  const d = defaultScenario();
  for (const [k, v] of Object.entries(s.advanced)) {
    if (k === 'gpusPerCopy') assert.equal(v, 'auto');
    else if (typeof d.advanced[k] === 'number') assert.ok(Number.isFinite(v), k);
    else if (typeof d.advanced[k] === 'string') assert.equal(v, d.advanced[k], k);
    else assert.equal(v, null, k);
  }
  assert.deepEqual(s.demand, d.demand);
});

test('enums and catalog ids are restricted to known values', () => {
  const evil = { ...defaultScenario(), workload: 'nope', model: XSS, gpu: 'h999', precision: XSS, ui: { view: XSS, breakdown: 'yes' } };
  evil.advanced = { ...evil.advanced, shape: XSS, purchaseUnit: XSS, variantMode: XSS, gpusPerCopy: 3, rightSizeModel: 'not-a-model' };
  const s = decodeScenario(link(evil), data);
  const d = defaultScenario();
  assert.equal(s.workload, d.workload);
  assert.equal(s.model, d.model);
  assert.equal(s.gpu, d.gpu);
  assert.equal(s.precision, d.precision);
  assert.deepEqual(s.ui, d.ui);
  assert.equal(s.advanced.shape, d.advanced.shape);
  assert.equal(s.advanced.purchaseUnit, d.advanced.purchaseUnit);
  assert.equal(s.advanced.variantMode, d.advanced.variantMode);
  assert.equal(s.advanced.gpusPerCopy, 'auto');
  assert.equal(s.advanced.rightSizeModel, null);
});

test('a precision the chosen GPU does not support is replaced', () => {
  const gpu = data.gpus.gpus.find((g) => !g.precisions.includes('FP4')) || data.gpus.gpus[0];
  const s = normalizeScenario({ gpu: gpu.id, precision: 'FP4' }, data);
  assert.ok(gpu.precisions.includes(s.precision));
});

test('ranges are clamped and borders are capped', () => {
  const s = normalizeScenario({
    borders: Array.from({ length: 50 }, (_, i) => ({ name: 'x'.repeat(500), tz: 99, share: -5, group: i })),
    advanced: { leaveShare: 7, headroom: -1, redundancy: 2.6, variants: 1e9, cacheHitPooled: 3, pue: 0.2 },
  });
  assert.equal(s.borders.length, 20);
  assert.equal(s.borders[0].tz, 14);
  assert.equal(s.borders[0].share, 0);
  assert.equal(s.borders[0].name.length, 64);
  assert.equal(s.borders[0].group, undefined, 'non-string group is dropped');
  assert.equal(s.advanced.leaveShare, 1);
  assert.equal(s.advanced.headroom, 0);
  assert.equal(s.advanced.redundancy, 3);
  assert.equal(s.advanced.variants, 100);
  assert.equal(s.advanced.cacheHitPooled, 1);
  assert.equal(s.advanced.pue, 1);
});

test('unknown keys are dropped and non-object payloads are rejected', () => {
  const s = normalizeScenario({ __proto__: { polluted: true }, extra: XSS, advanced: { extra: 1 } });
  assert.equal(s.extra, undefined);
  assert.equal(s.advanced.extra, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal(decodeScenario('#' + 's=' + Buffer.from('[1,2]').toString('base64url')), null);
  assert.equal(decodeScenario('#' + 's=' + Buffer.from('"str"').toString('base64url')), null);
  assert.equal(decodeScenario(null), null);
  assert.equal(decodeScenario({}), null);
});

test('valid scenarios survive validation unchanged, so old share links still work', () => {
  for (const preset of ['default', 'europe5', 'units', 'newmarket']) {
    const s = applyBorderPreset(defaultScenario(), preset);
    s.advanced.gpusPerCopy = 2;
    s.advanced.customShape = Array(24).fill(1);
    s.advanced.shape = 'custom';
    s.model = 'custom';
    s.customModel = { name: 'Mine', totalParamsB: 8, activeParamsB: 8, layers: 32, kvHeads: 8, headDim: 128 };
    assert.deepEqual(decodeScenario(link(s), data), s, preset);
  }
});

test('a validated hostile scenario still calculates or returns a clean error', () => {
  const evil = defaultScenario();
  evil.borders = [{ name: XSS, tz: XSS, share: XSS }];
  for (const k of Object.keys(evil.advanced)) evil.advanced[k] = XSS;
  const r = calculate(decodeScenario(link(evil), data), data);
  assert.ok(r.error ? typeof r.error === 'string' : r.bordered.gpus > 0);
});
