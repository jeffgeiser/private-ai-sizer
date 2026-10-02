// Reference page for the sizing engine. Everything is computed in the browser.
// The only network requests are for the static data files on page load; no
// input value is ever sent anywhere. The scenario is kept in the URL fragment.
import * as E from '../src/engine.js';
import { defaultScenario, normalizeScenario, encodeScenario, decodeScenario, applyBorderPreset, BORDER_PRESETS } from '../src/scenario.js';

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 0) => (n == null || !isFinite(n) ? '–' : n.toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (x, d = 0) => fmt(x * 100, d) + '%';
const signed = (n, f = fmt) => (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const compact = (n) => {
  if (!isFinite(n)) return '–';
  const units = [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'k']];
  for (const [v, u] of units) if (Math.abs(n) >= v) return fmt(n / v, n / v < 10 ? 1 : 0) + ' ' + u;
  return fmt(n);
};

let data;
let state;
let last;

async function loadData() {
  const get = (f) => fetch(`../data/${f}`).then((r) => {
    if (!r.ok) throw new Error(`Couldn't load ${f}`);
    return r.json();
  });
  const [gpus, models, throughput] = await Promise.all([get('gpus.json'), get('models.json'), get('throughput.json')]);
  return { gpus, models, throughput };
}

const LABEL_TEXT = {
  measured: 'Measured in our benchmark',
  published: 'Based on published vendor figures',
  modeled: 'Modeled estimate',
};

const CAUSE_WHY = {
  peaks: 'each region sizes for its own busiest hour',
  floor: 'each region needs at least one full model copy',
  redundancy: 'each region keeps its own spare',
  rounding: 'each region buys whole servers',
  models: 'each region hosts every fine-tuned variant',
  caches: 'smaller pools reuse fewer cached prompts',
};

function options(select, items, value) {
  select.innerHTML = items.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(t)}</option>`).join('');
}

// ---------------------------------------------------------------------------
// Scenario <-> form

function writeForm() {
  const s = state;
  const a = s.advanced;
  options($('workload'), data.throughput.workloads.map((w) => [w.id, w.name]), s.workload);
  options($('model'), [...data.models.models.map((m) => [m.id, m.name]), ['custom', 'Custom…']], s.model);
  $('customModel').hidden = s.model !== 'custom';
  const cm = s.customModel || {};
  $('cmTotal').value = cm.totalParamsB ?? 70;
  $('cmActive').value = cm.activeParamsB ?? 70;
  $('cmLayers').value = cm.layers ?? 80;
  $('cmKv').value = cm.kvHeads ?? 8;
  $('cmHead').value = cm.headDim ?? 128;
  options($('gpu'), data.gpus.gpus.map((g) => [g.id, `${g.name.replace(/\s*\(.*\)\s*/g, '')} · ${g.gpusPerUnit}-GPU ${g.purchaseUnit === 'rack' ? 'rack' : 'server'}`]), s.gpu);
  const gpu = data.gpus.gpus.find((g) => g.id === s.gpu);
  if (!gpu.precisions.includes(s.precision)) s.precision = gpu.precisions.includes('FP8') ? 'FP8' : gpu.precisions[0];
  options($('precision'), gpu.precisions.map((p) => [p, p]), s.precision);

  $('demandMode').value = s.demand.mode;
  $('demandLabel').textContent = s.demand.mode === 'tokens' ? 'Demand (B tokens per day)' : 'Demand (requests per day)';
  $('demandValue').value = s.demand.mode === 'tokens' ? +(s.demand.tokensPerDay / 1e9).toPrecision(6) : s.demand.requestsPerDay;
  writeBorders();

  const w = data.throughput.workloads.find((x) => x.id === s.workload);
  $('leaveShare').value = Math.round((a.leaveShare || 0) * 100);
  $('redundancy').value = a.redundancy;
  setOptional('ttft', a.ttftMsP95, w.ttftMsP95);
  setOptional('speed', a.outputTokensPerSecPerUser, w.outputTokensPerSecPerUser);
  setOptional('concurrency', a.targetConcurrency, w.targetConcurrency);
  $('headroom').value = Math.round(a.headroom * 100);
  $('shape').value = a.shape;
  $('customShapeBox').hidden = a.shape !== 'custom';
  $('customShape').value = (a.customShape || []).join(', ');
  $('purchaseUnit').value = a.purchaseUnit;
  $('customUnitBox').hidden = a.purchaseUnit !== 'custom';
  $('customUnit').value = a.customUnitGpus || gpu.gpusPerUnit;
  $('gpusPerCopy').value = String(a.gpusPerCopy || 'auto');
  $('variants').value = a.variants;
  $('variantMode').value = a.variantMode;
  setOptional('hitPooled', a.cacheHitPooled == null ? null : Math.round(a.cacheHitPooled * 100), Math.round(w.cacheHitPooled * 100));
  setOptional('hitSplit', a.cacheHitSplit == null ? null : Math.round(a.cacheHitSplit * 100), Math.round(w.cacheHitSplit * 100));
  options($('rightSize'), [['', `Default (${nameOf(E.defaultRightSizeTarget(s, data)) || 'none smaller'})`], ...data.models.models.filter((m) => m.id !== s.model).map((m) => [m.id, m.name])], a.rightSizeModel || '');
  setOptional('kw', a.kWPerUnit, gpu.unitPowerKW);
  $('pue').value = a.pue ?? '';
  writeLevers();
}

function nameOf(modelId) {
  return data.models.models.find((m) => m.id === modelId)?.name;
}

function setOptional(id, value, presetValue) {
  $(id).value = value ?? '';
  $(id).placeholder = `${presetValue} (preset)`;
}

const bordersKey = (bs) => JSON.stringify(bs.map((b) => [b.name, b.tz ?? 0, b.share ?? 1, b.group || '']));

function writeBorderSummary() {
  const match = BORDER_PRESETS.find((p) => bordersKey(p.borders) === bordersKey(state.borders));
  options($('borderPreset'), [...BORDER_PRESETS.map((p) => [p.id, p.name]), ...(match ? [] : [['custom', 'Custom']])], match ? match.id : 'custom');
  const bs = state.borders;
  const shares = E.normalizedShares(bs);
  const equal = shares.every((x) => Math.abs(x - shares[0]) < 1e-9);
  const big = shares.indexOf(Math.max(...shares));
  const small = shares.indexOf(Math.min(...shares));
  const tzs = bs.map((b) => b.tz || 0);
  const lo = Math.min(...tzs);
  const hi = Math.max(...tzs);
  const utc = (h) => `UTC${h < 0 ? '−' : '+'}${Math.abs(h)}`;
  const split = bs.length === 1 ? 'all demand' : equal ? 'equal split' : `${esc(bs[big].name)} ${pct(shares[big])} … ${esc(bs[small].name)} ${pct(shares[small])}`;
  const zones = lo === hi ? utc(lo) : `${utc(lo)} to ${utc(hi).slice(3)}`;
  $('borderSummary').innerHTML = `<strong>${bs.length} region${bs.length === 1 ? '' : 's'}</strong> · ${split} · ${zones}`;
}

function writeBorders() {
  writeBorderSummary();
  const box = $('borders');
  box.innerHTML = state.borders.map((b, i) => `
    <div class="border" data-i="${i}">
      <label>Name <input data-f="name" value="${esc(b.name)}" aria-label="Region ${i + 1} name"></label>
      <label>UTC± <input data-f="tz" type="number" step="0.5" min="-12" max="14" value="${b.tz ?? 0}" aria-label="Region ${i + 1} time zone offset"></label>
      <label>Share <input data-f="share" type="number" min="0" step="any" value="${b.share ?? 1}" aria-label="Region ${i + 1} share of demand"></label>
      <button type="button" class="secondary" data-remove="${i}" aria-label="Remove border ${i + 1}"${state.borders.length <= 1 ? ' disabled' : ''}>×</button>
      <label class="group">Jurisdiction group (regions in the same group can pool) <input data-f="group" value="${esc(b.group || '')}" placeholder="own" aria-label="Region ${i + 1} group"></label>
    </div>`).join('');
  $('addBorder').disabled = state.borders.length >= 20;
}

function writeLevers() {
  const notes = Object.fromEntries((last?.levers || []).map((l) => [l.id, l]));
  $('levers').innerHTML = E.LEVERS.map((l) => {
    const n = notes[l.id];
    const save = n?.applied && n.gpus < 0 ? `<span class="save">−${fmt(-n.gpus)}</span>` : '';
    const note = n ? (n.applied ? n.note || '' : n.note) : '';
    return `<div class="lever"><label><input type="checkbox" data-lever="${l.id}"${state.levers[l.id] ? ' checked' : ''}>${esc(l.name)}${save}</label>${note ? `<span class="note eng">${esc(note)}</span>` : ''}</div>`;
  }).join('');
}

const num = (id) => {
  const v = $(id).value.trim();
  return v === '' ? null : Number(v);
};

function readForm() {
  const s = state;
  s.workload = $('workload').value;
  s.model = $('model').value;
  s.customModel = s.model === 'custom'
    ? { totalParamsB: num('cmTotal'), activeParamsB: num('cmActive'), layers: num('cmLayers'), kvHeads: num('cmKv'), headDim: num('cmHead') }
    : null;
  s.gpu = $('gpu').value;
  s.precision = $('precision').value;
  s.demand.mode = $('demandMode').value;
  const dv = Math.max(0, num('demandValue') || 0);
  if (s.demand.mode === 'tokens') s.demand.tokensPerDay = dv * 1e9;
  else s.demand.requestsPerDay = dv;

  document.querySelectorAll('#borders .border').forEach((row) => {
    const b = s.borders[Number(row.dataset.i)];
    const f = (k) => row.querySelector(`[data-f="${k}"]`).value;
    b.name = f('name') || `Region ${Number(row.dataset.i) + 1}`;
    b.tz = Number(f('tz')) || 0;
    b.share = Math.max(0, Number(f('share')) || 0);
    const g = f('group').trim();
    if (g) b.group = g;
    else delete b.group;
  });

  const a = s.advanced;
  a.leaveShare = Math.min(100, Math.max(0, num('leaveShare') || 0)) / 100;
  a.redundancy = Number($('redundancy').value);
  a.ttftMsP95 = num('ttft');
  a.outputTokensPerSecPerUser = num('speed');
  a.targetConcurrency = num('concurrency');
  a.headroom = Math.max(0, num('headroom') ?? 25) / 100;
  a.shape = $('shape').value;
  if (a.shape === 'custom') {
    const vals = $('customShape').value.split(/[\s,;]+/).filter(Boolean).map(Number);
    a.customShape = vals;
  }
  a.purchaseUnit = $('purchaseUnit').value;
  a.customUnitGpus = num('customUnit');
  a.gpusPerCopy = $('gpusPerCopy').value;
  a.variants = Math.min(100, Math.max(1, Math.round(num('variants') || 1)));
  a.variantMode = $('variantMode').value;
  a.cacheHitPooled = num('hitPooled') == null ? null : num('hitPooled') / 100;
  a.cacheHitSplit = num('hitSplit') == null ? null : num('hitSplit') / 100;
  a.rightSizeModel = $('rightSize').value || null;
  a.kWPerUnit = num('kw');
  a.pue = num('pue');

  document.querySelectorAll('[data-lever]').forEach((c) => (s.levers[c.dataset.lever] = c.checked));
}

// ---------------------------------------------------------------------------
// Results

function render() {
  let r;
  try {
    r = E.calculate({ ...state, advanced: { ...state.advanced, prices: null } }, data); // no cost view on this page
  } catch (e) {
    r = { error: e.message };
  }
  last = r;
  history.replaceState(null, '', '#' + encodeScenario(state));
  writeLevers();
  if (r.error) {
    $('error').hidden = false;
    $('error').textContent = r.error;
    $('out').hidden = true;
    $('sticky').textContent = 'No result: ' + r.error;
    return;
  }
  $('error').hidden = true;
  $('out').hidden = false;

  const w = r.workload;
  const rpd = E.requestsPerDay(state, w);
  $('demandHint').textContent = state.demand.mode === 'tokens'
    ? `≈ ${compact(rpd)} requests/day at ${fmt(w.promptTokens + w.answerTokens)} tokens each (≈ ${compact(rpd / w.stepsPerTask)} ${w.stepsPerTask > 1 ? `tasks of ${w.stepsPerTask} steps` : 'tasks'})`
    : `≈ ${compact(rpd * (w.promptTokens + w.answerTokens))} tokens/day at ${fmt(w.promptTokens + w.answerTokens)} tokens per request`;

  writeBorderSummary();
  renderStatus(r);
  renderHero(r);
  $('warnings').innerHTML = r.warnings.map((x) => `<div class="warn">${esc(x)}</div>`).join('');
  const after = r.levers.some((l) => l.applied);
  $('sticky').textContent = `Distribution overhead: +${fmt(r.tax.gpus)} GPUs (+${pct(r.tax.pct)})${after ? ` · optimized ${signed(r.afterLevers.taxGpus)}` : ''}`;

  renderSummaryChart(r);
  renderDrivers(r);
  renderWaterfall(r);
  renderBorders(r);
  renderExplain(r);
}

function renderStatus(r) {
  $('status').innerHTML = `<strong>${LABEL_TEXT[r.label]}</strong> · for planning, not a quote`;
}

function renderHero(r) {
  const n = state.borders.length;
  const after = r.levers.some((l) => l.applied);
  const kw = (p) => `${fmt(p.it, 1)} kW`;
  const extraKw = r.bordered.power.it - r.shared.power.it;
  const sub = r.tax.gpus
    ? `+${pct(r.tax.pct)} vs one shared pool · +${fmt(extraKw, 1)} kW`
    : `${n === 1 ? 'One region is the baseline' : 'Same as one shared pool'}`;
  const tile = (k, v, sub) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div><div class="s">${sub}</div></div>`;
  $('hero').innerHTML = `
    <div class="what">Distribution overhead</div>
    <div class="tax">+${fmt(r.tax.gpus)} GPUs<small>${sub}</small></div>
    <div class="tiles eng">
      ${tile(`With ${n} region${n === 1 ? '' : 's'}`, `${fmt(r.bordered.gpus)} GPUs`, `${fmt(r.bordered.units)} ${unitWord(r)} · ${kw(r.bordered.power)} · ${pct(r.bordered.utilAvg)} used on average`)}
      ${tile('One shared pool', `${fmt(r.shared.gpus)} GPUs`, `${kw(r.shared.power)} · ${pct(r.shared.utilAvg)} used on average`)}
      ${after
        ? tile('Optimized', `${fmt(r.afterLevers.gpus)} GPUs`, `${kw(r.afterLevers.power)} · overhead ${signed(r.afterLevers.taxGpus)} GPUs`)
        : tile('Optimized', '–', 'Turn on an optimization to reduce the overhead')}
    </div>`;
}

