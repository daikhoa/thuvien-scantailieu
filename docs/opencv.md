**Status:** browser comparison removed in WASMv7. This document describes the
retained optional native Windows API, preserved for compatibility. It is not
selected or shipped as an alternative processor in the new browser target.

# OpenCV raster candidate (opt-in)

The existing API and defaults keep the custom raster implementation. To choose
OpenCV, use the additive C entry below with the newly built DLL and header.
ABI1 struct layouts are unchanged; old ABI1 DLLs do not export the new function.

```c
ds_page_options options;
ds_page_options_init(&options);
options.crop_mode = DS_CROP_FULL_FRAME;
options.filter = DS_FILTER_ENHANCED_COLOR;
uint32_t page_index;
ds_status status = ds_document_add_image_opencv(document, source, &options,
    DS_OPENCV_BALANCED, &page_index);
/* Check status before reading page_index or exporting. */
```

Original and Enhanced are supported. Auto/gray/black-white and unknown presets
return DS_INVALID_ARGUMENT without adding a page. Crop auto/manual/full-frame,
rotation, JPEG quality, PDF, ownership and synchronous-call rules are unchanged.
Auto crop uses the existing corner model; manual/full-frame need no model.
OpenCV Enhanced does not invoke defect classification. Creating an engine with
a model directory still loads the existing models; this is not lazy model loading.

Adaptive Enhanced v2 (2026-10-25): perspective warp is unchanged. OpenCV
BGR-to-gray produces luminance; a <=256px nearest sample estimates median
residual noise. On neutral uneven/dim paper, <=512px closing + Gaussian estimates
illumination, and divide corrects the full-resolution image with lift capped2x.
Colored/very dark pages are protected. CLAHE tile count adapts to dimensions;
noise reduces clip/blend and disables sharpening. Dark detail uses sigma.85,
noise floor1 and cap12 before scaling. Flat/blank-noisy pages are preserved.

| Preset | CLAHE clip | Maximum blend | Dark detail scale |
| --- | ---: | ---: | ---: |
| DS_OPENCV_GENTLE | 1.4 | .45 | .25 |
| DS_OPENCV_BALANCED | 2.0 | .70 | .45 |
| DS_OPENCV_TEXT | 2.8 | .85 | .60 |

Blend is reduced by 1/(1+.3*noise), .45 for color and .4 for periodic texture;
noise>=2 caps CLAHE at1.2 and skips sharpening. The final same-channel RGB delta
uses one C++ policy pass with pixel headroom limits, replacing measured slower
OpenCV split/merge temporaries. It preserves encoded RGB channel differences
exactly and creates no newly clipped channels. The filters/warp are OpenCV;
parameter selection and output guards remain domain policy. No global OpenCV
thread setting changes. This is not colorimetric ICC/HDR handling or deblurring.
Working-buffer preflight uses 20 bytes/output pixel for this path (custom remains
8), apart from source/model/codec memory. Cancellation is checked between OpenCV
operations, not inside one running operation; partial pages are never appended.

Same source is compiled in wasm/ with private export ds_wasm_process_opencv.
Custom and OpenCV browser runners use v3, common decode/PNG/PDF and max3000 side.
No native codec, PDF writer, ONNX inference or model files are in that module.
The bridge is non-reentrant; one instance per browser worker. Terminating the
worker cancels and releases it. Browser timings are not native DLL timings.

Verification: six CTest suites pass, including new identity/skew/invalid-input,
flat/color/text, cancellation/reset, C API append and JPEG/PDF tests. Existing
23-case custom pixel parity remains intact. WASM checks retain 12 custom cases
and add36 OpenCV cases. 19 quality samples x4 profiles with shared annotated crops
show no new clipped enhancement channels. Conservative OpenCV helps faint marks
in the synthetic set; custom has stronger contrast on some other pages. No OCR
accuracy, Android/iPhone runtime, physical heat or power measurements yet.
Full sample report and repro are in sibling camscanner2/docs/benchmarks/opencv-v1.md.

V2 verification: native6 CTest suites include shadow correction (failed before),
blank noise, exact channel differences and thin1x3000/3000x1 cases. Web527 tests,
12 custom/36 OpenCV real WASM cases,14 new synthetic fixtures and15 licensed real
frames passed their contracts. On desktop Node WASM, six alternating warm runs
at3000x2250 measured372.2ms before vs291.4ms after; this excludes decode/PNG/PDF
and is not native DLL or phone timing. Reserved linear memory112.4->104.8MiB is
not peak process RAM. WASM increases1,493,157->1,804,535 bytes uncompressed.
Detailed parameters/ground-truth masks/tradeoffs/provenance and reproduction are
in sibling camscanner2/docs/opencv-tuning-v2.md. Physical phone heat/power and
OCR recognition accuracy remain unmeasured. No universal best settings claim.

2026-10-25: browser runners now use versioned WASMv4. Both raster backends use an exact full-frame/same-size copy shortcut after validation. OpenCV enhancement remains adaptive v2. The custom Enhanced faint-ink policy was updated independently; see docs/verification.md. Previous v1/v2 figures above describe their historical verification, not the current package.
