import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import { defaultScenario, applyBorderPreset, BORDER_PRESETS } from '../src/scenario.js';
import { loadData } from '../src/data-node.js';

const data = loadData();
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const scenario = (patch = {}) => {
  const s = defaultScenario();
  return { ...s, ...patch, advanced: { ...s.advanced, ...(patch.advanced || {}) }, levers: { ...s.levers, ...(patch.levers || {}) } };
};

// Small deterministic PRNG so property tests are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomScenario(r) {
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  const gpu = pick(data.gpus.gpus);
  const B = 1 + Math.floor(r() * 8);
  return scenario({
    workload: pick(data.throughput.workloads).id,
    model: pick(data.models.models).id,
    gpu: gpu.id,
    precision: pick(gpu.precisions),
    demand: { mode: 'tokens', tokensPerDay: Math.pow(10, 6 + r() * 5) },
    borders: Array.from({ length: B }, (_, i) => ({ name: `B${i}`, tz: Math.round(r() * 24 - 12), share: 0.1 + r() * 5, group: r() < 0.3 ? 'G' : undefined })),
    advanced: {
      redundancy: Math.floor(r() * 3),
      headroom: r(),
      shape: pick(['flat', 'business']),
      purchaseUnit: pick(['unit', 'gpu', 'custom']),
      customUnitGpus: pick([2, 4, 8]),
      variants: pick([1, 1, 2, 5, 20]),
      variantMode: pick(['separate', 'adapters']),
      leaveShare: pick([0, 0.1, 0.5]),
      prices: { gpuHour: 0, apiInPerM: 0, apiOutPerM: 0 },
    },
    levers: { burst: r() < 0.7, pool: r() < 0.7, units: r() < 0.7, rightsize: r() < 0.5, adapters: r() < 0.7 },
  });
}

// ---------------------------------------------------------------------------

describe('reference data', () => {
  test('every record carries a label and a source', () => {
    for (const g of data.gpus.gpus) {
      assert.ok(g.label in E.LABEL_RANK, g.id);
      assert.ok(g.source, g.id);
      for (const p of g.precisions) assert.ok(g.denseTflops[p] > 0, `${g.id} ${p}`);
      assert.ok(g.memoryGB > 0 && g.memoryBandwidthTBs > 0 && g.gpusPerUnit > 0 && g.unitPowerKW > 0, g.id);
    }
    for (const m of data.models.models) {
      assert.ok(m.label in E.LABEL_RANK && m.source, m.id);
      assert.ok(m.activeParamsB <= m.totalParamsB, m.id);
    }
    for (const w of data.throughput.workloads) {
      assert.ok(w.label in E.LABEL_RANK, w.id);
      assert.ok(w.cacheHitSplit <= w.cacheHitPooled, `${w.id}: split hit rate above pooled`);
    }
    for (const r of data.throughput.rows) assert.ok(r.label in E.LABEL_RANK && r.source);
  });

  test('every file is versioned', () => {
    for (const f of [data.gpus, data.models, data.throughput]) {
      assert.match(f.version, /^\d{4}\.\d+\.\d+$/);
      assert.match(f.updated, /^\d{4}-\d{2}-\d{2}$/);
    }
  });

  test('the default GPU is B300', () => {
    assert.equal(defaultScenario().gpu, 'b300');
    assert.ok(data.gpus.gpus.find((g) => g.id === 'b300'));
  });
});

describe('step 1: hourly demand', () => {
  test('daily demand is preserved across shapes and time zones', () => {
    for (const shape of ['flat', 'business']) {
      const s = scenario({ advanced: { shape }, borders: [{ name: 'a', tz: 5.5, share: 1 }, { name: 'b', tz: -8, share: 3 }] });
      const w = E.resolveWorkload(s, data);
      const bs = E.hourlyDemand(s, w);
      const total = sum(bs.map((b) => sum(b.curve))) * 3600;
      assert.ok(Math.abs(total - E.requestsPerDay(s, w)) / total < 1e-9);
      assert.ok(Math.abs(bs[0].share - 0.25) < 1e-12);
    }
  });

  test('a time-zone shift moves the peak hour', () => {
    const s = scenario({ advanced: { shape: 'business' }, borders: [{ name: 'a', tz: 0 }, { name: 'b', tz: 6 }] });
    const [a, b] = E.hourlyDemand(s, E.resolveWorkload(s, data));
    const peakHour = (c) => c.indexOf(Math.max(...c));
    assert.equal((peakHour(a.curve) - peakHour(b.curve) + 24) % 24, 6);
  });

  test('requests mode uses requests per day directly', () => {
    const s = scenario({ demand: { mode: 'requests', requestsPerDay: 86400 } });
    assert.equal(E.requestsPerDay(s, E.resolveWorkload(s, data)), 86400);
  });

  test('custom shape must be 24 values', () => {
    assert.throws(() => E.shapeWeights(scenario({ advanced: { shape: 'custom', customShape: [1, 2] } })));
  });
});