/** Overview chart: three bars, each split into the shared-pool need, the overhead, and what the optimizations save. */
function renderSummaryChart(r) {
  const S = r.shared.gpus;
  const B = r.bordered.gpus;
  const A = r.afterLevers.gpus;
  const after = r.levers.some((l) => l.applied);
  const rows = [
    { label: 'One shared pool', base: S, tax: 0, won: 0, total: S },
    { label: `With ${state.borders.length} region${state.borders.length === 1 ? '' : 's'}`, base: S, tax: B - S, won: 0, total: B },
  ];
  if (after) rows.push({ label: 'Optimized', base: Math.min(A, S), tax: Math.max(0, A - S), won: B - A, total: A });
  // Drawn at the container's real width so labels stay legible on a phone.
  const W = Math.max(300, Math.min(900, $('summaryChart').clientWidth || 860));
  const rowH = 46;
  const m = { l: W < 520 ? 118 : 150, r: 52, t: 8, b: 8 };
  const H = m.t + m.b + rows.length * rowH;
  const max = Math.max(1, B);
  const xx = (v) => m.l + ((W - m.l - m.r) * v) / max;
  const c = { base: cssVar('--base'), tax: cssVar('--cause'), won: cssVar('--lever'), text: cssVar('--text'), muted: cssVar('--muted'), bg: cssVar('--bg') };
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(rows.map((x) => `${x.label}: ${fmt(x.total)} GPUs`).join('; '))}" font-family="system-ui, sans-serif"><rect width="${W}" height="${H}" fill="${c.bg}"/>`;
  rows.forEach((row, i) => {
    const y = m.t + i * rowH + 8;
    const h = rowH - 16;
    svg += `<text x="${m.l - 10}" y="${y + h / 2 + 5}" text-anchor="end" font-size="${W < 520 ? 12 : 14}" fill="${c.text}">${esc(row.label)}</text>`;
    svg += `<rect x="${xx(0)}" y="${y}" width="${Math.max(1, xx(row.base) - xx(0))}" height="${h}" fill="${c.base}" rx="3"/>`;
    if (row.tax > 0) svg += `<rect x="${xx(row.base)}" y="${y}" width="${xx(row.base + row.tax) - xx(row.base)}" height="${h}" fill="${c.tax}" rx="3"/>`;
    if (row.won > 0) svg += `<rect x="${xx(row.total) + 1}" y="${y + 1}" width="${Math.max(0, xx(row.total + row.won) - xx(row.total) - 2)}" height="${h - 2}" fill="none" stroke="${c.won}" stroke-width="2" stroke-dasharray="5 4" rx="3"/>`;
    svg += `<text x="${xx(row.total + row.won) + 10}" y="${y + h / 2 + 5}" font-size="15" font-weight="700" fill="${c.text}">${fmt(row.total)}</text>`;
  });
  $('summaryChart').innerHTML = svg + '</svg>';
  const key = (color, text, outline) => `<span><i style="${outline ? `border:2px dashed ${color};width:8px;height:8px` : `background:${color}`}"></i>${text}</span>`;
  $('summaryLegend').innerHTML = key(c.base, 'What one shared pool needs') + (B > S ? key(c.tax, 'Distribution overhead') : '') + (after ? key(c.won, 'Saved by optimizations', true) : '');
}

