// Reference page for the sizing engine. Everything is computed in the browser.
// The only network requests are for the static data files on page load; no
// input value is ever sent anywhere. The scenario is kept in the URL fragment.
import * as E from '../src/engine.js';
import { defaultScenario, normalizeScenario, encodeScenario, decodeScenario, applyBorderPreset, BORDER_PRESETS, EXAMPLE_PRICES } from '../src/scenario.js';

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

function badge(label, title) {
  return `<span class="badge ${label}" title="${esc(title || label)}">${label}</span>`;
}

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
  options($('gpu'), data.gpus.gpus.map((g) => [g.id, `${g.name}${g.purchaseUnit === 'rack' ? ` (${g.gpusPerUnit}-GPU rack)` : ` (${g.gpusPerUnit}-GPU server)`}`]), s.gpu);
  const gpu = data.gpus.gpus.find((g) => g.id === s.gpu);
  if (!gpu.precisions.includes(s.precision)) s.precision = gpu.precisions.includes('FP8') ? 'FP8' : gpu.precisions[0];
  options($('precision'), gpu.precisions.map((p) => [p, p]), s.precision);

  $('demandMode').value = s.demand.mode;
  $('demandValue').value = s.demand.mode === 'tokens' ? +(s.demand.tokensPerDay / 1e9).toPrecision(6) : s.demand.requestsPerDay;
  options($('borderPreset'), [['', 'Choose a preset…'], ...BORDER_PRESETS.map((p) => [p.id, p.name])], '');
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
  const p = a.prices;
  $('currency').value = p.currency;
  $('gpuHour').value = p.gpuHour;
  $('apiIn').value = p.apiInPerM;
  $('apiOut').value = p.apiOutPerM;
  $('priceNote').textContent = p.example
    ? 'These are labeled example prices, not quotes or vendor list prices. Enter your own to replace them.'
    : 'Using the prices you entered.';
  writeLevers();
}

function nameOf(modelId) {
  return data.models.models.find((m) => m.id === modelId)?.name;
}

function setOptional(id, value, presetValue) {
  $(id).value = value ?? '';
  $(id).placeholder = `${presetValue} (preset)`;
}

function writeBorders() {
  const box = $('borders');
  box.innerHTML = state.borders.map((b, i) => `
    <div class="border" data-i="${i}">
      <label>Name <input data-f="name" value="${esc(b.name)}" aria-label="Border ${i + 1} name"></label>
      <label>UTC± <input data-f="tz" type="number" step="0.5" min="-12" max="14" value="${b.tz ?? 0}" aria-label="Border ${i + 1} time zone offset"></label>
      <label>Share <input data-f="share" type="number" min="0" step="any" value="${b.share ?? 1}" aria-label="Border ${i + 1} share of demand"></label>
      <button type="button" class="secondary" data-remove="${i}" aria-label="Remove border ${i + 1}"${state.borders.length <= 1 ? ' disabled' : ''}>×</button>
      <label class="group">Jurisdiction group (borders in the same group can pool) <input data-f="group" value="${esc(b.group || '')}" placeholder="own" aria-label="Border ${i + 1} group"></label>
    </div>`).join('');
  $('addBorder').disabled = state.borders.length >= 20;
}

