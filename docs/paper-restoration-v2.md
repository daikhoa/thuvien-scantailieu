# Paper restoration v2 and the two-engine browser comparison

## Scope

Web JavaScript and the custom C++ kernel share the paper-v2 policy. Enhanced is
still the default; Original and the other filters remain selectable. The browser
comparison now runs only Web/custom C++, using the same source/crop/encoder and
alternating run order. The OpenCV selector, presets, result path and private WASM
exports are removed from the new browser target. Oldv1-v6 assets are immutable
historical checkpoints, not selected by the new application.

The Windows public C ABI and its optional OpenCV entrypoint are preserved for
compatibility. The DLL keeps its OpenCV/ORT/codec dependencies. No alternate
backend is substituted when an engine fails. The native default/custom filter is
updated; no public API is removed or turned into an unsupported stub.

## Root cause and policy

The24x24 coarse evidence grid could miss a narrow crease: its bright percentile
represented surrounding paper, while the dark strip failed the paper mask or
looked like a solid printed fill. The following contrast curve could then darken
that uncorrected strip. A simple denser confidence grid was rejected: it made
text-cell decisions unstable and produced patchy restoration.

Keep the coarse paper/color evidence. Add a bounded fine background field only
after the existing text, neutral reference and color checks pass. A small probe
chooses64x256 or256x64 maximum cells, spending the same budget on the sharper
illumination axis. Probe bins follow actual sample positions, exclude ink and
ignore border artifacts; weak orientation evidence defaults to horizontal
creases. No orientation depends on a particular document or photo.

Fine estimates use sampled8-bit histograms, local paper RGB and mean dark-stroke
brightness relative to paper. A darker printed band has different relative ink
contrast from a physical shadow; ambiguous dark fills retain the coarse estimate.
Only small gaps surrounded by recognized paper can be bridged. Evidence spreads
through supported, similar-lighting cells with explicit visited bounds. Isolated
letter fragments cannot activate a flat page: a connected dark component needs
multiple matching ink samples, quarter-page span and less than18% page area.

The existing single original-resolution application pass interpolates this field,
protects colored pixels/solid fills/alpha/highlights and retains original-row
neighbors. The same contrast/detail curve follows using the original quality
profile. There is no additional full-resolution float background or extra
full-resolution rendering pass. Fine workspace is bounded (at most16384cells,
64bins each, a few megabytes); no new dependency/model/inference is introduced.

This is illumination restoration, not dense geometric dewarping. Four-corner
perspective still supplies geometry. A physical crease line, hidden details,
curved text or silhouette can remain; no invented text or generative repair.
Some neutral printed gradients and illumination are inherently ambiguous in one
photo, so this policy remains conservative.

## Verification and reproduction

- `npm test -- --exclude '**/.tmp-*/**' --maxWorkers 2`:559tests, including21
  paper-policy cases. Horizontal, vertical, diagonal and faint-ink creases fail
  on the previous implementation. Printed gray bars in both orientations, color
  graphics crossing a crease, pastel/color paper, inverse/photo/noisy/flat input,
  alpha, determinism and full-size output are covered.
- `node scripts/verify-paper-restoration-v2.mjs`:17policy/native goldens, strict
  Web/custom WASM parity (max1level, mean<.05), matching baseline Web/Cppv6,
  actual20repeat cleanup and3.15MP parity. Baseline is Gitf331cf7 plus immutable
  WASMv6. GeneratedPPMs under `.tmp-paper-v2/contracts` feed native
  `tests/golden/paper-v2` and its independent `paper_contract` CTest.
- `node scripts/test-docscan-wasm.mjs`:16filter/crop/input cases and exact
  owned/read-only staging parity, error cleanup, absent OpenCV exports.
- `node scripts/test-wasm-memory-budget.mjs v7`:48MP document-like raster with
  text and a crease (so restoration executes), unchanged3000x2250output, under
  the320MiB allocation ceiling. A tighter ceiling returns status8/no output.
- `node scripts/audit-paper-corpus.mjs .tmp-quality/samples/index.json docs/paper-restoration-v2-real-corpus.json`
  and the same command for `.tmp-opencv-tune/samples/index.json` with output
  `docs/paper-restoration-v2-holdout.json`:19controls including15licensed
  SmartDoc frames retain all additional-policy pixels. In14development/holdout
  samples, only the four shadow/uneven cases change. Inputs are prepared with
  the existing `prepare-quality-samples.py`/`prepare-opencv-tuning.py` scripts.
- Native seven CTest suites include ABI, runtime incompatibility, original24
  raw goldens, seventeen new policy goldens/cancellation, integration/PDF and
  the retained optional native OpenCV compatibility tests.
- Private supplied photos were checked with the exact same approximate manual
  quad before/after; they are excluded from source, fixtures and publication.

In the narrow-shadow fixtures, a142input paper level became136(previous Web)
or133(faint ink); v2 returns227. The diagonal144input improves138->231.
These are fixture reference checks, not OCR accuracy or universal image scores.

The versioned results JSON records warm desktop timings including buffer copies:
3.15MP crease, Web36.6->172.4ms and custom WASM19.9->144.3ms. The old path left
this shadow uncorrected. For the smaller ordinary shaded page, Web21.1->26.7ms;
extra restoration has a real CPU cost. V7WASM is680943bytes versus1704892forv6
(about60% less browser binary download). It excludes the alternative backend,
not the shared OpenCV primitives used by the custom/native infrastructure.
48MP reserved WASM memory is282918912bytes under335544320; this excludes browser
codecs/canvas/JS heaps and is not peak whole-device RAM. Physical phone heat,
power, universal quality and dense dewarping remain unverified.

Recipe/engine/cache identifiers and the immutable WASM asset prefix advance.
Keep the required `assetBase` injection into the lazy loader and the production
worker-module cycle guard; do not reintroduce a runtime back-import of its entry.