function renderDrivers(r) {
  const causes = r.causes.filter((x) => x.gpus > 0).sort((a, b) => b.gpus - a.gpus).slice(0, 3);
  $('drivers').innerHTML = causes.length
    ? `<h3>What drives it</h3><ul>${causes.map((x) => `<li><span class="n">+${fmt(x.gpus)}</span> ${esc(x.name)} <span class="hint">— ${esc(CAUSE_WHY[x.id])}</span></li>`).join('')}</ul>`
    : '';
}

function unitWord(r) {
  if (r.unit === 1) return 'GPUs bought singly';
  return r.gpu.purchaseUnit === 'rack' && r.unit === r.gpu.gpusPerUnit ? 'racks' : r.unit === r.gpu.gpusPerUnit ? 'servers' : `units of ${r.unit}`;
}

function waterfallBars(r) {
  const bars = [{ name: 'One shared pool', kind: 'total', from: 0, to: r.shared.gpus }];
  let y = r.shared.gpus;
  for (const c of r.causes) {
    bars.push({ name: c.name, kind: 'cause', from: y, to: y + c.gpus, delta: c.gpus });
    y += c.gpus;
  }
  bars.push({ name: 'With regions', kind: 'total', from: 0, to: r.bordered.gpus });
  const on = r.levers.filter((l) => state.levers[l.id]);
  if (on.length) {
    for (const l of on) {
      bars.push({ name: l.name, kind: 'lever', from: y, to: y + l.gpus, delta: l.gpus, note: l.applied ? '' : l.note });
      y += l.gpus;
    }
    bars.push({ name: 'Optimized', kind: 'total', from: 0, to: r.afterLevers.gpus });
  }
  return bars;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function wrap(text, max) {
  const words = text.split(' ');
  const lines = [''];
  for (const w of words) {
    const cur = lines[lines.length - 1];
    if ((cur + ' ' + w).trim().length > max && cur) lines.push(w);
    else lines[lines.length - 1] = (cur + ' ' + w).trim();
  }
  return lines;
}

function renderWaterfall(r) {
  const bars = waterfallBars(r);
  const W = 860;
  const H = 380;
  const m = { l: 48, r: 12, t: 24, b: 78 };
  const max = Math.max(1, ...bars.map((b) => Math.max(b.from, b.to)));
  const nice = niceMax(max);
  const bw = (W - m.l - m.r) / bars.length;
  const yy = (v) => m.t + (H - m.t - m.b) * (1 - v / nice);
  const colors = { total: cssVar('--total'), cause: cssVar('--cause'), lever: cssVar('--lever'), text: cssVar('--text'), muted: cssVar('--muted'), line: cssVar('--line'), bg: cssVar('--bg') };
  const ticks = Array.from({ length: 5 }, (_, i) => (nice / 4) * i);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="wfTitle wfDesc" font-family="system-ui, sans-serif">
    <title id="wfTitle">Distribution overhead waterfall</title>
    <desc id="wfDesc">${esc(bars.map((b) => `${b.name}: ${b.kind === 'total' ? fmt(b.to) + ' GPUs' : (b.delta >= 0 ? '+' : '') + fmt(b.delta)}`).join('; '))}</desc>
    <rect width="${W}" height="${H}" fill="${colors.bg}"/>`;
  for (const t of ticks) {
    svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${yy(t)}" y2="${yy(t)}" stroke="${colors.line}" stroke-width="1"/>`;
    svg += `<text x="${m.l - 6}" y="${yy(t) + 4}" text-anchor="end" font-size="11" fill="${colors.muted}">${fmt(t)}</text>`;
  }
  bars.forEach((b, i) => {
    const x = m.l + i * bw + bw * 0.15;
    const w = bw * 0.7;
    const top = yy(Math.max(b.from, b.to));
    const h = Math.max(b.from === b.to ? 0 : 1.5, Math.abs(yy(b.from) - yy(b.to)));
    svg += `<rect x="${x}" y="${top}" width="${w}" height="${h}" fill="${colors[b.kind]}" rx="2"/>`;
    if (b.from === b.to && b.kind !== 'total') svg += `<line x1="${x}" x2="${x + w}" y1="${yy(b.from)}" y2="${yy(b.from)}" stroke="${colors.muted}" stroke-dasharray="3 3"/>`;
    const label = b.kind === 'total' ? fmt(b.to) : (b.delta > 0 ? '+' : b.delta < 0 ? '−' : '') + fmt(Math.abs(b.delta));
    svg += `<text x="${x + w / 2}" y="${top - 6}" text-anchor="middle" font-size="12" font-weight="600" fill="${colors.text}">${label}</text>`;
    wrap(b.name, Math.max(8, Math.floor(bw / 7.2))).slice(0, 4).forEach((line, j) => {
      svg += `<text x="${x + w / 2}" y="${H - m.b + 16 + j * 13}" text-anchor="middle" font-size="10.5" fill="${b.kind === 'total' ? colors.text : colors.muted}" font-weight="${b.kind === 'total' ? 600 : 400}">${esc(line)}</text>`;
    });
  });
  svg += `<text x="${m.l}" y="14" font-size="11" fill="${colors.muted}">GPUs</text></svg>`;
  $('waterfall').innerHTML = svg;
  $('waterfallCaption').textContent = `From one shared pool of ${fmt(r.shared.gpus)} GPUs up through each cause to ${fmt(r.bordered.gpus)} GPUs across regions${r.levers.some((l) => state.levers[l.id]) ? `, then down through the optimizations you turned on to ${fmt(r.afterLevers.gpus)}` : ''}.`;
  $('waterfallTable').innerHTML = `<thead><tr><th>Step</th><th>GPUs</th><th>Running total</th><th>Note</th></tr></thead><tbody>${bars.map((b) => `<tr><td>${esc(b.name)}</td><td>${b.kind === 'total' ? '' : (b.delta > 0 ? '+' : '') + fmt(b.delta)}</td><td>${fmt(b.to)}</td><td>${esc(b.note || '')}</td></tr>`).join('')}</tbody>`;
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return f * p;
  return 10 * p;
}