describe('step 2: GPUs per copy', () => {
  const get = (model, gpu, precision, workload = 'agent') => {
    const s = scenario({ model, gpu, precision, workload });
    return E.gpusPerCopy(E.resolveModel(s, data), E.resolveGpu(s, data), precision, E.resolveWorkload(s, data), data, 'auto');
  };

  test('picks the smallest size that fits weights plus KV', () => {
    const s = scenario({ model: 'llama-3.3-70b', gpu: 'h100-sxm', precision: 'FP8' });
    const m = E.resolveModel(s, data);
    const gpu = E.resolveGpu(s, data);
    const w = E.resolveWorkload(s, data);
    const g = E.gpusPerCopy(m, gpu, 'FP8', w, data, 'auto');
    const need = E.memoryNeedGB(m, 'FP8', w, w.targetConcurrency, data);
    assert.ok(g * gpu.memoryGB * 0.9 >= need);
    if (g > 1) assert.ok((g / 2) * gpu.memoryGB * 0.9 < need);
  });

  test('KV bytes per token follow 2 * layers * kv heads * head dim * bytes', () => {
    const m = data.models.models.find((x) => x.id === 'llama-3.3-70b');
    assert.equal(E.kvBytesPerToken(m, 'BF16', data), 2 * 80 * 8 * 128 * 2);
  });

  test('more memory or lower precision never needs more GPUs', () => {
    assert.ok(get('llama-3.3-70b', 'b300', 'FP8') <= get('llama-3.3-70b', 'h100-sxm', 'FP8'));
    assert.ok(get('llama-3.3-70b', 'h100-sxm', 'FP8') <= get('llama-3.3-70b', 'h100-sxm', 'BF16'));
  });

  test('a model that fits nowhere gives a clear message, not a number', () => {
    const r = E.calculate(scenario({ model: 'qwen3-235b-a22b', gpu: 'l40s', precision: 'BF16' }), data);
    assert.ok(r.error);
    assert.match(r.error, /doesn.t fit/);
  });

  test('unsupported precision is rejected', () => {
    const r = E.calculate(scenario({ gpu: 'h100-sxm', precision: 'FP4' }), data);
    assert.match(r.error, /doesn.t support FP4/);
  });
});

describe('step 3: throughput per copy', () => {
  const tp = (patch, hit) => {
    const s = scenario(patch);
    const ctx = E.buildContext(s, data);
    return E.modeledThroughput({ model: ctx.model, gpu: ctx.gpu, precision: ctx.precision, workload: ctx.workload, g: ctx.g, cacheHit: hit, data });
  };

  test('a lower cache hit rate lowers throughput', () => {
    assert.ok(tp({}, 0.2).rps < tp({}, 0.6).rps);
  });

  test('meets the per-user speed target when it can', () => {
    const t = tp({}, 0.5);
    assert.ok(t.meetsSpeed);
    assert.ok(t.perUserTokPerSec >= E.resolveWorkload(scenario(), data).outputTokensPerSecPerUser);
  });

  test('more bandwidth means more throughput (same memory fit)', () => {
    const h100 = tp({ gpu: 'h100-sxm', advanced: { gpusPerCopy: 8 } }, 0.5);
    const h200 = tp({ gpu: 'h200-sxm', advanced: { gpusPerCopy: 8 } }, 0.5);
    assert.ok(h200.rps > h100.rps);
  });

  test('AMD software efficiency reduces throughput at equal bandwidth', () => {
    const mi = tp({ gpu: 'mi355x', advanced: { gpusPerCopy: 1 } }, 0.5);
    const nv = tp({ gpu: 'b300', advanced: { gpusPerCopy: 1 } }, 0.5);
    // MI355X and B300 share 288 GB and 8 TB/s; the difference is the factor.
    assert.ok(mi.rps < nv.rps);
  });

  test('a measured row replaces the model and keeps its label', () => {
    const s = scenario({ gpu: 'h100-sxm', advanced: { gpusPerCopy: 8 } });
    const ctx = E.buildContext(s, data);
    const withRow = structuredClone(data);
    withRow.throughput.rows = [{ model: 'llama-3.3-70b', gpu: 'h100-sxm', precision: 'FP8', workload: 'agent', gpusPerCopy: 8, cacheHit: ctx.hit.pooled, requestsPerSecPerCopy: 12.5, label: 'measured', source: 'test' }];
    const t = E.throughputPerCopy({ model: ctx.model, gpu: ctx.gpu, precision: 'FP8', workload: ctx.workload, g: 8, cacheHit: ctx.hit.pooled, variants: ctx.variants, data: withRow });
    assert.equal(t.rps, 12.5);
    assert.equal(t.label, 'measured');
    const split = E.throughputPerCopy({ model: ctx.model, gpu: ctx.gpu, precision: 'FP8', workload: ctx.workload, g: 8, cacheHit: ctx.hit.split, variants: ctx.variants, data: withRow });
    assert.ok(split.rps < 12.5);
    assert.equal(split.label, 'modeled');
  });

  test('adapters cost throughput, more adapters cost more', () => {
    const t = data.throughput.scaling.adapterThroughputFactor;
    assert.ok(E.adapterFactor(1, t) > E.adapterFactor(10, t));
    assert.ok(E.adapterFactor(10, t) > E.adapterFactor(50, t));
    assert.ok(E.adapterFactor(5, t) < E.adapterFactor(1, t) && E.adapterFactor(5, t) > E.adapterFactor(10, t));
  });
});

