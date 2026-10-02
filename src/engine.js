// Distributed Private AI Sizer — sizing engine.
//
// Pure functions only: no DOM, no network, no clock. Every function takes the
// scenario and the reference data explicitly, so each step can be unit-tested
// and shown in the advanced panel. Nothing here sends input values anywhere.

export const PRECISIONS = ['BF16', 'FP8', 'FP4'];
export const BYTES_PER_PARAM = { BF16: 2, FP8: 1, FP4: 0.5 };
export const TP_SIZES = [1, 2, 4, 8];
export const HOURS_PER_MONTH = 730;
export const DAYS_PER_MONTH = HOURS_PER_MONTH / 24;

// Weakest label wins: a result built from mixed inputs takes the weakest one.
export const LABEL_RANK = { measured: 3, published: 2, modeled: 1 };

export const CAUSES = [
  { id: 'peaks', name: 'Peaks that don’t coincide' },
  { id: 'floor', name: 'Minimum deployment per region' },
  { id: 'redundancy', name: 'A spare in every region' },
  { id: 'rounding', name: 'Purchase-unit rounding' },
  { id: 'models', name: 'Duplicated models' },
  { id: 'caches', name: 'Fragmented caches' },
];

export const LEVERS = [
  { id: 'burst', name: 'Burst work that may leave its region' },
  { id: 'pool', name: 'Pool regions in the same jurisdiction' },
  { id: 'units', name: 'Buy in smaller units' },
  { id: 'rightsize', name: 'Right-size the model' },
  { id: 'adapters', name: 'Serve variants as adapters' },
];

const EPS = 1e-9;

export function weakestLabel(...labels) {
  const known = labels.flat().filter((l) => l in LABEL_RANK);
  if (!known.length) return 'modeled';
  return known.reduce((a, b) => (LABEL_RANK[b] < LABEL_RANK[a] ? b : a));
}

export function ceilTo(x, unit) {
  if (unit <= 0) throw new Error('purchase unit must be positive');
  return Math.ceil(x / unit - EPS) * unit;
}

/** Integer copies with a floor of one: max(1, ceil(x)). */
export function copiesWithFloor(x) {
  return Math.max(1, Math.ceil(x - EPS));
}

const sum = (xs) => xs.reduce((a, b) => a + b, 0);

// ---------------------------------------------------------------------------
// Reference-data lookups

export function findById(list, id, what) {
  const item = list.find((x) => x.id === id);
  if (!item) throw new Error(`Unknown ${what}: ${id}`);
  return item;
}

/** Resolve the model: a catalog id, or a custom object with the same fields. */
export function resolveModel(scenario, data) {
  if (scenario.model === 'custom') {
    const c = scenario.customModel || {};
    for (const k of ['totalParamsB', 'activeParamsB', 'layers', 'kvHeads', 'headDim']) {
      if (!(c[k] > 0)) throw new Error(`Custom model needs ${k}`);
    }
    return { id: 'custom', name: c.name || 'Custom model', label: 'modeled', source: 'user input', ...c };
  }
  return findById(data.models.models, scenario.model, 'model');
}

export function resolveGpu(scenario, data) {
  return findById(data.gpus.gpus, scenario.gpu, 'GPU');
}

export function resolveWorkload(scenario, data) {
  const base = findById(data.throughput.workloads, scenario.workload, 'workload');
  const o = scenario.advanced || {};
  const w = { ...base };
  if (o.ttftMsP95 > 0) w.ttftMsP95 = o.ttftMsP95;
  if (o.outputTokensPerSecPerUser > 0) w.outputTokensPerSecPerUser = o.outputTokensPerSecPerUser;
  if (o.targetConcurrency > 0) w.targetConcurrency = o.targetConcurrency;
  if (o.cacheHitPooled != null) w.cacheHitPooled = o.cacheHitPooled;
  if (o.cacheHitSplit != null) w.cacheHitSplit = o.cacheHitSplit;
  if (o.promptTokens > 0) w.promptTokens = o.promptTokens;
  if (o.answerTokens > 0) w.answerTokens = o.answerTokens;
  return w;
}

/** Smallest deployable purchase unit, in GPUs. */
export function purchaseUnitGpus(scenario, gpu) {
  const mode = scenario.advanced?.purchaseUnit || 'unit';
  if (mode === 'gpu') return 1;
  if (mode === 'custom') return Math.max(1, Math.round(scenario.advanced.customUnitGpus || 1));
  return gpu.gpusPerUnit;
}

// ---------------------------------------------------------------------------
// Step 1. Hourly demand per border