function borderRows(r) {
  return r.borders.map((b) => ({
    Region: b.name,
    'Demand share': b.share,
    Copies: b.copies,
    GPUs: b.gpus,
    [unitWord(r).replace(/^./, (c) => c.toUpperCase())]: b.units,
    'Avg utilization': b.utilAvg,
    'Peak utilization': b.utilPeak,
    'IT kW': b.power.it,
    'Facility kW': b.power.facility,
  }));
}

function renderBorders(r) {
  const rows = borderRows(r);
  const cols = Object.keys(rows[0]);
  const cell = (k, v) => (k.includes('share') || k.includes('utilization') ? pct(v, k.includes('utilization') && v < 0.1 ? 1 : 0) : k.includes('kW') ? fmt(v, 1) : typeof v === 'number' ? fmt(v) : esc(v));
  const total = { Region: 'Total', 'Demand share': 1, Copies: r.borders.reduce((a, b) => a + b.copies, 0), GPUs: r.bordered.gpus, [cols[4]]: r.bordered.units, 'Avg utilization': r.bordered.utilAvg, 'Peak utilization': r.bordered.utilPeak, 'IT kW': r.bordered.power.it, 'Facility kW': r.bordered.power.facility };
  $('borderTable').innerHTML = `<caption class="hint">Copies include ${state.advanced.redundancy} spare${state.advanced.redundancy === 1 ? '' : 's'} per ${r.throughput && state.advanced.variants > 1 && state.advanced.variantMode === 'separate' ? 'variant per ' : ''}region.</caption>
    <thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${cols.map((c) => `<td>${cell(c, row[c])}</td>`).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr>${cols.map((c) => `<td>${cell(c, total[c])}</td>`).join('')}</tr></tfoot>`;
}