describe('steps 4–6: copies, GPUs, shared pool', () => {
  test('copies follow max(1, ceil(peak(1+h)/R)) + r', () => {
    const ctx = { headroom: 0.25, veff: 1, redundancy: 1 };
    assert.equal(E.copiesForPool(0, ctx, 1), 2);
    assert.equal(E.copiesForPool(0.8, ctx, 1), 2);
    assert.equal(E.copiesForPool(0.81, ctx, 1), 3);
    assert.equal(E.copiesForPool(4, { ...ctx, redundancy: 2 }, 1), 7);
  });

  test('rounds up to the purchase unit', () => {
    assert.equal(E.ceilTo(9, 8), 16);
    assert.equal(E.ceilTo(16, 8), 16);
    assert.equal(E.ceilTo(3, 1), 3);
  });

  test('the shared pool is sized to the peak of the summed curve', () => {
    const s = scenario({ advanced: { shape: 'business' }, borders: [{ name: 'a', tz: -8 }, { name: 'b', tz: 8 }] });
    const ctx = E.buildContext(s, data);
    assert.ok(ctx.pooledPeak < sum(ctx.borders.map((b) => b.peak)));
  });

  test('zero demand still shows the floor', () => {
    const r = E.calculate(scenario({ demand: { mode: 'tokens', tokensPerDay: 0 } }), data);
    assert.ok(!r.error);
    assert.ok(r.bordered.gpus > 0 && r.shared.gpus > 0);
    for (const b of r.borders) assert.ok(b.copies >= 2);
  });

  test('separate variants are each deployed; adapters are one deployment', () => {
    const sep = E.calculate(scenario({ advanced: { variants: 4, variantMode: 'separate', purchaseUnit: 'gpu' } }), data);
    const ad = E.calculate(scenario({ advanced: { variants: 4, variantMode: 'adapters', purchaseUnit: 'gpu' } }), data);
    assert.ok(sep.bordered.gpus > ad.bordered.gpus);
  });
});

describe('step 7: tax and waterfall', () => {
  test('one border with no extra constraints gives exactly the shared-pool answer', () => {
    for (const patch of [{}, { gpu: 'h100-sxm' }, { advanced: { variants: 3 } }, { advanced: { redundancy: 2, purchaseUnit: 'gpu' } }]) {
      const r = E.calculate({ ...scenario(patch), borders: [{ name: 'only', tz: 3, share: 1 }] }, data);
      assert.equal(r.bordered.gpus, r.shared.gpus);
      assert.equal(r.tax.gpus, 0);
      for (const c of r.causes) assert.equal(c.gpus, 0, c.id);
    }
  });

  test('the six causes are fixed and in order', () => {
    const r = E.calculate(scenario(), data);
    assert.deepEqual(r.causes.map((c) => c.id), ['peaks', 'floor', 'redundancy', 'rounding', 'models', 'caches']);
  });

  test('the waterfall state functions match the direct sizing at both ends', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const s = randomScenario(rng(seed));
      const ctx = E.buildContext(s, data);
      if (ctx.error) continue;
      assert.equal(E.waterfallState(ctx, 0), E.sizeSharedPool(ctx).gpus, `seed ${seed}`);
      assert.equal(E.waterfallState(ctx, 6), sum(E.sizeBorders(ctx).map((b) => b.gpus)), `seed ${seed}`);
      assert.ok(E.waterfallState(ctx, 6) >= E.waterfallState(ctx, 0), `seed ${seed}`);
    }
  });
});