function writeLevers() {
  const notes = Object.fromEntries((last?.levers || []).map((l) => [l.id, l]));
  $('levers').innerHTML = E.LEVERS.map((l) => {
    const n = notes[l.id];
    const note = n ? (n.applied ? `${fmt(n.gpus)} GPUs. ${n.note || ''}` : n.note) : '';
    return `<div class="lever"><label><input type="checkbox" data-lever="${l.id}"${state.levers[l.id] ? ' checked' : ''}>${esc(l.name)}</label>${note ? `<span class="note">${esc(note)}</span>` : ''}</div>`;
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
    b.name = f('name') || `Border ${Number(row.dataset.i) + 1}`;
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
  const prices = { currency: $('currency').value.trim() || 'USD', gpuHour: num('gpuHour') || 0, apiInPerM: num('apiIn') || 0, apiOutPerM: num('apiOut') || 0 };
  const isExample = prices.gpuHour === EXAMPLE_PRICES.gpuHour && prices.apiInPerM === EXAMPLE_PRICES.apiInPerM && prices.apiOutPerM === EXAMPLE_PRICES.apiOutPerM;
  a.prices = { ...prices, example: isExample };

  document.querySelectorAll('[data-lever]').forEach((c) => (s.levers[c.dataset.lever] = c.checked));
}

// ---------------------------------------------------------------------------
// Results

function render() {
  let r;
  try {
    r = E.calculate(state, data);
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

  const L = r.labels;
  const tipGpu = `GPUs per copy from the memory formula; throughput: ${r.throughput.split.rule}`;
  const power = (p) => `${fmt(p.it, 1)} kW IT${p.facility != null ? ` · ${fmt(p.facility, 1)} kW facility (PUE ${p.pue})` : ''}`;
  const after = r.levers.some((l) => l.applied);
  $('headline').innerHTML = `
    <div class="stat"><div class="k">GPUs with borders ${badge(L.gpus, tipGpu)}</div><div class="v">${fmt(r.bordered.gpus)}</div><div class="s">${fmt(r.bordered.units)} ${unitWord(r)} · ${pct(r.bordered.utilAvg)} avg used</div></div>
    <div class="stat"><div class="k">One shared pool ${badge(L.gpus, tipGpu)}</div><div class="v">${fmt(r.shared.gpus)}</div><div class="s">${pct(r.shared.utilAvg)} avg used</div></div>
    <div class="stat"><div class="k">Sovereignty tax ${badge(L.gpus, tipGpu)}</div><div class="v">+${fmt(r.tax.gpus)}</div><div class="s">+${pct(r.tax.pct)}${after ? ` · ${signed(r.afterLevers.taxGpus)} (${signed(r.afterLevers.taxPct, pct)}) after levers` : ''}</div></div>
    <div class="stat"><div class="k">IT power with borders ${badge(L.power, 'Servers × kW per server from the GPU catalog')}</div><div class="v">${fmt(r.bordered.power.it, 1)} kW</div><div class="s">vs ${fmt(r.shared.power.it, 1)} kW shared${r.bordered.power.facility != null ? ` · ${fmt(r.bordered.power.facility, 1)} kW facility` : ''}</div></div>`;
  $('sticky').textContent = `Sovereignty tax: +${fmt(r.tax.gpus)} GPUs (+${pct(r.tax.pct)})${after ? ` · after levers ${signed(r.afterLevers.taxGpus)}` : ''}`;

  $('warnings').innerHTML = r.warnings.map((x) => `<div class="warn">${esc(x)}</div>`).join('');

  renderWaterfall(r);
  renderBorders(r, power);
  renderCost(r);
  renderExplain(r);
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
  bars.push({ name: 'With borders', kind: 'total', from: 0, to: r.bordered.gpus });
  const on = r.levers.filter((l) => state.levers[l.id]);
  if (on.length) {
    for (const l of on) {
      bars.push({ name: l.name, kind: 'lever', from: y, to: y + l.gpus, delta: l.gpus, note: l.applied ? '' : l.note });
      y += l.gpus;
    }
    bars.push({ name: 'After levers', kind: 'total', from: 0, to: r.afterLevers.gpus });
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
    <title id="wfTitle">Sovereignty tax waterfall</title>
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
  $('waterfallCaption').textContent = `From one shared pool of ${fmt(r.shared.gpus)} GPUs up through each cause to ${fmt(r.bordered.gpus)} GPUs with borders${r.levers.some((l) => state.levers[l.id]) ? `, then down through the levers you switched on to ${fmt(r.afterLevers.gpus)}` : ''}. Every step is ${r.labels.gpus}.`;
  $('waterfallTable').innerHTML = `<thead><tr><th>Step</th><th>GPUs</th><th>Running total</th><th>Note</th></tr></thead><tbody>${bars.map((b) => `<tr><td>${esc(b.name)}</td><td>${b.kind === 'total' ? '' : (b.delta > 0 ? '+' : '') + fmt(b.delta)}</td><td>${fmt(b.to)}</td><td>${esc(b.note || '')}</td></tr>`).join('')}</tbody>`;
}

function niceMax(v) {
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * p >= v) return f * p;
  return 10 * p;
}

function borderRows(r) {
  return r.borders.map((b) => ({
    Border: b.name,
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
  const total = { Border: 'Total', 'Demand share': 1, Copies: r.borders.reduce((a, b) => a + b.copies, 0), GPUs: r.bordered.gpus, [cols[4]]: r.bordered.units, 'Avg utilization': r.bordered.utilAvg, 'Peak utilization': r.bordered.utilPeak, 'IT kW': r.bordered.power.it, 'Facility kW': r.bordered.power.facility };
  $('borderTable').innerHTML = `<caption class="hint">Per-border sizing ${badge(r.labels.gpus)}. Copies include ${state.advanced.redundancy} spare${state.advanced.redundancy === 1 ? '' : 's'} per ${r.throughput && state.advanced.variants > 1 && state.advanced.variantMode === 'separate' ? 'variant per ' : ''}border.</caption>
    <thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((row) => `<tr>${cols.map((c) => `<td>${cell(c, row[c])}</td>`).join('')}</tr>`).join('')}</tbody>
    <tfoot><tr>${cols.map((c) => `<td>${cell(c, total[c])}</td>`).join('')}</tr></tfoot>`;
}

function money(v, cur) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(v);
  } catch {
    return `${cur} ${fmt(v)}`;
  }
}

function renderCost(r) {
  const c = r.cost;
  if (!c) {
    $('cost').innerHTML = '<p class="hint">Enter a GPU-hour price and API token prices in Advanced to compare private capacity with a public API.</p>';
    return;
  }
  const x = c.crossover;
  const crossoverText = !x
    ? 'Private capacity isn’t cheaper than the API anywhere from 1/1000× to 1000× this demand.'
    : x.belowRange
      ? 'Private capacity is cheaper than the API even at 1/1000 of this demand.'
      : `Private capacity with these borders becomes cheaper above about <strong>${compact(x.tokensPerMonth)} tokens per month</strong> (this scenario: ${compact(c.tokensPerMonth)}).`;
  $('cost').innerHTML = `
    ${c.examplePrices ? '<p class="warn">Example prices, for illustration only. They are not quotes or vendor list prices; enter your own in Advanced.</p>' : ''}
    <table><thead><tr><th>Monthly cost ${badge('modeled', 'GPUs × price per GPU-hour × 730 h; API: monthly tokens × entered prices')}</th><th>${esc(c.currency)}</th></tr></thead><tbody>
      <tr><td>Private, with borders</td><td>${money(c.privateBordered, c.currency)}</td></tr>
      <tr><td>Private, one shared pool</td><td>${money(c.privateShared, c.currency)}</td></tr>
      ${r.levers.some((l) => l.applied) ? `<tr><td>Private, after levers</td><td>${money(c.privateAfterLevers, c.currency)}</td></tr>` : ''}
      <tr><td>Public API, same tokens</td><td>${money(c.api, c.currency)}</td></tr>
    </tbody></table>
    <p>${crossoverText}</p>`;
}

function renderExplain(r) {
  const t = r.throughput.split;
  const tp = r.throughput.pooled;
  const w = r.workload;
  $('explain').innerHTML = `<dl>
    <dt>GPUs per model copy: ${r.g} ${badge('modeled', 'Memory formula; validated by the H100 footprint test once it lands')}</dt>
    <dd>Smallest of 1, 2, 4 or 8 GPUs where ${esc(r.model.name)} weights at ${esc(state.precision)} plus the KV cache for ${w.targetConcurrency} concurrent requests of ${fmt(w.promptTokens + w.answerTokens)} tokens fit in 90% of ${fmt(r.gpu.memoryGB)} GB per GPU.</dd>
    <dt>Throughput per copy: ${fmt(t.rps, 2)} requests/s split, ${fmt(tp.rps, 2)} pooled ${badge(r.labels.throughput, t.rule)}</dt>
    <dd>${esc(t.rule)}. At ${t.concurrency} concurrent requests: about ${fmt(t.perUserTokPerSec)} tokens/s per user (target ${w.outputTokensPerSecPerUser}), about ${fmt(t.ttftMs)} ms unloaded time to first token (target ${w.ttftMsP95} ms p95). Cache hit ${pct(r.hit.pooled)} pooled, ${pct(r.hit.split)} split.${t.adapterFactor ? ` Adapters cost ${pct(1 - t.adapterFactor, 1)} of throughput.` : ''}</dd>
    <dt>Copies per border</dt>
    <dd>max(1, ⌈peak × (1 + ${pct(state.advanced.headroom)}) ÷ R⌉) + ${state.advanced.redundancy}, then × GPUs per copy${state.advanced.variants > 1 && state.advanced.variantMode === 'separate' ? ` for each of ${state.advanced.variants} variants` : ''}, rounded up to ${r.unit} GPU${r.unit === 1 ? '' : 's'}.</dd>
    <dt>Shared pool</dt>
    <dd>The same steps once for total demand, at the peak of the summed hourly curve (${fmt(r.borders.reduce((a, b) => a + b.peakRps, 0), 2)} req/s if peaks lined up, ${fmt(E.buildContext(state, data).pooledPeak, 2)} req/s actually).</dd>
  </dl>`;
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
    c.toBlob((b) => download('sovereignty-tax-waterfall.png', b), 'image/png');
  };
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
}

function exportCsv() {
  if (!last || last.error) return;
  const rows = borderRows(last);
  const cols = Object.keys(rows[0]);
  const q = (v) => (v == null ? '' : typeof v === 'number' ? String(+v.toFixed(4)) : `"${String(v).replace(/"/g, '""')}"`);
  const csv = [cols.map(q).join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\n');
  download('sovereignty-tax-borders.csv', new Blob([csv], { type: 'text/csv' }));
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

function renderDataVersion() {
  const f = [data.gpus, data.models, data.throughput];
  const updated = f.map((x) => x.updated).sort().pop();
  $('dataVersion').innerHTML = `Data version: GPUs ${esc(data.gpus.version)}, models ${esc(data.models.version)}, throughput ${esc(data.throughput.version)} · last updated ${esc(updated)} · <a href="../CHANGELOG.md">changelog</a>. Until the benchmark sweep is published, throughput and GPU values are labeled modeled.`;
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
  writeForm();
  render();

  const form = $('inputs');
  form.addEventListener('change', onChange);
  form.addEventListener('input', (e) => {
    if (e.target.matches('input[type="number"], input[type="text"], textarea, #borders input')) onChange(e);
  });
  form.addEventListener('submit', (e) => e.preventDefault());
  $('borderPreset').addEventListener('change', (e) => {
    if (!e.target.value) return;
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
    state.borders.push({ name: `Border ${state.borders.length + 1}`, tz: 0, share: 1 });
    writeBorders();
    render();
  });
  $('reset').addEventListener('click', () => {
    state = defaultScenario();
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
  window.addEventListener('hashchange', () => {
    const s = decodeScenario(location.hash);
    if (s && JSON.stringify(s) !== JSON.stringify(state)) {
      state = s;
      writeForm();
      render();
    }
  });
}

main();
