# Native document processing library

## Scope
A separate C++17 library with a versioned C ABI for in-process callers. Input encoded image bytes (or an explicit source-coordinate crop), output processed JPEG pages and an image-only PDF. Web at ../camscanner2 remains unchanged and is the behavioral reference, not a runtime dependency. No HTTP server, bot, OCR, account or persistence layer. Native Windows x64 is verified here; portable CMake build supports other native platforms with matching dependencies. Browser/WASM integration is a later task.

## Pipeline and quality
Reuse the web corner model (DocCornerNet LEAN ORT) and defect classifier with native ONNX Runtime. Retain ML-only automatic detection, explicit manual/full-frame crop, no destructive guessed classical crop. Reuse source coordinates, bilinear projective sampling, adaptive color-safe enhancement, optional enhanced color, grayscale and Sauvola black/white. One final JPEG encode per page, PDF embeds that exact JPEG. Default final long side 3000 for a measurable baseline; configurable high-quality side up to 8192 without upscaling. Analyze a reduced crop separately, classifier input remains 224x224. No heavy generative dewarp/deblur.

## Interface and resources
Opaque document handle with create/add-page/inspect-page/finalize-PDF/destroy lifecycle. Stable numeric errors and flags, plain fixed-width C structures with size/version, library-owned outputs valid until document destruction and explicit returned PDF buffer release. Never leak C++ objects/exceptions across ABI. Sequential page processing per handle, no hidden thread pools; independent handles may run concurrently. Persist only encoded processed pages, not source RGBA. Bound encoded bytes, decoded dimensions, output pixels, cumulative document output and pages before allocation. Check cancellation at safe stages; synchronous calls may execute on a caller-owned worker thread. No network at runtime or logging image data.

## Dependencies
OpenCV core/imgproc/imgcodecs only for decoding/encoding, resampling and selected pixel primitives; ONNX Runtime CPU for the two existing local models. PDF writer is a small image-only PDF subset with JPEG DCT streams, page trees and binary xref offsets, verified by an independent PDF parser/rasterizer. No new general PDF framework, GUI modules, CUDA, web server or OCR runtime. Optional HEIF codec must be explicit and documented; never claim unsupported formats succeed.

## Verification
Tests first: invalid ABI/input and bounds, geometry/sample equivalence with web-generated fixtures, filters on color/faint-text/shadow/no-document fixtures, one/many-page PDF order and embedded JPEG identity, model-backed document/no-document detection, cancellation, reuse, repeated resource cleanup and Python ctypes in-process integration. Use deterministic synthetic fixtures plus pinned existing model/benchmark assets. Release build and native CTest are required. Benchmark stage timings and RSS snapshots on this machine; no unmeasured claim about phone temperature or identical native JPEG bytes.

## Implementation slices
1. Portable build, native dependencies, C ABI/lifecycle and first failing tests.
2. Validated decoding, geometry, filters and JPEG page processing with parity fixtures.
3. ML detection/classification and adaptive policy, with explicit capability reporting.
4. PDF, Python example, end-to-end tests, benchmarks, install/package and documentation.
