# Current target: WASM v8

V8 adds the native adaptive-enhancement kernel and private `_ds_wasm_enhance_owned` export. Browser ORT supplies a bounded BGR illumination field; C++ owns sampling, paper/color analysis and pixel application. No ORT session or codec is linked into WASM. See [adaptive-enhancement.md](adaptive-enhancement.md). V7 and the notes below are retained historical contracts.

# Browser raster target

Current browser target: **v7, Web/custom C++ only**. The alternative OpenCV
processor and its private WASM exports are excluded. Public Windows C ABI1
and the optional native OpenCV entrypoint remain compatible. See
`paper-restoration-v2.md` for policy, checks and measured costs.

The sibling camscanner2 web project now has an opt-in comparison at `?compare=1`.
The existing Windows C ABI remains ABI1 and the normal web scanner is unchanged.

`src/pixels.hpp` declares model-independent pixel types and operations. Geometry,
quality measurement and filters compile from the same source into both targets;
`src/quality.cpp` was extracted from models.cpp without changing its algorithm.
The Windows target retains OpenCV/ORT/codec/PDF behavior and dependencies.

`wasm/bridge.cpp` is a private, non-reentrant browser adapter, not a replacement
public C ABI. Each browser worker owns one module instance. It accepts opaque RGBA
already composited on white by the shared browser decoder, clockwise source-edge
corners and Original/Enhanced only. It returns opaque RGBA, long side <=3000.
Source size is bounded to 50 million pixels, 16384 per side; WASM memory grows up
to 768 MiB. These are ceilings, not guarantees that a phone can allocate them.
Failures never silently switch implementation. Worker termination cancels a run
and releases the module. The bridge is not safe for concurrent calls.

No model inference, native JPEG codec, encoded-image parser or native PDF writer
is compiled into this target. The comparison uses common browser decode, PNG and
PDF output, deliberately isolating perspective and filter quality/performance.
Timing this target cannot establish performance of the Windows DLL or native
Android/iOS builds. UI frame gaps and WASM reserved memory do not measure total
CPU, process RAM, heat or battery energy. Physical devices need separate tools.

Build from the sibling web root with its scripts/build-docscan-wasm.ps1, providing
LibraryRoot, SdkRoot, Cmake and Ninja as needed. Verified toolchain: official
Emscripten 6.0.13 and the existing pinned OpenCV source commit
ea8e60798e0319ccbe902f7994153b574f639809. The web stores the generated module,
WASM, license notices and a source SHA-256 manifest under public/docscan-wasm/v3.
Run node scripts/test-docscan-wasm.mjs from the web root for real WASM/web pixel
parity and invalid-request release checks. Native CTest remains required too.

OpenCV candidate: see opencv.md. The existing private custom export is retained;
ds_wasm_process_opencv adds a separate preset argument (0 gentle, 1 balanced,
2 text). Both exports live in the same v3 module. Original isolates warp.
The new OpenCV filter supports Enhanced only and does not run AI. V1 assets
remain available in the sibling web; its normal scanner is unchanged.

Update2026-10-25: OpenCV Enhanced now uses adaptive neutral-paper illumination,
noise protection and bounded RGB delta (see opencv.md); both private exports
share the same v3 module. V1/v2 assets are frozen in the web. Native public ABI,
custom kernels, decoder and codec/output resolution policies are unchanged.

## Browser memory fix v5 — 2026-10-25

Current browser module is public/docscan-wasm/v5 in the sibling web. Two private exports ds_wasm_process_owned and ds_wasm_process_opencv_owned consume their mutable RGBA staging buffer: RGB is compacted into BGR in place and viewed by a non-owning Mat. Callers must refill the input before each call and free their staging pointer afterward. Existing read-only exports retain their behavior. The new path removes a full3-byte/source-pixel BGR allocation; no resampling/filter/codec change. OpenCV StsNoMem maps to DS_OUT_OF_MEMORY. Public native C ABI and DLL are unchanged.

Under a synthetic320MiB growth cap, the oldv4 bridge fails48MP with generic status7; bothv5 owned paths succeed3000x2250 at283770880 reserved bytes. A210MiB cap returns explicit status8/no output.16custom/48OpenCV cases also pass exact legacy/owned output parity. See sibling docs/wasm-memory-v5.md for reproduction and limitations. Actual iPhone/Android error confirmation remains required.