describe('step 8: levers', () => {
  test('the levers are fixed and in order', () => {
    const s = scenario({ levers: { burst: true, pool: true, units: true, rightsize: true, adapters: true } });
    assert.deepEqual(E.calculate(s, data).levers.map((l) => l.id), ['burst', 'pool', 'units', 'rightsize', 'adapters']);
  });

  test('pooling borders in one jurisdiction collapses them to the shared pool', () => {
    const s = applyBorderPreset(scenario({ levers: { burst: false, units: false, rightsize: false, adapters: false } }), 'units');
    const r = E.calculate(s, data);
    assert.equal(r.afterLevers.gpus, r.shared.gpus);
  });

  test('buying single GPUs removes the rounding', () => {
    const r = E.calculate(scenario({ levers: { burst: false, pool: false, units: true, rightsize: false, adapters: false } }), data);
    const step = r.levers.find((l) => l.id === 'units');
    assert.ok(step.applied && step.gpus < 0);
  });

  test('a lever that would add GPUs is skipped and says so', () => {
    // A tiny burst share needs its own floor and spare, which costs more than it saves.
    const r = E.calculate(scenario({ advanced: { leaveShare: 0.01 }, levers: { burst: true } }), data);
    const step = r.levers.find((l) => l.id === 'burst');
    assert.equal(step.gpus, 0);
    assert.equal(step.applied, false);
  });

  test('right-sizing defaults to the next smaller model', () => {
    assert.equal(E.defaultRightSizeTarget(scenario(), data), 'qwen3-32b');
    assert.equal(E.defaultRightSizeTarget(scenario({ model: 'llama-3.1-8b' }), data), null);
  });
});

describe('step 9: utilization, power and cost', () => {
  test('utilization is demand in GPU-equivalents over deployed GPUs', () => {
    const r = E.calculate(scenario(), data);
    for (const b of r.borders) {
      assert.ok(Math.abs(b.utilAvg - b.demandGpusAvg / b.gpus) < 1e-12);
      assert.ok(b.utilPeak >= b.utilAvg);
      assert.ok(b.utilPeak <= 1 + 1e-9);
    }
  });

  test('IT power is servers times kW per server; PUE gives facility power', () => {
    const r = E.calculate(scenario({ advanced: { pue: 1.3 } }), data);
    const kw = data.gpus.gpus.find((g) => g.id === 'b300').unitPowerKW;
    assert.ok(Math.abs(r.bordered.power.it - r.bordered.units * kw) < 1e-9);
    assert.ok(Math.abs(r.bordered.power.facility - r.bordered.power.it * 1.3) < 1e-9);
  });

  test('private cost is GPUs x price x 730 hours', () => {
    assert.equal(E.privateMonthlyCost(16, 2.5), 16 * 2.5 * 730);
  });

  test('API cost splits tokens by prompt and answer length', () => {
    const w = { promptTokens: 3, answerTokens: 1 };
    const cost = E.apiMonthlyCost(1e6 / E.DAYS_PER_MONTH, w, { apiInPerM: 4, apiOutPerM: 8 });
    assert.ok(Math.abs(cost - (0.75 * 4 + 0.25 * 8)) < 1e-9);
  });

  test('at the crossover, private and API cost are equal (within one step)', () => {
    const s = scenario();
    const prices = s.advanced.prices;
    const x = E.crossover(s, data, prices);
    assert.ok(x && x.tokensPerMonth > 0);
    const tpd = x.tokensPerMonth / E.DAYS_PER_MONTH;
    const priv = (t) => E.privateMonthlyCost(E.borderedTotal({ ...s, demand: { mode: 'tokens', tokensPerDay: t } }, data), prices.gpuHour);
    const api = (t) => E.apiMonthlyCost(t, E.resolveWorkload(s, data), prices);
    assert.ok(priv(tpd) <= api(tpd) + 1e-6);
    assert.ok(priv(tpd * 0.999) > api(tpd * 0.999));
  });

  test('no cost view without prices', () => {
    const r = E.calculate(scenario({ advanced: { prices: { gpuHour: 0, apiInPerM: 0, apiOutPerM: 0 } } }), data);
    assert.equal(r.cost, null);
  });
});

