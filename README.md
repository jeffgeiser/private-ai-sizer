# Private AI Sizer — Sovereignty Tax Calculator

A browser-only calculator that sizes private inference capacity across one or more borders and shows what each border costs compared with one shared pool. Borders can be countries, business units, tenants or latency-driven regional pools.

**This is a planning estimate, not a quote.** Every number carries a label: `measured` (our benchmark), `published` (vendor) or `modeled`. A result built from mixed inputs takes the weakest label. In this first release everything is `modeled`, because the benchmark results aren't in the data files yet.

Nothing a user enters leaves the browser. The page fetches only the three static data files. The scenario is stored in the URL fragment (after `#`), which browsers never send to a server.

## Layout

| Path | What |
| --- | --- |
| `src/engine.js` | The sizing engine: pure functions, no DOM, no network. This is what the branded page builds on. |
| `src/scenario.js` | Defaults, border presets, URL-fragment encode/decode. |
| `src/data-node.js` | Loads the data files in Node (tests, scripts). |
| `data/gpus.json` | GPU catalog. |
| `data/models.json` | Model catalog. |
| `data/throughput.json` | Workload shapes, scaling coefficients, and measured/published throughput rows. |
| `web/` | Plain reference page (`index.html`, `app.js`, `style.css`). |
| `test/` | Unit and property tests (`node:test`, no dependencies). |

## Running

```sh
npm test                 # Node 20+, no install needed
node scripts/serve.js    # then open http://localhost:8080/web/
```

The page imports `../src/*.js` and fetches `../data/*.json`, so any static host that serves the repo root works.

## Using the engine

```js
import { calculate } from 'private-ai-sizer';
import { defaultScenario } from 'private-ai-sizer/scenario';

const result = calculate(defaultScenario(), { gpus, models, throughput });
// result.shared.gpus, result.bordered.gpus, result.tax, result.causes (waterfall),
// result.levers, result.afterLevers, result.borders (per-border table), result.cost, result.labels
```

`calculate` returns `{ error }` instead of numbers when the model doesn't fit the GPU or the precision isn't supported.

## Sizing model

1. **Hourly demand per border.** Daily demand spread over 24 hours by the demand shape, shifted by each border's UTC offset (half-hour zones are interpolated).
2. **GPUs per copy.** Every g in {1, 2, 4, 8} with `g · M_gpu · 0.9 ≥ P·b + c·L·2·n_layers·n_kv·d_head·b_kv` is a candidate, where c is the workload's target concurrency and L is prompt plus answer length. Steps 3–6 run at each candidate. The shared pool and the bordered deployment each keep the size that needs the fewest GPUs, with ties going to the smaller size. All borders share one size, and the shared pool can use a different one. The smallest size that fits isn't always cheapest: a copy that barely fits has little room for concurrent requests, and a small copy may miss the per-user speed target. A size can be pinned in Advanced. Because bordered ≥ shared at every size, the cheapest bordered result is never below the cheapest shared result.
3. **Throughput per copy (R).** Modeled as `1 / (prompt·(1−cache hit) / prefill rate + answer / decode rate)`.
   - Prefill is compute-bound: `g × dense TFLOPS at the precision × efficiency ÷ (2 × active params)`.
   - Decode is bandwidth-bound: each step reads the weights touched (for MoE, roughly `1−(1−active/total)^c` of the experts) plus every active request's KV cache, at `g × bandwidth × efficiency`.
   - The latency target selects the throughput point: the largest concurrency up to the target that still meets per-user output speed.
   - Vendor software efficiency multiplies both (1.0 for NVIDIA, 0.8 placeholder for AMD).
   - A measured or published row in `throughput.json` replaces the model for its exact combination.
