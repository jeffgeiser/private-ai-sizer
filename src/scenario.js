// Scenario defaults, presets and URL-fragment encoding.
// The scenario lives in the fragment (after #), which browsers never send to
// the server, so a shared link reopens the same scenario without logging it.

export const EXAMPLE_PRICES = {
  example: true,
  currency: 'USD',
  gpuHour: 3.0,
  apiInPerM: 0.6,
  apiOutPerM: 2.4,
};

export const DEFAULT_ADVANCED = {
  leaveShare: 0,
  redundancy: 1,
  ttftMsP95: null,
  outputTokensPerSecPerUser: null,
  targetConcurrency: null,
  headroom: 0.25,
  shape: 'business',
  customShape: null,
  purchaseUnit: 'unit',
  customUnitGpus: 8,
  variants: 1,
  variantMode: 'separate',
  cacheHitPooled: null,
  cacheHitSplit: null,
  kWPerUnit: null,
  pue: null,
  gpusPerCopy: 'auto',
  rightSizeModel: null,
  // No cost view in this release; pass prices (e.g. EXAMPLE_PRICES) to get one.
  prices: null,
};

export const DEFAULT_LEVERS = { burst: true, pool: true, units: true, rightsize: false, adapters: true };

const equal = (names, tzs) => names.map((name, i) => ({ name, tz: tzs[i], share: 1 }));

export const BORDER_PRESETS = [
  {
    id: 'default',
    name: 'Six regions, equal split',
    borders: equal(['Region 1', 'Region 2', 'Region 3', 'Region 4', 'Region 5', 'Region 6'], [0, 1, 1, 1, 2, 3]),
  },
  { id: 'single', name: 'Single region (baseline)', borders: [{ name: 'Single region', tz: 1, share: 1 }] },
  {
    id: 'europe5',
    name: 'Five European countries',
    borders: [
      { name: 'Germany', tz: 1, share: 30 },
      { name: 'France', tz: 1, share: 25 },
      { name: 'Italy', tz: 1, share: 18 },
      { name: 'Spain', tz: 1, share: 15 },
      { name: 'Netherlands', tz: 1, share: 12 },
    ],
  },
  {
    id: 'newmarket',
    name: 'Entering a new market at 1% of demand',
    borders: [
      { name: 'Home market', tz: -5, share: 99 },
      { name: 'New market', tz: 8, share: 1 },
    ],
  },
  {
    id: 'global3',
    name: 'Global, three time zones',
    borders: [
      { name: 'Americas', tz: -5, share: 40 },
      { name: 'EMEA', tz: 1, share: 35 },
      { name: 'APAC', tz: 8, share: 25 },
    ],
  },
  {
    id: 'units',
    name: 'Separate business units, one region each',
    borders: [
      { name: 'Retail banking', tz: 1, share: 40, group: 'Same country' },
      { name: 'Wealth', tz: 1, share: 25, group: 'Same country' },
      { name: 'Insurance', tz: 1, share: 20, group: 'Same country' },
      { name: 'Corporate', tz: 1, share: 15, group: 'Same country' },
    ],
  },
];

export function defaultScenario() {
  return {
    v: 1,
    workload: 'agent',
    model: 'llama-3.3-70b',
    customModel: null,
    gpu: 'b300',
    precision: 'FP8',
    demand: { mode: 'tokens', tokensPerDay: 2e9, requestsPerDay: 300000 },
    borders: clone(BORDER_PRESETS[0].borders),
    advanced: clone(DEFAULT_ADVANCED),
    levers: { ...DEFAULT_LEVERS },
    // Page state that travels with a shared link; the engine ignores it.
    ui: { view: 'overview', breakdown: false },
  };
}

export function applyBorderPreset(scenario, presetId) {
  const p = BORDER_PRESETS.find((x) => x.id === presetId);
  if (!p) throw new Error(`Unknown preset: ${presetId}`);
  return { ...scenario, borders: clone(p.borders) };
}

function clone(x) {
  return JSON.parse(JSON.stringify(x));
}

// ---------------------------------------------------------------------------
// Validation. A scenario can arrive from a shared link, so treat it as
// untrusted input: every field is type-checked and range-clamped, unknown keys
// are dropped, and anything invalid falls back to the default.

