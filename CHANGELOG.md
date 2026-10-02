# Changelog

Data files and the engine are versioned separately. Data versions are `YYYY.MINOR.PATCH`; the engine follows the package version.

## Data 2026.10.0 — 2026-10-02

- First GPU catalog: H100, H200, B200, B300 (default), GB300 NVL72 (rack unit), RTX PRO 6000, L40S, MI300X, MI325X, MI355X.
  Values were checked against search excerpts of vendor pages, but the pages themselves could not be fetched from the build environment, so **every GPU record is labeled `modeled`** until someone fetches the datasheets and switches them to `published`. Server power for RTX PRO 6000, L40S and the AMD platforms, and the GB300 NVL72 rack power, are estimates.
- First model catalog: Llama 3.1 8B, Qwen3 32B, Llama 3.3 70B, Qwen3 235B-A22B (from model cards).
- Workload shapes for chat, agent, voice and batch, with cache hit rates that are assumptions pending the prefix-cache replay.
- Throughput table has no measured rows yet. All throughput is modeled from the roofline scaling rules with placeholder H100 calibration coefficients.

## Engine 0.1.0 — 2026-10-02

- First release of the sizing engine, scenario presets, URL-fragment sharing and the plain reference page.
