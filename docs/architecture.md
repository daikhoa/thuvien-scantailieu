# Architecture and C ABI v1

## Boundaries

`include/docscan/docscan.h` is the only public header. `src/api.cpp` validates ABI/configuration, owns opaque handles, serializes document mutations and maps exceptions to status codes. `pipeline.cpp` orchestrates bounded decode → detection → reduced analysis → final warp → filter → rotation → JPEG. `models.cpp` owns ONNX sessions and adaptive policy. `geometry.cpp` owns homography, output aspect and bilinear sampling. `filters.cpp`/`lab.hpp` own pixel transformations. `pdf.cpp` writes a limited image-only PDF 1.4 with binary-safe xref offsets.

No web source or node_modules are runtime/build dependencies. Committed web-generated pixel fixtures let tests run independently. `scripts/generate-web-goldens.mjs` is only for deliberately regenerating these fixtures; it reads a separately supplied web checkout without changing it.

## Pipeline

New page options default to **ENHANCED_COLOR**; callers can explicitly choose AUTO, ORIGINAL, GRAYSCALE or BLACK_WHITE. Python options inherit the native default unless `filter=` is supplied. Automatic corner detection remains enabled independently of the appearance filter.

1. Validate encoded size and JPEG SOF / PNG IHDR / WebP dimensions before codec allocation. Reject unsupported formats and malformed headers; cap input pixels and estimate decode workspace.
2. OpenCV imgcodecs decodes native source resolution. Normalize alpha onto white, grayscale to BGR, 16-bit SDR PNG to 8-bit (`value/257`), EXIF 1–8 to upright coordinates. Source dimensions and manual normalized corners refer to this **upright image**, not encoded axes. Output JPEG has upright pixels without a stale orientation tag.
3. AUTO: CPU ONNX Runtime runs the existing float32 DocCornerNet at 224×224, NHWC RGB/ImageNet normalization. Still photos additionally use bounded C++ edge refinement and verified recovery (see `corner-refinement.md`); live browser preview does not run this recovery loop. Actual pinned model input is named `input` (upstream card says `image`); outputs `coords`/`score_logit`, TL/TR/BR/BL and sigmoid score ≥0.5. Invalid/tiny/non-convex detections keep the whole image and warn. MANUAL validates caller TL/TR/BR/BL; FULL_FRAME bypasses detection.
4. Warp a reduced crop (long side ≤720 by default) for measured luminance/illumination/detail/color metrics. AUTO/GRAY/BW also run the existing classifier at 224×224 NCHW, input `image`, output `logits` (seven labels). Enhanced color v2 skips this reduced warp and the classifier; it measures the final warped pixels instead. ORIGINAL skips all appearance analysis.
5. Compute conservative strengths from classifier scores **and** pixel evidence. Preserve the web thresholds, color protection and warning policy. Classifier failure visibly sets `DS_WARN_CLASSIFIER_UNAVAILABLE` and uses measured conservative adjustments with zero classifier scores. This does not silently claim ML success.
6. Warp original decoded pixels once to the final selected resolution using the web's pixel-center homography, aspect estimate and bilinear sampling. Release source before appearance filtering. No chain of thumbnail encodes.
7. Enhanced color v2 applies the shared RGB curve plus capped ink-edge detail using three luminance row buffers. It skips crisp/periodic content, isolated specks and flat rows; there is no full-frame detail copy or new ML model. Same-channel deltas preserve color differences and avoid new clipped channels/bright paper halos. Other presets apply the selected filter in place. D65 Lab lookup/color rolloff and bounded 8×8 CLAHE follow web math. Shadows use a small interpolated illumination grid. Local detail/Sauvola use O(width) rolling integer column sums plus one grayscale plane; no full-frame mean/variance matrices. Skip AUTO local detail when sharpening strength is zero.
8. Apply explicit clockwise rotation 0/90/180/270 and encode JPEG once, quality 96/4:4:4 by default. Store only this encoded page and metadata in the document.
9. PDF embeds those **same JPEG bytes**, one image per page, `/DCTDecode /DeviceRGB`, natural size at 300 pixels/inch. This is not OCR/searchable PDF and adds no recognition service. Export is repeatable and doesn't consume the document.

