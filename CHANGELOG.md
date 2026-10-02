# Changelog

Data files and the engine are versioned separately. Data versions are `YYYY.MINOR.PATCH`; the engine follows the package version.

## Engine 0.2.0 — 2026-10-02

- **GPUs per copy is now the cheapest size that fits, not the smallest.** Every tensor-parallel size that fits in memory is sized. The shared pool and the bordered deployment each keep the size that needs the fewest GPUs, with ties going to the smaller size.
  - All borders share one size, and the shared pool can use a different one.
  - When the sizes differ, the change shows up in the waterfall's per-border floor step.
  - The levers, the burst pool and the cost crossover also use the cheapest size.
  - A size pinned in Advanced still applies to everything.
- **Effect** (all 400 GPU × model × precision × workload combinations, default six-border scenario): 67 combinations change; nothing ever needs more GPUs.
  - The default scenario (70B FP8, agent, B300) and the deck fixture are unchanged.
  - The largest changes are where the smallest copy couldn't meet the per-user speed target and ran one request at a time. Examples:
    - RTX PRO 6000, 70B BF16, chat: 1,496 → 64 GPUs shared and 1,536 → 144 with borders, at 8 GPUs per copy instead of 4.
    - B300, Qwen3 235B-A22B BF16, voice: shared 56 → 32 at 4 GPUs per copy. The borders stay at 2 GPUs per copy and 96 GPUs.
  - Most chat and voice results on L40S, RTX PRO 6000 and the AMD GPUs for the 32B, 70B and MoE models drop several-fold.

## Data 2026.10.1 — 2026-10-02

GPU catalog updated from a verified-specs report. Every value below was fetched from its primary source.

- **B300 (default GPU): memory changed from 288 GB to 270 GB per GPU**, and bandwidth from 8 to 7.7 TB/s. Source: the NVIDIA Blackwell Ultra datasheet ("270 GB HBM3E | 7.7 TB/s" for HGX B300; 8 × 270 GB matches the "2.1 TB" on NVIDIA's HGX and DGX B300 pages). NVIDIA's DGX B300 User Guide and Enterprise RA say 288 GB / 2.3 TB, and NVIDIA's blog calls 288 GB the maximum, with capacity varying by SKU. The calculator uses the more conservative datasheet figure.
  - Added TDP of up to 1,100 W.
  - Unit power is 14.5 kW, from the DGX B300 datasheet busbar figure.
  - Memory, bandwidth, TDP and unit power are now labeled `published`.
- **GB300 NVL72:** memory changed from 278 to 279 GB per GPU at 8 TB/s, with TDP of up to 1,400 W per GPU, from the Blackwell Ultra datasheet. These are labeled `published`. Rack power stays a modeled ~135 kW.
- **MI300X and MI325X:** memory, bandwidth, board power (750 W and 1,000 W) and precisions now cite amd.com product pages and datasheets, and are labeled `published`. Precisions are BF16 and FP8 only; neither part lists FP6 or FP4.
- **Server power estimates** (still `modeled`):
  - RTX PRO 6000: 7.3 kW
  - L40S: changed from 5.3 to 4.8 kW
  - MI300X: 8.5 kW
  - MI325X: changed from 10.5 to 11.5 kW
  - MI355X: changed from 13.7 to 13 kW, now specified as the liquid-cooled system
- **New fields `psu_ceiling_kw` and `psu_ceiling_source`** on each of those five: active PSUs × PSU rating for a named Supermicro server. A new test checks that modeled unit power never exceeds this ceiling. MI355X is close: 13 kW against a 13.2 kW ceiling at 239–240 VAC, and the ceiling is 11.8 kW at 200–207.9 VAC.
- **Effect on sizing** (all 400 GPU × model × precision × workload combinations rerun):
  - The default scenario is unchanged: 70B FP8, agent, B300, 1 GPU per copy, 8 shared vs 48 with borders.
  - GPUs per copy changed in 7 combinations:
    - B300 70B BF16 batch: 2 → 4
    - B300 70B FP8 batch: 1 → 2
    - B300 235B-A22B BF16 chat: 2 → 4
    - B300 235B-A22B FP8 chat: 1 → 2
    - B300 70B BF16 voice: unchanged at 1, but 136 → 144 shared, from the lower bandwidth
    - GB300 70B BF16 batch: 4 → 2
    - GB300 70B FP8 batch: 2 → 1
  - The two GB300 changes come from 1 GB more memory per GPU, which crosses the fit threshold.

## Data 2026.10.0 — 2026-10-02

- First GPU catalog: H100, H200, B200, B300 (default), GB300 NVL72 (rack unit), RTX PRO 6000, L40S, MI300X, MI325X, MI355X.
  Values were checked against search excerpts of vendor pages, but the pages themselves could not be fetched from the build environment, so **every GPU record is labeled `modeled`** until someone fetches the datasheets and switches them to `published`. Server power for RTX PRO 6000, L40S and the AMD platforms, and the GB300 NVL72 rack power, are estimates.
- First model catalog: Llama 3.1 8B, Qwen3 32B, Llama 3.3 70B, Qwen3 235B-A22B (from model cards).
- Workload shapes for chat, agent, voice and batch, with cache hit rates that are assumptions pending the prefix-cache replay.
- Throughput table has no measured rows yet. All throughput is modeled from the roofline scaling rules with placeholder H100 calibration coefficients.

## Engine 0.1.0 — 2026-10-02

- First release of the sizing engine, scenario presets, URL-fragment sharing and the plain reference page.