function renderExplain(r) {
  const t = r.throughput.split;
  const tp = r.throughput.pooled;
  const w = r.workload;
  $('explain').innerHTML = `<dl>
    <dt>GPUs per model copy: ${r.g === r.gShared ? r.g : `${r.g} in each region, ${r.gShared} in the shared pool`}</dt>
    <dd>${state.advanced.gpusPerCopy && state.advanced.gpusPerCopy !== 'auto'
      ? `Pinned to ${r.g} in Advanced.`
      : `Every size of 1, 2, 4 or 8 GPUs where ${esc(r.model.name)} weights at ${esc(state.precision)} plus the KV cache for ${w.targetConcurrency} concurrent requests of ${fmt(w.promptTokens + w.answerTokens)} tokens fit in 90% of ${fmt(r.gpu.memoryGB)} GB per GPU is sized, and the shared pool and the regions each keep their cheapest:`}</dd>
    ${r.tpOptions.length > 1 ? `<dd><table><thead><tr><th>GPUs per copy</th><th>Shared pool</th><th>With regions</th></tr></thead><tbody>${r.tpOptions.map((o) => `<tr><td>${o.g}</td><td>${fmt(o.shared)}${o.g === r.gShared ? ' ✓' : ''}</td><td>${fmt(o.bordered)}${o.g === r.g ? ' ✓' : ''}</td></tr>`).join('')}</tbody></table></dd>` : ''}
    <dt>Throughput per copy: ${fmt(t.rps, 2)} requests/s ${r.g === r.gShared ? 'split' : `per ${r.g}-GPU region copy`}, ${fmt(tp.rps, 2)} ${r.g === r.gShared ? 'pooled' : `per ${r.gShared}-GPU shared copy`}</dt>
    <dd>${esc(t.rule)}. At ${t.concurrency} concurrent requests: about ${fmt(t.perUserTokPerSec)} tokens/s per user (target ${w.outputTokensPerSecPerUser}), about ${fmt(t.ttftMs)} ms unloaded time to first token (target ${w.ttftMsP95} ms p95). Cache hit ${pct(r.hit.pooled)} pooled, ${pct(r.hit.split)} split.${t.adapterFactor ? ` Adapters cost ${pct(1 - t.adapterFactor, 1)} of throughput.` : ''}</dd>
    <dt>Copies per region</dt>
    <dd>max(1, ⌈peak × (1 + ${pct(state.advanced.headroom)}) ÷ R⌉) + ${state.advanced.redundancy}, then × GPUs per copy${state.advanced.variants > 1 && state.advanced.variantMode === 'separate' ? ` for each of ${state.advanced.variants} variants` : ''}, rounded up to ${r.unit} GPU${r.unit === 1 ? '' : 's'}.</dd>
    <dt>Data labels</dt>
    <dd>Results take the weakest label of their inputs: ${LABEL_TEXT[r.label].toLowerCase()}. GPU (${esc(r.gpu.name)}): ${esc(gpuLabels(r.gpu))}. Model: ${esc(r.model.label)}. Throughput: ${esc(r.labels.throughput)}. Workload shape and cache hit rates: ${esc(r.workload.label)}.</dd>
    <dt>Shared pool</dt>
    <dd>The same steps once for total demand, at the peak of the summed hourly curve (${fmt(r.borders.reduce((a, b) => a + b.peakRps, 0), 2)} req/s if peaks lined up, ${fmt(E.buildContext(state, data).pooledPeak, 2)} req/s actually).</dd>
  </dl>`;
}