const MAX_BORDERS = 20;
const MAX_TEXT = 64;
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function num(x, fallback, { min = -Infinity, max = Infinity, int = false } = {}) {
  if (!isNum(x)) return fallback;
  const v = int ? Math.round(x) : x;
  return Math.min(max, Math.max(min, v));
}

/** null stays null (meaning "use the preset"); a number is clamped; anything else is null. */
function optNum(x, opts) {
  if (x === null || x === undefined) return null;
  const v = num(x, null, opts);
  return v;
}

function optPositive(x, opts = {}) {
  const v = optNum(x, opts);
  return v != null && v > 0 ? v : null;
}

function text(x, fallback) {
  if (typeof x !== 'string') return fallback;
  // Strip control characters; length-limit. HTML escaping happens at render time.
  return x.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, MAX_TEXT);
}

function oneOf(x, allowed, fallback) {
  return allowed.includes(x) ? x : fallback;
}

function id(x, fallback, known) {
  if (typeof x !== 'string' || !ID_RE.test(x)) return fallback;
  if (known && !known.includes(x)) return fallback;
  return x;
}

const bool = (x, fallback) => (typeof x === 'boolean' ? x : fallback);

function sanitizeBorder(b, i) {
  if (!isObj(b)) return null;
  const out = {
    name: text(b.name, `Region ${i + 1}`) || `Region ${i + 1}`,
    tz: Math.round(num(b.tz, 0, { min: -12, max: 14 }) * 2) / 2,
    share: num(b.share, 1, { min: 0, max: 1e9 }),
  };
  const group = text(b.group, '');
  if (group) out.group = group;
  return out;
}

function sanitizeCustomModel(c) {
  if (!isObj(c)) return null;
  const out = {};
  const name = text(c.name, '');
  if (name) out.name = name;
  const limits = { totalParamsB: 1e5, activeParamsB: 1e5, layers: 1e4, kvHeads: 1e4, headDim: 1e5 };
  for (const [k, max] of Object.entries(limits)) {
    const v = optPositive(c[k], { max, int: k !== 'totalParamsB' && k !== 'activeParamsB' });
    if (v != null) out[k] = v;
  }
  return out;
}

function sanitizePrices(p) {
  if (!isObj(p)) return null;
  return {
    example: bool(p.example, false),
    currency: typeof p.currency === 'string' && /^[A-Z]{3}$/.test(p.currency) ? p.currency : 'USD',
    gpuHour: num(p.gpuHour, 0, { min: 0, max: 1e6 }),
    apiInPerM: num(p.apiInPerM, 0, { min: 0, max: 1e6 }),
    apiOutPerM: num(p.apiOutPerM, 0, { min: 0, max: 1e6 }),
  };
}

function sanitizeAdvanced(a, d, known) {
  a = isObj(a) ? a : {};
  const shape = Array.isArray(a.customShape) && a.customShape.length === 24 && a.customShape.every((x) => isNum(x) && x >= 0)
    ? a.customShape.slice()
    : null;
  const out = {
    leaveShare: num(a.leaveShare, d.leaveShare, { min: 0, max: 1 }),
    redundancy: num(a.redundancy, d.redundancy, { min: 0, max: 10, int: true }),
    ttftMsP95: optPositive(a.ttftMsP95, { max: 1e7 }),
    outputTokensPerSecPerUser: optPositive(a.outputTokensPerSecPerUser, { max: 1e6 }),
    targetConcurrency: optPositive(a.targetConcurrency, { max: 1e5, int: true }),
    headroom: num(a.headroom, d.headroom, { min: 0, max: 10 }),
    shape: oneOf(a.shape, ['business', 'flat', 'custom'], d.shape),
    customShape: shape,
    purchaseUnit: oneOf(a.purchaseUnit, ['unit', 'gpu', 'custom'], d.purchaseUnit),
    customUnitGpus: num(a.customUnitGpus, d.customUnitGpus, { min: 1, max: 4096, int: true }),
    variants: num(a.variants, d.variants, { min: 1, max: 100, int: true }),
    variantMode: oneOf(a.variantMode, ['separate', 'adapters'], d.variantMode),
    cacheHitPooled: optNum(a.cacheHitPooled, { min: 0, max: 1 }),
    cacheHitSplit: optNum(a.cacheHitSplit, { min: 0, max: 1 }),
    kWPerUnit: optPositive(a.kWPerUnit, { max: 1e4 }),
    pue: optNum(a.pue, { min: 1, max: 5 }),
    gpusPerCopy: [1, 2, 4, 8].includes(Number(a.gpusPerCopy)) ? Number(a.gpusPerCopy) : 'auto',
    rightSizeModel: a.rightSizeModel == null ? null : id(a.rightSizeModel, null, known?.models),
    prices: sanitizePrices(a.prices),
  };
  // Optional overrides the engine reads when present.
  const prompt = optPositive(a.promptTokens, { max: 1e8, int: true });
  const answer = optPositive(a.answerTokens, { max: 1e8, int: true });
  if (prompt != null) out.promptTokens = prompt;
  if (answer != null) out.answerTokens = answer;
  return out;
}