4. **Copies per border.** `max(1, ⌈peak·(1+h)/R⌉) + r`. With V separate fine-tuned variants, each variant serves 1/V of the demand and gets its own floor and spares.
5. **GPUs per border.** Copies × g, rounded up to the purchase unit.
6. **Shared pool.** The same steps once, at the peak of the summed hourly curve, with the pooled cache hit rate.
7. **Tax and waterfall.** The constraints are switched on one at a time in a fixed order: separate peaks, per-border floor, redundancy, purchase-unit rounding, duplicated models, fragmented caches. State 0 is the shared pool and state 6 is the bordered total, so the steps always sum exactly. States 0–1 use the shared pool's copy size and states 2–6 use the borders' size. When the two differ, the change lands in the per-border floor step, because small borders favour small copies when each border pays its own floor and spares. Where ceilings interact, a raw intermediate state can dip. Each state is therefore clamped between the previous state and the bordered total, which keeps every step at zero or above.
8. **Levers**, applied in a fixed order: burst the share whose data may leave (to one shared pool with its own floor and spares), pool borders with the same jurisdiction group, buy single GPUs, right-size the model, serve variants as adapters. A lever that would add GPUs isn't applied, and its step says why.
9. **Utilization, power, cost.**
   - Utilization is demand in GPU-equivalents divided by deployed GPUs.
   - IT power is units × kW per unit; facility power is IT power × PUE.
   - Private cost is GPUs × price per GPU-hour × 730.
   - API cost is monthly tokens × entered prices, split by prompt and answer length.
   - The crossover is found by scanning demand from 1/1000× to 1000× and bisecting.

## Updating the data

Only the JSON files change when numbers change. Every record carries a `label` and a `source`. Per-field labels and sources go in `labels` and `sources`, and can be stronger or weaker than the record label. A result takes the weakest label it depends on. Estimated server power also carries `psu_ceiling_kw`, which is active PSUs × PSU rating for a named OEM server, and `psu_ceiling_source`. Bump `version` and `updated`, and add a line to `CHANGELOG.md`.

To add a benchmark result, append a row to `throughput.json`:

```json
{ "model": "llama-3.3-70b", "gpu": "h100-sxm", "precision": "FP8", "workload": "agent",
  "gpusPerCopy": 8, "cacheHit": 0.6, "requestsPerSecPerCopy": 9.1,
  "ttftMsP95": 2000, "outputTokensPerSecPerUser": 30,
  "label": "measured", "source": "link to the run" }
```

If a scenario's cache hit rate differs from the row's, the engine scales the row by the modeled ratio and labels the result `modeled`.

## Validation status

- [x] One border equals the shared pool; more borders never need fewer GPUs; no lever increases the total; zero demand still shows the floor; a model that fits nowhere shows a message. These are checked over 1,500 random scenarios.
- [x] The waterfall adds up exactly to the bordered and after-levers totals.
- [x] Unit tests for every step (`npm test`).
- [x] Slide 10: with the deck's assumptions it returns 16 vs 96 GPUs. The fixture is H100, 70B FP8, one 8-GPU server per copy, flat demand, N+1, whole servers, 2 B tokens/day over six borders. The flat shape and the 8 GPUs per copy are inferred; check them against the deck. Under the auto memory fit, 70B FP8 fits in 2 × H100, which gives 16 vs 48.
- [x] Slide 11: a 1% market deploys 16 GPUs. **Open:** "about 3 GPUs of demand, about 7% utilization" needs the deck's total demand for that slide. The test is marked `todo`.
- [ ] Agrees with the benchmark within 10%. Needs the H100 sweep in `throughput.json`.
- [x] Modeled server power is at or below the PSU ceiling (`psu_ceiling_kw`: active PSUs × rating) for every GPU that has one.
- [ ] Rest of the GPU catalog switched from `modeled` to `published` after a direct datasheet check. Done for B300 and GB300 memory, bandwidth and power, and for MI300X and MI325X memory, bandwidth, power and precisions. Still pending for TFLOPS and the other GPUs.
- [ ] Outside review by an infrastructure engineer; legal and marketing review of the disclaimer and example prices.
