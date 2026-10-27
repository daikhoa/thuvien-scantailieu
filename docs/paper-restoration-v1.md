# Color-aware paper restoration

User authorized improving Web/custom C++/OpenCV together, across document types,
specifically protecting genuine dark colors from being treated as shadow. Keep
original files, output dimensions/codecs, public C ABI, comparison opt-in and
the worker module-map fix. No new dependencies or generative content.

Implemented in small tested slices: bounded paper/ink evidence -> shared policy
in Web/native -> integrate into Enhanced in both native backends -> fixed-sample
quality/memory/time checks -> publish existing public Site. Existing perspective
geometry is preserved; do not ship an unvalidated warp just for one photograph.

The policy must require multiple paper-like regions, local dark-stroke evidence,
a neutral bright reference and varying illumination. Colored paper/backgrounds,
solid dark panels, photographs, inverse text, flat fields and uncertain areas
must not be whitened merely because they are dark. Compare ink/background
chromaticity, spatial context and texture, not just whole-image brightness.
One image cannot uniquely distinguish every printed gradient from illumination;
prefer no correction when evidence is ambiguous. Keep alpha/black/highlights.

Use a bounded analysis grid and one in-place original-resolution pass, not
multiple full-size float RGB images. Estimate correction on sampled pixels,
keep source pixels for rendering; no resolution downgrade. Custom and Web
must retain strict pixel parity; native OpenCV uses the same paper confidence
policy but keeps its own contrast/detail implementation. Separate correction
strength from noise/detail protection. No native model/inference/API changes.

Acceptance fixtures include smooth/creased shadows, neutral and warm lighting,
faint ink, dark colored logos, pastel paper, interior gray/colored panels with
text, grayscale/photos, inverse text, noisy and uniform fields, transparent
input and thin dimensions. Check paper uniformity, ink contrast, protected RGB,
clipping, alpha, deterministic output and size. Use development/holdout fixtures
and licensed real frames; user photo stays private/test-only. Do not change old
goldens silently: new behavior is tested independently and versioned explicitly.

Checks: focused Vitest, full `npm test -- --exclude '**/.tmp-*/**' --maxWorkers 2`,
`npm run lint -- --ignore-pattern '**/.tmp-*/**'`, `npm run build` (includes worker
cycle guard), native CTest, real WASM parity and320MiB allocation-budget test.
Measure before/after on fixed inputs. Preserve WASMv1..v5; new raster targetv6.
Physical phone heat/power and universal CamScanner parity cannot be asserted.

## Implemented policy

Enhanced measures the original raster, restores supported paper, then applies
its existing RGB contrast/ink-detail curve using the original profile. That
keeps protected artwork on the previous global curve. OpenCV replaces its old
whole-image paper normalizer with this same policy before CLAHE/detail; it does
not apply both normalizers. CLAHE/noise protection remains independent.

The grid has at most24x24 cells and64 luminance bins; sampled analysis is at
most about512x512 pixels. Background p85, spread p85-p60 <=20, thin dark strokes
and paper/ink chromaticity establish evidence. Multiple bright references with
<=6% background chroma are required. Connected support cannot cross abrupt
brightness boundaries into printed panels; dark border tiles are not seeds.
Color foreground and solid neutral fills are excluded in the render pass.
Bilinear confidence avoids rectangular mask seams. Original luminance neighbors
are retained in a ring of at most17 rows; no full-size float background is kept.
The JS kernel also precomputes column coordinates and grid-row interpolation,
avoiding per-pixel closures. Cancellation remains checked in native passes.

These are conservative heuristics, not semantic understanding: neutral printed
gradients can be indistinguishable from illumination in a single photo. Very
small rasters (<192px on either side), uniformly colored/uncertain pages and
unsupported regions retain the previous appearance. True dense page dewarping,
OCR and generative reconstruction are not part of this release; perspective
correction still uses four corners. Sharp folds/curl can remain visible.

## Verification and reproduction

- `npx vitest run src/imaging/rendering/paper-restoration.test.ts --maxWorkers 2`
  covers shadow, warm light, colored/pastel paper, dark logos, gray and colored
  panels, border sidebar, photographs, inverse/noisy/flat input, alpha and3MP.
- `node scripts/verify-paper-restoration.mjs`: eleven exact-reference fixtures,
  Web/custom WASM raw-pixel parity, native cleanup repeated20times per backend,
  full-resolution parity/timing, and versioned `paper-restoration-v1-results.json`.
  Generated policy PPMs are copied to the sibling native `tests/golden/paper-v1`
  for the independent `paper_contract` CTest (including cancellation).
- `node scripts/audit-paper-corpus.mjs .tmp-opencv-tune/samples/index.json docs/paper-restoration-v1-holdout.json`
  checks the existing14 development/holdout fixtures, prepared by
  `scripts/prepare-opencv-tuning.py`. Four shadow/uneven cases improve paper
  p90-p10 spread:61->15,45->1,100->5,45->1. The other ten retain their pixels.
- The same audit on `.tmp-quality/samples/index.json`, prepared by
  `scripts/prepare-quality-samples.py`, leaves all19 controls (including15
  licensed SmartDoc frames) unchanged at the additional policy stage. This is
  abstention/safety evidence, not an unseen-document quality score.
- User-supplied shadow/fold photo inspected privately with approximate manual
  paper corners; never added to source or publication. Visual improvement in
  background/legibility is qualitative, with residual fold/curl still visible.

Desktop Node warm medians for3.15MP: Web37.6ms before ->174.8ms after,
custom WASM154.2ms, OpenCV WASM231.7ms (processing+copies, excluding browser
codecs/startup). The extra restoration has a real CPU cost; this is a quality
change, not a speedup claim. The bounded additional grid/row workspace avoids
full-resolution float intermediates. On the48MP input allocation-budget test,
both backends succeed under320MiB with283,639,808bytes reserved WASM memory;
a deliberately tighter budget returns status8 with no output. This is not peak
whole-browser RAM or a physical phone thermal/power measurement.

OldWASMv1-v5 remain immutable; v6 source hashes are in its build manifest.
C ABI, DLL name, original-mode output and JPEG/PDF settings stay compatible.
The default recipe and engine/cache version advance to prevent stale rendering.