Native resize/codec behavior can differ from browser canvas/JPEG, so full ML scores/final encoded bytes are not promised identical to the web. Pixel kernels are checked separately against web-generated golden pixels.

## Ownership and threading contract

- Buffers passed as `ds_bytes` are borrowed, readable for the entire synchronous `add_image` call; the library does not retain them afterward. Host memory must be valid for the declared byte count.
- `model_directory` is a UTF-8 filesystem path read during `engine_create`; its string is not retained. Null/empty means explicit no-model mode. Models are deployment assets trusted by the application, not arbitrary end-user uploads.
- Every create/export function sets output handles null before failure. Failed add returns `UINT32_MAX` index and appends nothing. Every `ds_status` must be inspected.
- Runtime initialization checks ONNX C API availability before constructing an environment. An incompatible host runtime returns `DS_MODEL_UNAVAILABLE` instead of dereferencing a null API table. On Windows deploy all package DLLs beside the host executable; an already-loaded incompatible runtime cannot safely be replaced within that process.
- Each document owns stable individually allocated pages. `get_page` returns read-only borrowed info and JPEG valid until document destruction, including across later successful adds. Never free these pointers using host allocators.
- A PDF `ds_buffer` is independent of engine/document lifetime; release with **the same DLL's** `ds_buffer_destroy`, never `free`/`delete` in the host.
- Documents retain a shared engine internally, so destroying the engine handle does not invalidate existing documents. A new document needs a live engine handle. Reuse the engine for many documents instead of recreating model sessions per page/job.
- One mutation at a time per document. Overlapping add/PDF/reset returns `DS_BUSY`; count/get_page wait for a current mutation. `cancel` is thread-safe and sets a sticky flag; `reset_cancel` is explicit. Do not destroy any handle while a call using that handle is active, including cancel/read calls.
- Independent documents may run concurrently; inference on a shared engine is serialized. The pinned OpenCV build disables its worker pool; ONNX is sequential with one intra/inter thread and spinning disabled. The host owns scheduling and bounds the number of engines/documents; there is no background job queue or network call.
- Cancellation is cooperative at stage/row boundaries. A codec call or current ONNX call completes before cancellation is observed; no promise of an immediate interrupt or timeout. The host can use process isolation if hard resource/time isolation is required.
- Call `ds_abi_version()` before passing structs or invoking their initialization functions. Bindings must reject a different ABI version before the DLL writes into host-allocated structures.
- ABI uses normal platform alignment and fixed-width fields; no custom packed layout, no C++ exceptions/types across FFI. This binary is x64. All builds of a v1 struct must use its declared size/version. Invalid pointers and use-after-destroy are caller errors, as with other C libraries.

## Resource contract

`max_input_bytes`, `max_input_pixels`, `max_pages`, `max_document_bytes`, `working_memory_bytes` are per-engine configuration. Final encoded pages are bounded cumulatively; PDF limit also includes PDF structure. Pixel workspace is conservatively estimated before allocation, not a process allocator quota: codec scratch, ORT arenas/models, host input, retained JPEG pages and separately owned PDF/caller copies are additional. A failed add/export leaves existing pages intact; no automatic reduction of requested quality to fit a budget. Increase limits explicitly if the host can afford it.

All JPEG pages and PDF are in memory. Maximum hard configurable caps: 1 GiB encoded input/document, 256 MP source, 16 GiB workspace, 10000 pages; every source side ≤16384 and selected output side ≤8192. Defaults are intentionally smaller. Source decoding remains full resolution because prematurely reducing a 48MP photograph can discard small text. Color input contract is sRGB SDR; no ICC transform or HDR tonemapping is currently implemented.