export const SHAPES = {
  flat: { name: 'Flat', weights: Array(24).fill(1), label: 'modeled' },
  // Synthetic business-hours curve in local time: quiet nights, ramp at
  // 7–9, plateau 9–17, taper through the evening.
  business: {
    name: 'Business hours',
    weights: [0.15, 0.15, 0.15, 0.15, 0.15, 0.15, 0.2, 0.4, 0.75, 1, 1, 1, 1, 1, 1, 1, 1, 0.75, 0.5, 0.35, 0.25, 0.2, 0.2, 0.15],
    label: 'modeled',
  },
};

export function shapeWeights(scenario) {
  const o = scenario.advanced || {};
  const id = o.shape || 'business';
  let w;
  if (id === 'custom') {
    w = o.customShape;
    if (!Array.isArray(w) || w.length !== 24 || w.some((x) => !(x >= 0)) || sum(w) <= 0) {
      throw new Error('Custom demand shape needs 24 non-negative hourly values');
    }
  } else {
    w = (SHAPES[id] || SHAPES.business).weights;
  }
  const mean = sum(w) / 24;
  return w.map((x) => x / mean); // normalized to mean 1
}

/** Weight at a fractional local hour, linearly interpolated (for half-hour zones). */
function weightAt(w, localHour) {
  const h = ((localHour % 24) + 24) % 24;
  const i = Math.floor(h);
  const f = h - i;
  return w[i] * (1 - f) + w[(i + 1) % 24] * f;
}

/** Requests per day across all borders, before any burst share is taken out. */
export function requestsPerDay(scenario, workload) {
  const d = scenario.demand || {};
  if (d.mode === 'requests') return Math.max(0, d.requestsPerDay || 0);
  const perRequest = workload.promptTokens + workload.answerTokens;
  return Math.max(0, d.tokensPerDay || 0) / perRequest;
}

/** Share of demand carried in-border: all of it, unless the burst lever moved some out. */
export function inBorderShare(scenario) {
  return 1 - Math.min(1, Math.max(0, scenario.burstShare || 0));
}

export function normalizedShares(borders) {
  const raw = borders.map((b) => Math.max(0, b.share ?? 1));
  const t = sum(raw);
  return t > 0 ? raw.map((s) => s / t) : raw.map(() => 1 / borders.length);
}

/**
 * Hourly requests per second for each border, indexed by UTC hour.
 * A border at UTC+tz sees local hour (utc + tz).
 */
export function hourlyDemand(scenario, workload) {
  const w = shapeWeights(scenario);
  const avgRps = (requestsPerDay(scenario, workload) * inBorderShare(scenario)) / 86400;
  const shares = normalizedShares(scenario.borders);
  return scenario.borders.map((b, i) => {
    const curve = Array.from({ length: 24 }, (_, utc) => avgRps * shares[i] * weightAt(w, utc + (b.tz || 0)));
    return { name: b.name, share: shares[i], curve, peak: Math.max(...curve), avg: sum(curve) / 24 };
  });
}

export function sumCurves(curves) {
  return Array.from({ length: 24 }, (_, h) => sum(curves.map((c) => c[h])));
}

// ---------------------------------------------------------------------------
// Step 2. GPUs per model copy (memory fit)

export function kvBytesPerToken(model, precision, data) {
  const bkv = data.throughput.scaling.kvBytesByPrecision[precision];
  return 2 * model.layers * model.kvHeads * model.headDim * bkv;
}

export function memoryNeedGB(model, precision, workload, concurrency, data) {
  const weights = model.totalParamsB * 1e9 * BYTES_PER_PARAM[precision];
  const context = workload.promptTokens + workload.answerTokens;
  const kv = concurrency * context * kvBytesPerToken(model, precision, data);
  return (weights + kv) / 1e9;
}

/** Concurrent requests whose KV cache fits next to the weights on g GPUs. */
export function maxConcurrencyThatFits(model, gpu, precision, workload, g, data) {
  const usable = g * gpu.memoryGB * 1e9 * data.throughput.scaling.memoryFitFraction;
  const weights = model.totalParamsB * 1e9 * BYTES_PER_PARAM[precision];
  const perRequest = (workload.promptTokens + workload.answerTokens) * kvBytesPerToken(model, precision, data);
  return Math.floor((usable - weights) / perRequest);
}

/**
 * Every tensor-parallel size g in {1,2,4,8} where weights plus the KV cache
 * for the target concurrency fit in ~90% of GPU memory:
 *   g * M_gpu * 0.9 >= P*b + c*L*2*n_layers*n_kv*d_head*b_kv
 * Ascending; empty when no size fits. An override pins one size, which only
 * has to hold the weights plus one request.
 */