function gpuLabels(g) {
  const pub = Object.entries(g.labels || {}).filter(([, l]) => l === 'published').map(([k]) => k);
  const names = { memoryGB: 'memory', memoryBandwidthTBs: 'bandwidth', tdpW: 'TDP', unitPowerKW: 'server power', precisions: 'precisions' };
  return pub.length ? `${g.label}, except ${pub.map((k) => names[k] || k).join(', ')} (published)` : g.label;
}

// ---------------------------------------------------------------------------
// Export

function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportPng() {
  const svg = $('waterfall').querySelector('svg');
  if (!svg) return;
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  const [, , W, H] = svg.getAttribute('viewBox').split(' ').map(Number);
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = W * 2;
    c.height = H * 2;
    const ctx = c.getContext('2d');
    ctx.scale(2, 2);
    ctx.drawImage(img, 0, 0, W, H);
    c.toBlob((b) => download('distribution-overhead-waterfall.png', b), 'image/png');
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
}

function exportCsv() {
  if (!last || last.error) return;
  const rows = borderRows(last);
  const cols = Object.keys(rows[0]);
  const q = (v) => (v == null ? '' : typeof v === 'number' ? String(+v.toFixed(4)) : `"${String(v).replace(/"/g, '""')}"`);
  const csv = [cols.map(q).join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
  download('distribution-overhead-regions.csv', new Blob([csv], { type: 'text/csv' }));
}

// ---------------------------------------------------------------------------
// Wiring

function onChange(e) {
  const id = e.target.id;
  readForm();
  // Inputs whose change alters other inputs' options re-render the form.
  if (['gpu', 'model', 'workload', 'shape', 'purchaseUnit'].includes(id)) writeForm();
  render();
}

function applyView() {
  const view = state.ui?.view === 'detail' ? 'detail' : 'overview';
  document.body.dataset.view = view;
  document.querySelectorAll('.view-toggle button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
  const open = !!state.ui?.breakdown;
  $('breakdown').classList.toggle('open', open);
  $('toggleBreakdown').setAttribute('aria-expanded', String(open));
  $('toggleBreakdown').textContent = open ? 'Hide the full breakdown' : 'Show the full breakdown';
}

function renderDataVersion() {
  const f = [data.gpus, data.models, data.throughput];
  const updated = f.map((x) => x.updated).sort().pop();
  $('dataVersion').innerHTML = `Runs in your browser; nothing you enter leaves this page. Data ${esc(data.gpus.version)} · updated ${esc(updated)} · <a href="../CHANGELOG.md">changelog</a>`;
}

async function main() {
  try {
    data = await loadData();
  } catch (e) {
    $('error').hidden = false;
    $('error').textContent = e.message;
    return;
  }
  state = decodeScenario(location.hash) || defaultScenario();
  renderDataVersion();
  applyView();
  writeForm();
  render();

  document.querySelectorAll('.view-toggle button').forEach((b) => b.addEventListener('click', () => {
    state.ui.view = b.dataset.view;
    if (state.ui.view === 'detail') $('borderEditor').open = true;
    applyView();
    render();
  }));
  $('toggleBreakdown').addEventListener('click', () => {
    state.ui.breakdown = !state.ui.breakdown;
    applyView();
    render();
  });

  const form = $('inputs');
  form.addEventListener('change', onChange);
  form.addEventListener('input', (e) => {
    if (e.target.matches('input[type="number"], input[type="text"], textarea, #borders input')) onChange(e);
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('borderPreset').addEventListener('change', (e) => {
    if (!e.target.value || e.target.value === 'custom') return;
    state = applyBorderPreset(state, e.target.value);
    writeForm();
    render();
  });
  $('borders').addEventListener('click', (e) => {
    const i = e.target.dataset?.remove;
    if (i == null) return;
    state.borders.splice(Number(i), 1);
    writeBorders();
    render();
  });
  $('addBorder').addEventListener('click', () => {
    if (state.borders.length >= 20) return;
    state.borders.push({ name: `Region ${state.borders.length + 1}`, tz: 0, share: 1 });
    writeBorders();
    render();
  });
  $('reset').addEventListener('click', () => {
    state = { ...defaultScenario(), ui: state.ui };
    writeForm();
    render();
  });
  $('shapeFile').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text(); // read locally; never uploaded
    const vals = text.split(/\r?\n/).map((l) => l.split(/[,;\t]/).map((x) => x.trim()).filter(Boolean).pop()).map(Number).filter((n) => isFinite(n));
    $('customShape').value = vals.slice(-24).join(', ');
    readForm();
    render();
  });
  $('exportPng').addEventListener('click', exportPng);
  $('exportCsv').addEventListener('click', exportCsv);
  $('copyLink').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(location.href);
      $('copied').textContent = 'Link copied. The scenario is in the part after #, which is never sent to a server.';
    } catch {
      $('copied').textContent = 'Copy the address bar to share this scenario.';
    }
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => last && !last.error && renderSummaryChart(last), 120);
  });
  window.addEventListener('hashchange', () => {
    const s = decodeScenario(location.hash);
    if (s && JSON.stringify(s) !== JSON.stringify(state)) {
      state = s;
      applyView();
      writeForm();
      render();
    }
  });
}

main();
