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
  prices: { ...EXAMPLE_PRICES },
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

/** Fill anything missing from an older or hand-edited scenario. */
export function normalizeScenario(s) {
  const d = defaultScenario();
  return {
    ...d,
    ...s,
    demand: { ...d.demand, ...(s?.demand || {}) },
    borders: Array.isArray(s?.borders) && s.borders.length ? s.borders : d.borders,
    advanced: { ...d.advanced, ...(s?.advanced || {}), prices: { ...d.advanced.prices, ...(s?.advanced?.prices || {}) } },
    levers: { ...d.levers, ...(s?.levers || {}) },
    ui: { ...d.ui, ...(s?.ui || {}) },
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

/** Decode a fragment like "#s=..." (leading # optional). Returns null if absent or invalid. */
export function decodeScenario(fragment) {
  const m = /(?:^#?|&)s=([A-Za-z0-9_-]+)/.exec(fragment || '');
  if (!m) return null;
  try {
    return normalizeScenario(JSON.parse(fromBase64Url(m[1])));
  } catch {
    return null;
  }
}