/** Ids that exist in the loaded data files, used to reject unknown ids. */
function knownIds(data) {
  if (!data) return null;
  return {
    workloads: data.throughput?.workloads?.map((w) => w.id),
    models: data.models?.models?.map((m) => m.id),
    gpus: data.gpus?.gpus?.map((g) => g.id),
  };
}

/**
 * Fill anything missing from an older or hand-edited scenario, and validate
 * every field (types, ranges, allowed values). Pass the loaded `data` to also
 * reject workload, model and GPU ids that aren't in the catalog.
 */
export function normalizeScenario(s, data) {
  const d = defaultScenario();
  s = isObj(s) ? s : {};
  const known = knownIds(data);
  const model = s.model === 'custom' ? 'custom' : id(s.model, d.model, known?.models);
  const gpuId = id(s.gpu, d.gpu, known?.gpus);
  let precision = typeof s.precision === 'string' && /^[A-Za-z0-9]{2,8}$/.test(s.precision) ? s.precision : d.precision;
  const gpu = data?.gpus?.gpus?.find((g) => g.id === gpuId);
  if (gpu && Array.isArray(gpu.precisions) && !gpu.precisions.includes(precision)) {
    precision = gpu.precisions.includes('FP8') ? 'FP8' : gpu.precisions[0];
  }
  const demand = isObj(s.demand) ? s.demand : {};
  const borders = Array.isArray(s.borders)
    ? s.borders.slice(0, MAX_BORDERS).map(sanitizeBorder).filter(Boolean)
    : [];
  const levers = isObj(s.levers) ? s.levers : {};
  const ui = isObj(s.ui) ? s.ui : {};
  return {
    v: 1,
    workload: id(s.workload, d.workload, known?.workloads),
    model,
    customModel: sanitizeCustomModel(s.customModel),
    gpu: gpuId,
    precision,
    demand: {
      mode: oneOf(demand.mode, ['tokens', 'requests'], d.demand.mode),
      tokensPerDay: num(demand.tokensPerDay, d.demand.tokensPerDay, { min: 0, max: 1e18 }),
      requestsPerDay: num(demand.requestsPerDay, d.demand.requestsPerDay, { min: 0, max: 1e15 }),
    },
    borders: borders.length ? borders : d.borders,
    advanced: sanitizeAdvanced(s.advanced, d.advanced, known),
    levers: Object.fromEntries(Object.entries(d.levers).map(([k, v]) => [k, bool(levers[k], v)])),
    ui: { view: oneOf(ui.view, ['overview', 'detail'], d.ui.view), breakdown: bool(ui.breakdown, d.ui.breakdown) },
  };
}

function toBase64Url(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

export function encodeScenario(s) {
  return 's=' + toBase64Url(JSON.stringify(s));
}

/**
 * Decode a fragment like "#s=..." (leading # optional). Returns null if absent
 * or invalid. The result is always validated (see normalizeScenario); pass the
 * loaded `data` to also reject unknown catalog ids.
 */
export function decodeScenario(fragment, data) {
  const m = /(?:^#?|&)s=([A-Za-z0-9_-]{1,100000})/.exec(typeof fragment === 'string' ? fragment : '');
  if (!m) return null;
  try {
    const raw = JSON.parse(fromBase64Url(m[1]));
    if (!isObj(raw)) return null;
    return normalizeScenario(raw, data);
  } catch {
    return null;
  }
}
