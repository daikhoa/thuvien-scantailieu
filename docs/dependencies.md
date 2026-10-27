# Pinned dependencies and provenance

No dependencies are downloaded at runtime. Bootstrap writes development-only data under `.deps/`; distributing the library does not require shipping that directory.

| Component | Revision / source | Integrity / role |
|---|---|---|
| OpenCV | 4.14.0, commit `0654a42e19215ef25b1d367d822f3c630447e7c7`, official `opencv/opencv` repository | Source archive SHA-256 `7a75663094ebd50bf212928423a24394e29d751db878044ad015ba28546a59db`; core/imgproc/imgcodecs only |
| ONNX Runtime | Official `microsoft/onnxruntime` Windows x64 1.27.0 CPU release | ZIP SHA-256 `c5c81710938e68079ff1a192b04897faabe4b43830d48f39f27ecd4e16138bfc`; native CPU inference |
| DocCornerNet LEAN | Copied unchanged from web Scanic-ML 0.2.0 asset | SHA-256 `732eb8d02d83cc63efb3f9467f01e0c458205a89b2547de3870bc6db1a80c8b3` |
| Document defects | Existing project model `document-defects@cord-v2-bootstrap-2026-10-18` | SHA-256 `9d42dd1121652dbc68c21b0cac13e40f3e7e57a04761ed380c7c99f2e5a6e4f7` |

Official download URLs and hashes are in `scripts/bootstrap-windows.ps1`. Sources: https://github.com/opencv/opencv/tree/0654a42e19215ef25b1d367d822f3c630447e7c7 and https://github.com/microsoft/onnxruntime/releases/tag/v1.27.0.

OpenCV build disables GUI, video stacks, OpenCL, IPP, ITT and its internal threading. SSE2 baseline with SSE4.1/AVX2 dispatch supports ordinary x64 CPUs. Bundled JPEG/PNG/WebP codecs are used; this environment has no NASM, so libjpeg-turbo assembly SIMD is not enabled. This is a known further optimization opportunity, not a reason to change JPEG quality. ONNX Runtime official CPU distribution includes its own MLAS optimization; no CUDA/GPU runtime is packaged.

OpenCV's Apache-2.0 license and bundled third-party notices are in `licenses/`; ONNX Runtime MIT and third-party notices are included there too. `models/Scanic-LICENSE.txt` and upstream model card are preserved. The upstream card describes its Web runtime and contains an input-name mismatch: the actual native-pinned corner asset uses `input`; native model signatures are validated and tested.

The defect classifier is the existing project bootstrap model, not a newly trained or independently certified model. Labels: shadow, curved, blur, moire, finger, lowContrast, colorDocument. Native reuse does not establish general real-phone classification accuracy. Model improvements should be versioned and assessed against labeled images separately.

Test fixtures are not runtime assets. Synthetic fixtures copied from the web are CC0 per `tests/fixtures/synthetic-manifest.json`. Fifteen SmartDoc preview frames retain CC-BY-4.0 attribution and manifests in `tests/fixtures/smartdoc15/README.md`. Golden pixel fixtures are deterministically generated from the project's own web algorithms; source checkout used for initial generation was `d708fa9cf70c8eb451d672334d34e33560c86aa6`.

This work does not choose a new license for the owner's application/library source. Existing third-party license terms remain applicable when redistributing their components.