describe('labels', () => {
  test('the weakest label wins', () => {
    assert.equal(E.weakestLabel('measured', 'published'), 'published');
    assert.equal(E.weakestLabel('measured', 'modeled', 'published'), 'modeled');
    assert.equal(E.weakestLabel(['measured']), 'measured');
  });

  test('every result carries a label', () => {
    const r = E.calculate(scenario(), data);
    for (const l of Object.values(r.labels)) assert.ok(l in E.LABEL_RANK);
  });
});

// ---------------------------------------------------------------------------
// Validation checks from the spec, run over many random scenarios.

describe('validation: behaves sensibly', () => {
  const N = 1500;

  test('waterfall adds up exactly to the bordered and after-levers totals', () => {
    for (let seed = 1; seed <= N; seed++) {
      const r = E.calculate(randomScenario(rng(seed)), data);
      if (r.error) continue;
      assert.equal(r.shared.gpus + sum(r.causes.map((c) => c.gpus)), r.bordered.gpus, `seed ${seed}`);
      assert.equal(r.bordered.gpus + sum(r.levers.map((l) => l.gpus)), r.afterLevers.gpus, `seed ${seed}`);
    }
  });

  test('no lever ever increases the total', () => {
    for (let seed = 1; seed <= N; seed++) {
      const r = E.calculate(randomScenario(rng(seed)), data);
      if (r.error) continue;
      for (const l of r.levers) assert.ok(l.gpus <= 0, `seed ${seed} ${l.id}: ${l.gpus}`);
      assert.ok(r.afterLevers.gpus <= r.bordered.gpus);
    }
  });

  test('the tax is never negative and the cause steps are never negative', () => {
    for (let seed = 1; seed <= N; seed++) {
      const r = E.calculate(randomScenario(rng(seed)), data);
      if (r.error) continue;
      assert.ok(r.tax.gpus >= 0, `seed ${seed}`);
      for (const c of r.causes) assert.ok(c.gpus >= 0, `seed ${seed} ${c.id}: ${c.gpus}`);
    }
  });

  test('more borders never need fewer GPUs', () => {
    for (let seed = 1; seed <= N; seed++) {
      const s = randomScenario(rng(seed));
      const before = E.borderedTotal(s, data);
      if (before == null) continue;
      // Split the first border in two, same time zone, same total share.
      const [first, ...rest] = s.borders;
      const f = rng(seed * 7)() * 0.9 + 0.05;
      const split = { ...s, borders: [{ ...first, share: first.share * f }, { ...first, name: 'split', share: first.share * (1 - f) }, ...rest] };
      assert.ok(E.borderedTotal(split, data) >= before, `seed ${seed}`);
    }
  });

  test('every border preset runs', () => {
    for (const p of BORDER_PRESETS) {
      const r = E.calculate(applyBorderPreset(scenario(), p.id), data);
      assert.ok(!r.error, p.id);
    }
    const single = E.calculate(applyBorderPreset(scenario(), 'single'), data);
    assert.equal(single.tax.gpus, 0);
  });
});

// ---------------------------------------------------------------------------
// Reproduces the deck.

describe('validation: reproduces the deck', () => {
  // The deck's assumptions: 70B FP8 on H100, one 8-GPU server per model copy,
  // N+1, whole-server purchase, 2 B tokens/day split evenly over six borders.
  // The deck sized to average demand, so the shape is flat here. If the H100
  // footprint test changes GPUs per copy, update the deck and this fixture together.
  const deck = scenario({
    gpu: 'h100-sxm',
    model: 'llama-3.3-70b',
    precision: 'FP8',
    workload: 'agent',
    demand: { mode: 'tokens', tokensPerDay: 2e9 },
    advanced: { gpusPerCopy: 8, shape: 'flat', redundancy: 1, purchaseUnit: 'unit', headroom: 0.25 },
  });

  test('slide 10: 16 GPUs as one shared pool vs 96 across six borders', () => {
    const r = E.calculate(deck, data);
    assert.equal(r.g, 8);
    assert.equal(r.shared.gpus, 16);
    assert.equal(r.bordered.gpus, 96);
  });

  test('slide 11: a 1% market still deploys 16 GPUs', () => {
    const s = applyBorderPreset(deck, 'newmarket');
    const r = E.calculate(s, data);
    const small = r.borders.find((b) => b.name === 'New market');
    assert.equal(small.gpus, 16);
  });

  test.todo('slide 11: about 3 GPUs of demand and about 7% utilization in the 1% market — needs the deck’s total demand for that slide');
});