export function fittingTpSizes(model, gpu, precision, workload, data, override) {
  if (override && override !== 'auto') {
    const g = Number(override);
    return maxConcurrencyThatFits(model, gpu, precision, workload, g, data) >= 1 ? [g] : [];
  }
  const need = memoryNeedGB(model, precision, workload, workload.targetConcurrency, data);
  return TP_SIZES.filter((g) => g <= gpu.gpusPerUnit && g * gpu.memoryGB * data.throughput.scaling.memoryFitFraction >= need);
}

/** Smallest fitting tensor-parallel size, or null. */
export function gpusPerCopy(model, gpu, precision, workload, data, override) {
  return fittingTpSizes(model, gpu, precision, workload, data, override)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Step 3. Throughput per copy

/** Linear interpolation in log(n) over a {n: factor} table. */
export function adapterFactor(n, table) {
  const pts = Object.entries(table).map(([k, v]) => [Number(k), v]).sort((a, b) => a[0] - b[0]);
  if (n <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [n1, f1] = pts[i];
    const [n0, f0] = pts[i - 1];
    if (n <= n1) {
      const t = (Math.log(n) - Math.log(n0)) / (Math.log(n1) - Math.log(n0));
      return f0 + t * (f1 - f0);
    }
  }
  return pts[pts.length - 1][1];
}

/**
 * Modeled throughput for one copy on g GPUs.
 * Prompt processing is compute-bound: scales with dense TFLOPS at the precision.
 * Answer generation is bandwidth-bound: each decode step reads the weights
 * touched plus every active request's KV cache.
 * Vendor software efficiency multiplies both (1.0 for NVIDIA).
 */
export function modeledThroughput({ model, gpu, precision, workload, g, cacheHit, data }) {
  const s = data.throughput.scaling;
  const eff = (gpu.softwareEfficiency ?? 1) * (s.tensorParallelEfficiency[String(g)] ?? 0.85);
  const tflops = gpu.denseTflops?.[precision];
  if (!(tflops > 0)) throw new Error(`${gpu.name} has no ${precision} throughput in the catalog`);

  const prefillTokPerSec = (g * tflops * 1e12 * s.prefillComputeEfficiency * eff) / (2 * model.activeParamsB * 1e9);

  const bpp = BYTES_PER_PARAM[precision];
  const total = model.totalParamsB * 1e9;
  const active = model.activeParamsB * 1e9;
  const kvTok = kvBytesPerToken(model, precision, data);
  const avgContext = workload.promptTokens + workload.answerTokens / 2;
  const bandwidth = g * gpu.memoryBandwidthTBs * 1e12 * s.decodeBandwidthEfficiency * eff;
  const stepSeconds = (c) => {
    // Mixture-of-experts: c tokens touch roughly 1-(1-a)^c of the expert weights.
    const a = active / total;
    const touched = active + (total - active) * (1 - Math.pow(1 - a, c));
    return (touched * bpp + c * avgContext * kvTok) / bandwidth;
  };

  // The latency target selects the throughput point: the largest concurrency,
  // up to the target and what memory allows, that still meets per-user speed.
  const memCap = maxConcurrencyThatFits(model, gpu, precision, { ...workload }, g, data);
  const cap = Math.max(1, Math.min(workload.targetConcurrency, memCap));
  let c = cap;
  while (c > 1 && 1 / stepSeconds(c) < workload.outputTokensPerSecPerUser) c--;
  const perUserTokPerSec = 1 / stepSeconds(c);
  const decodeTokPerSec = c / stepSeconds(c);

  const promptTokens = workload.promptTokens * (1 - cacheHit);
  const secondsPerRequest = promptTokens / prefillTokPerSec + workload.answerTokens / decodeTokPerSec;
  const ttftMs = (promptTokens / prefillTokPerSec) * 1000;

  return {
    rps: 1 / secondsPerRequest,
    concurrency: c,
    prefillTokPerSec,
    decodeTokPerSec,
    perUserTokPerSec,
    ttftMs,
    meetsSpeed: perUserTokPerSec >= workload.outputTokensPerSecPerUser,
    meetsTtft: ttftMs <= workload.ttftMsP95,
    label: 'modeled',
    rule: `Prompt scaled by ${precision} compute, answer by memory bandwidth (${gpu.memoryBandwidthTBs} TB/s) × software efficiency ${gpu.softwareEfficiency ?? 1}`,
  };
}

/** A measured or published row for this exact combination, if any. */
export function findThroughputRow(data, model, gpu, precision, workload) {
  return (data.throughput.rows || []).find(
    (r) => r.model === model.id && r.gpu === gpu.id && r.precision === precision && r.workload === workload.id,
  );
}

/**
 * Sustainable requests per second per copy at the latency target, R_eff.
 * A table row replaces the model; if its cache hit rate differs from the one
 * asked for, it is adjusted by the modeled ratio and becomes modeled.
 */
export function throughputPerCopy({ model, gpu, precision, workload, g, cacheHit, variants, data }) {
  const m = modeledThroughput({ model, gpu, precision, workload, g, cacheHit, data });
  let out = m;
  const row = findThroughputRow(data, model, gpu, precision, workload);
  if (row && row.gpusPerCopy === g) {
    const rowHit = row.cacheHit ?? cacheHit;
    let rps = row.requestsPerSecPerCopy;
    let label = row.label;
    let rule = `${row.label} (${row.source})`;
    if (Math.abs(rowHit - cacheHit) > EPS) {
      const atRow = modeledThroughput({ model, gpu, precision, workload, g, cacheHit: rowHit, data });
      rps *= m.rps / atRow.rps;
      label = weakestLabel(label, 'modeled');
      rule += `; adjusted for cache hit ${Math.round(cacheHit * 100)}% vs ${Math.round(rowHit * 100)}% measured`;
    }
    out = { ...m, rps, label, rule };
  }
  if (variants?.mode === 'adapters' && variants.count > 1) {
    const f = adapterFactor(variants.count, data.throughput.scaling.adapterThroughputFactor);
    out = { ...out, rps: out.rps * f, adapterFactor: f, label: weakestLabel(out.label, data.throughput.scaling.label) };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Steps 4–7. Copies, GPUs, shared pool, tax and waterfall

/**
 * Build the sizing context for a scenario at one tensor-parallel size:
 * everything that doesn't depend on how constraints are toggled. Without g,
 * the smallest fitting size is used; tpContexts builds one per fitting size.
 */
export function buildContext(scenario, data, gAt) {
  const model = resolveModel(scenario, data);
  const gpu = resolveGpu(scenario, data);
  const workload = resolveWorkload(scenario, data);
  const o = scenario.advanced || {};
  const precision = scenario.precision;
  if (!gpu.precisions.includes(precision)) {
    return { error: `${gpu.name} doesn't support ${precision}. Supported: ${gpu.precisions.join(', ')}.` };
  }
  const tpSizes = fittingTpSizes(model, gpu, precision, workload, data, o.gpusPerCopy);
  if (gAt != null && !tpSizes.includes(gAt)) return { error: `${gAt} GPUs per copy doesn\u2019t fit ${model.name} at ${precision}.` };
  const g = gAt ?? tpSizes[0];
  if (!g) {
    return {
      error: `${model.name} at ${precision} doesn't fit on up to 8 × ${gpu.name} (${gpu.memoryGB} GB each) with room for its KV cache. Try lower precision, a GPU with more memory, or a smaller model.`,
      model, gpu, workload,
    };
  }
  const borders = hourlyDemand(scenario, workload);
  if (!borders.length) return { error: 'Add at least one region.' };
  const pooledCurve = sumCurves(borders.map((b) => b.curve));
  const variants = { count: Math.max(1, Math.round(o.variants || 1)), mode: o.variantMode || 'separate' };
  const B = borders.length;
  const hitPooled = clamp01(workload.cacheHitPooled);
  const hitSplit = Math.min(hitPooled, clamp01(workload.cacheHitSplit));
  const tp = (cacheHit) => throughputPerCopy({ model, gpu, precision, workload, g, cacheHit, variants, data });
  const pooled = tp(hitPooled);
  const split = B > 1 ? tp(hitSplit) : pooled;
  return {
    model, gpu, workload, precision, g, tpSizes, variants, borders,
    groups: scenario.borders.map((b, i) => b.group || b.name || `#${i}`),
    pooledCurve,
    pooledPeak: Math.max(...pooledCurve),
    pooledAvg: sum(pooledCurve) / 24,
    veff: variants.mode === 'separate' ? variants.count : 1,
    redundancy: Math.max(0, Math.round(o.redundancy ?? 1)),
    headroom: Math.max(0, o.headroom ?? 0.25),
    unit: purchaseUnitGpus(scenario, gpu),
    throughput: { pooled, split },
    hit: { pooled: hitPooled, split: hitSplit },
  };
}

/** One context per fitting tensor-parallel size, or { error }. */
export function tpContexts(scenario, data) {
  const first = buildContext(scenario, data);
  if (first.error) return first;
  return first.tpSizes.map((g) => (g === first.g ? first : buildContext(scenario, data, g)));
}

/**
 * The context whose GPUs (from fn) are lowest. Ties go to the smaller
 * tensor-parallel size, since contexts come in ascending order.
 */
export function cheapest(ctxs, fn) {
  let best = null;
  for (const ctx of ctxs) {
    const gpus = fn(ctx);
    if (!best || gpus < best.gpus) best = { ctx, gpus };
  }
  return best;
}

const sharedGpus = (ctx) => sizeSharedPool(ctx).gpus;
const borderGpus = (ctx) => sum(sizeBorders(ctx).map((b) => b.gpus));

function clamp01(x) {
  return Math.min(1, Math.max(0, Number(x) || 0));
}

/**
 * Copies for one deployment of each variant, per formula (4):
 *   n = max(1, ceil(peak*(1+h)/R_eff)) + r
 * With V separate variants each serves 1/V of the demand.
 */
export function copiesForPool(peakRps, ctx, rps) {
  const x = (peakRps * (1 + ctx.headroom)) / (rps * ctx.veff);
  return ctx.veff * (copiesWithFloor(x) + ctx.redundancy);
}

/** One shared pool for the total demand, sized to the peak of the summed curve. */
export function sizeSharedPool(ctx) {
  const copies = copiesForPool(ctx.pooledPeak, ctx, ctx.throughput.pooled.rps);
  const gpus = ceilTo(copies * ctx.g, ctx.unit);
  return { copies, gpus, units: gpus / ctx.unit };
}

/** Each border on its own: own peak, own floor, own redundancy, own rounding, split cache. */
export function sizeBorders(ctx) {
  const rps = ctx.throughput.split.rps;
  return ctx.borders.map((b) => {
    const copies = copiesForPool(b.peak, ctx, rps);
    const gpus = ceilTo(copies * ctx.g, ctx.unit);
    return { name: b.name, copies, gpus, units: gpus / ctx.unit };
  });
}

/**
 * Cumulative state k of the waterfall: constraints 1..k applied per border,
 * the rest applied once as in the shared pool. k=0 is the shared pool and
 * k=6 is the bordered total, so the steps telescope and always sum exactly.
 *
 *   1 peaks       border demand at its own peak instead of its share of the pooled peak
 *   2 floor       whole copies (minimum one) per border instead of once in total
 *   3 redundancy  r spare copies per border instead of once
 *   4 rounding    purchase-unit rounding per border instead of once
 *   5 models      every variant deployed in every border
 *   6 caches      split-pool cache hit rate instead of pooled
 */
export function waterfallState(ctx, k) {
  const { g, veff, unit, headroom } = ctx;
  const r = ctx.redundancy;
  const B = ctx.borders.length;
  const rps = k >= 6 ? ctx.throughput.split.rps : ctx.throughput.pooled.rps;
  const pooledAvg = ctx.pooledAvg;
  const basis = ctx.borders.map((b) => (k >= 1 ? b.peak : pooledAvg > 0 ? ctx.pooledPeak * (b.avg / pooledAvg) : ctx.pooledPeak / B));
  // x[b]: fractional copies one variant needs in border b.
  const x = basis.map((p) => (p * (1 + headroom)) / (rps * veff));
  const X = sum(x);
  const m = copiesWithFloor;

  if (k === 0) return ceilTo(g * (veff * m(X) + r * veff), unit);
  // Until rounding is switched on per border (k=4), states are unrounded.
  if (k < 2) return g * (veff * m(X) + r * veff);

  if (k < 5) {
    // Variants still counted once, as in the shared pool; the shared pool's
    // extra per-variant floors and spares ride along as an overhead O,
    // attached to the largest border so one border reproduces the shared pool.
    const red = k >= 3;
    const perBorder = x.map((xb) => g * (m(veff * xb) + (red ? r : 0)));
    const overhead = g * (veff * m(X) - m(veff * X) + (red ? r * veff - r : r * veff));
    if (k < 4) return sum(perBorder) + overhead;
    const big = x.indexOf(Math.max(...x));
    return sum(perBorder.map((gb, i) => ceilTo(gb + (i === big ? overhead : 0), unit)));
  }

  return sum(x.map((xb) => ceilTo(g * (veff * m(xb) + r * veff), unit)));
}

/**
 * The shared pool and the borders each use their own cheapest
 * tensor-parallel size, so states 0–1 (still pooled) use the shared pool's
 * context and states 2–6 the borders'. Any change in copy size lands in the
 * per-border floor step, which is what drives it: small borders favour small
 * copies because each pays its own floor and spares.
 *
 * The raw states can dip where ceilings interact (a shared pool's rounding
 * slack, variants whose fractional copies happen to align, or the switch in
 * copy size). Bordered is always >= shared, so each intermediate state is
 * clamped between the previous state and the bordered total: every step is
 * non-negative, and the steps still sum exactly to bordered minus shared.
 */
export function waterfall(sharedCtx, borderCtx = sharedCtx) {
  const raw = Array.from({ length: 7 }, (_, k) => waterfallState(k < 2 ? sharedCtx : borderCtx, k));
  const states = [raw[0]];
  for (let k = 1; k < 6; k++) states.push(Math.min(raw[6], Math.max(states[k - 1], raw[k])));
  states.push(raw[6]);
  return {
    shared: states[0],
    bordered: states[6],
    steps: CAUSES.map((c, i) => ({ ...c, gpus: states[i + 1] - states[i] })),
  };
}

// ---------------------------------------------------------------------------
// Step 8. Levers, applied in a fixed order after the tax

/** Next smaller catalog model, used as the default right-size target. */
export function defaultRightSizeTarget(scenario, data) {
  if (scenario.model === 'custom') return null;
  const cur = resolveModel(scenario, data);
  const smaller = data.models.models
    .filter((m) => m.activeParamsB < cur.activeParamsB && m.totalParamsB <= cur.totalParamsB)
    .sort((a, b) => b.activeParamsB - a.activeParamsB);
  return smaller[0]?.id ?? null;
}

/** Bordered GPUs for a scenario (no levers), at the cheapest fitting size. Null when the model doesn't fit. */
export function borderedTotal(scenario, data) {
  const ctxs = tpContexts(scenario, data);
  if (ctxs.error) return null;
  return cheapest(ctxs, borderGpus).gpus;
}

function cloneScenario(s) {
  return JSON.parse(JSON.stringify(s));
}

/** In-border GPUs at the cheapest fitting size, with same-group borders pooled when the pool lever is on. */
export function inBorderTotal(scenario, data) {
  const ctxs = tpContexts(scenario, data);
  if (ctxs.error) return null;
  return cheapest(ctxs, (ctx) => inBorderGpus(scenario, ctx)).gpus;
}

function inBorderGpus(scenario, ctx) {
  if (!scenario.poolGroups) return borderGpus(ctx);
  const keys = [...new Set(ctx.groups)];
  const rps = keys.length === 1 ? ctx.throughput.pooled.rps : ctx.throughput.split.rps;
  return sum(keys.map((key) => {
    const curves = ctx.borders.filter((_, i) => ctx.groups[i] === key).map((b) => b.curve);
    const peak = Math.max(...sumCurves(curves));
    return ceilTo(copiesForPool(peak, ctx, rps) * ctx.g, ctx.unit);
  }));
}

/**
 * Apply the levers the user switched on, in a fixed order. Each lever is
 * only kept if it doesn't add GPUs, so no lever ever increases the total.
 */
export function applyLevers(scenario, data, ctx, borderedGpus) {
  const on = scenario.levers || {};
  const steps = [];
  let current = cloneScenario(scenario);
  let total = borderedGpus;

  const tryLever = (lever, mutate, evaluate) => {
    if (!on[lever.id]) return;
    const next = cloneScenario(current);
    const note = mutate(next);
    if (note?.skip) {
      steps.push({ ...lever, gpus: 0, applied: false, note: note.skip });
      return;
    }
    const t = evaluate(next);
    if (t == null) {
      steps.push({ ...lever, gpus: 0, applied: false, note: 'Model doesn’t fit with this optimization' });
    } else if (t > total) {
      steps.push({ ...lever, gpus: 0, applied: false, note: `Would add ${t - total} GPUs here, so it isn’t applied` });
    } else {
      steps.push({ ...lever, gpus: t - total, applied: true, note: note?.ok });
      current = next;
      total = t;
    }
  };

  const evaluate = (s) => {
    const inBorder = inBorderTotal(s, data);
    if (inBorder == null) return null;
    return inBorder + burstPoolGpus(s, data);
  };

  tryLever(LEVERS[0], (s) => {
    const share = clamp01(s.advanced?.leaveShare);
    if (share <= 0) return { skip: 'No data is allowed to leave (set the share in Advanced)' };
    s.burstShare = share;
    return { ok: `${Math.round(share * 100)}% of demand served by one shared pool` };
  }, evaluate);

  tryLever(LEVERS[1], (s) => {
    const groups = new Set(s.borders.map((b, i) => b.group || b.name || `#${i}`));
    if (groups.size === s.borders.length) return { skip: 'Every region is its own jurisdiction; give regions the same group to pool them' };
    s.poolGroups = true;
    return { ok: `${s.borders.length} regions pooled into ${groups.size}` };
  }, evaluate);

  tryLever(LEVERS[2], (s) => {
    if ((s.advanced?.purchaseUnit || 'unit') === 'gpu') return { skip: 'Already buying single GPUs' };
    s.advanced = { ...s.advanced, purchaseUnit: 'gpu' };
    return { ok: 'Single GPUs instead of whole units' };
  }, evaluate);

  tryLever(LEVERS[3], (s) => {
    const target = s.advanced?.rightSizeModel || defaultRightSizeTarget(scenario, data);
    if (!target || target === s.model) return { skip: 'No smaller model selected' };
    s.model = target;
    return { ok: `Serve ${findById(data.models.models, target, 'model').name}` };
  }, evaluate);

  tryLever(LEVERS[4], (s) => {
    const v = Math.round(s.advanced?.variants || 1);
    if (v <= 1) return { skip: 'Only one model variant' };
    if (s.advanced?.variantMode === 'adapters') return { skip: 'Variants are already adapters' };
    s.advanced = { ...s.advanced, variantMode: 'adapters' };
    return { ok: `${v} variants as adapters on one base model` };
  }, evaluate);

  return { steps, total, scenario: current, burstGpus: burstPoolGpus(current, data) };
}

/** The burst pool for the share whose data may leave: one shared pool, own floor and redundancy. */
export function burstPoolGpus(s, data) {
  const share = s.burstShare || 0;
  if (share <= 0) return 0;
  const ctxs = tpContexts({ ...s, burstShare: 0 }, data);
  if (ctxs.error) return 0;
  const at = (ctx) => ceilTo(copiesForPool(ctx.pooledPeak * Math.min(1, share), ctx, ctx.throughput.pooled.rps) * ctx.g, ctx.unit);
  return cheapest(ctxs, at).gpus;
}

// ---------------------------------------------------------------------------
// Step 9. Utilization, power and cost

export function borderDetails(ctx) {
  const sized = sizeBorders(ctx);
  const rps = ctx.throughput.split.rps;
  return ctx.borders.map((b, i) => {
    const gpuEqAvg = (b.avg / rps) * ctx.g;
    const gpuEqPeak = (b.peak / rps) * ctx.g;
    const s = sized[i];
    return {
      ...s,
      share: b.share,
      avgRps: b.avg,
      peakRps: b.peak,
      demandGpusAvg: gpuEqAvg,
      demandGpusPeak: gpuEqPeak,
      utilAvg: s.gpus ? gpuEqAvg / s.gpus : 0,
      utilPeak: s.gpus ? gpuEqPeak / s.gpus : 0,
    };
  });
}

export function powerKW(gpus, ctx, scenario) {
  const perUnit = scenario.advanced?.kWPerUnit > 0 ? scenario.advanced.kWPerUnit : ctx.gpu.unitPowerKW;
  const it = gpus * (perUnit / ctx.gpu.gpusPerUnit);
  const pue = scenario.advanced?.pue > 0 ? scenario.advanced.pue : null;
  return { it, facility: pue ? it * pue : null, pue };
}

export function privateMonthlyCost(gpus, pricePerGpuHour) {
  return gpus * pricePerGpuHour * HOURS_PER_MONTH;
}

export function apiMonthlyCost(tokensPerDay, workload, prices) {
  const inShare = workload.promptTokens / (workload.promptTokens + workload.answerTokens);
  const monthly = tokensPerDay * DAYS_PER_MONTH;
  return ((monthly * inShare) / 1e6) * prices.apiInPerM + ((monthly * (1 - inShare)) / 1e6) * prices.apiOutPerM;
}

export function tokensPerDay(scenario, workload) {
  return requestsPerDay(scenario, workload) * (workload.promptTokens + workload.answerTokens);
}

/**
 * Smallest monthly token volume at which the bordered private deployment
 * costs no more than the API. Scans demand from 1/1000x to 1000x of the
 * current scenario, then bisects. Null if private never wins in that range.
 */
export function crossover(scenario, data, prices) {
  const ctx = buildContext(scenario, data);
  if (ctx.error) return null;
  const base = tokensPerDay(scenario, ctx.workload) || 1e6;
  const at = (tpd) => {
    const s = cloneScenario(scenario);
    s.demand = { mode: 'tokens', tokensPerDay: tpd };
    const gpus = borderedTotal(s, data);
    return privateMonthlyCost(gpus, prices.gpuHour) - apiMonthlyCost(tpd, ctx.workload, prices);
  };
  let prev = base / 1000;
  if (at(prev) <= 0) return { tokensPerMonth: prev * DAYS_PER_MONTH, belowRange: true };
  for (let i = 1; i <= 120; i++) {
    const t = (base / 1000) * Math.pow(10, (6 * i) / 120);
    if (at(t) <= 0) {
      let lo = prev;
      let hi = t;
      for (let j = 0; j < 40; j++) {
        const mid = Math.sqrt(lo * hi);
        if (at(mid) <= 0) hi = mid;
        else lo = mid;
      }
      return { tokensPerMonth: hi * DAYS_PER_MONTH };
    }
    prev = t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Everything together

/** Full calculation for the page. */
export function calculate(scenario, data) {
  const ctxs = tpContexts(scenario, data);
  if (ctxs.error) return { error: ctxs.error };
  // The shared pool and the borders each keep their cheapest fitting size.
  const sharedCtx = cheapest(ctxs, sharedGpus).ctx;
  const ctx = cheapest(ctxs, borderGpus).ctx;
  const wf = waterfall(sharedCtx, ctx);
  const borders = borderDetails(ctx);
  const shared = sizeSharedPool(sharedCtx);
  const levers = applyLevers(scenario, data, ctx, wf.bordered);
  const tpOptions = ctxs.map((c) => ({ g: c.g, shared: sharedGpus(c), bordered: borderGpus(c) }));

  const throughputLabel = weakestLabel(sharedCtx.throughput.pooled.label, ctx.throughput.split.label);
  const label = weakestLabel(
    throughputLabel,
    ctx.gpu.label,
    Object.values(ctx.gpu.labels || {}),
    ctx.model.label,
    ctx.workload.label,
    'modeled', // GPUs per copy comes from the memory formula until the footprint test lands
  );
  const powerLabel = weakestLabel(label, ctx.gpu.labels?.unitPowerKW || ctx.gpu.label);

  const totalAvgGpuEq = sum(borders.map((b) => b.demandGpusAvg));
  const totalPeakGpuEq = sum(borders.map((b) => b.demandGpusPeak));
  const sharedRps = sharedCtx.throughput.pooled.rps;

  const prices = scenario.advanced?.prices;
  let cost = null;
  if (prices && prices.gpuHour > 0 && (prices.apiInPerM > 0 || prices.apiOutPerM > 0)) {
    const tpd = tokensPerDay(scenario, ctx.workload);
    cost = {
      currency: prices.currency || 'USD',
      examplePrices: !!prices.example,
      privateBordered: privateMonthlyCost(wf.bordered, prices.gpuHour),
      privateShared: privateMonthlyCost(wf.shared, prices.gpuHour),
      privateAfterLevers: privateMonthlyCost(levers.total, prices.gpuHour),
      api: apiMonthlyCost(tpd, ctx.workload, prices),
      tokensPerMonth: tpd * DAYS_PER_MONTH,
      crossover: crossover(scenario, data, prices),
      label: 'modeled',
    };
  }

  const warnings = [];
  const t = ctx.throughput.split;
  if (!t.meetsSpeed) warnings.push(`Even one request at a time runs at about ${Math.round(t.perUserTokPerSec)} tokens/s per user, below the ${ctx.workload.outputTokensPerSecPerUser} tokens/s target.`);
  if (!t.meetsTtft) warnings.push(`Unloaded time to first token is about ${Math.round(t.ttftMs)} ms, above the ${ctx.workload.ttftMsP95} ms p95 target.`);
  const ts = sharedCtx.throughput.pooled;
  if (sharedCtx.g !== ctx.g && !ts.meetsSpeed) warnings.push(`In the shared pool (${sharedCtx.g} GPUs per copy), even one request at a time runs at about ${Math.round(ts.perUserTokPerSec)} tokens/s per user, below the target.`);

  return {
    label,
    g: ctx.g,
    gShared: sharedCtx.g,
    tpOptions,
    unit: ctx.unit,
    model: ctx.model,
    gpu: ctx.gpu,
    workload: ctx.workload,
    throughput: { pooled: sharedCtx.throughput.pooled, split: ctx.throughput.split },
    hit: ctx.hit,
    shared: { ...shared, gpus: wf.shared, power: powerKW(wf.shared, ctx, scenario), utilAvg: wf.shared ? ((sharedCtx.pooledAvg / sharedRps) * sharedCtx.g) / wf.shared : 0, utilPeak: wf.shared ? ((sharedCtx.pooledPeak / sharedRps) * sharedCtx.g) / wf.shared : 0 },
    bordered: {
      gpus: wf.bordered,
      units: sum(borders.map((b) => b.units)),
      power: powerKW(wf.bordered, ctx, scenario),
      utilAvg: wf.bordered ? totalAvgGpuEq / wf.bordered : 0,
      utilPeak: wf.bordered ? totalPeakGpuEq / wf.bordered : 0,
    },
    tax: { gpus: wf.bordered - wf.shared, pct: wf.shared ? (wf.bordered - wf.shared) / wf.shared : 0 },
    causes: wf.steps,
    levers: levers.steps,
    afterLevers: {
      gpus: levers.total,
      taxGpus: levers.total - wf.shared,
      taxPct: wf.shared ? (levers.total - wf.shared) / wf.shared : 0,
      power: powerKW(levers.total, ctx, scenario),
    },
    borders: borders.map((b) => ({ ...b, power: powerKW(b.gpus, ctx, scenario) })),
    cost,
    labels: { gpus: label, power: powerLabel, throughput: throughputLabel, cost: 'modeled' },
    warnings,
  };
}
