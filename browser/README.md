# Docscan browser SDK

Install this package in the consuming browser project. It includes the C++
WebAssembly engine, detector/classifier/shadow models and the required runtimes.
No React or remote processing service is required. The current HEIC/HEIF fallback still expects the host to serve `/vendor/heif/decoder-1.6.6-primary-v1.js` (the scanner website supplies this CSP-compatible libheif decoder). JPEG/PNG paths do not need that extra host asset.

For Vite, add `docscanAssets()` from `@docscan/browser/vite` to the plugin list.
The plugin serves/packages the SDK's own pinned model/runtime assets. Then:

```ts
import { createDocscan } from '@docscan/browser';

const scanner = createDocscan();
try {
  const page = await scanner.process(file); // auto detect, crop, shadow correction, enhance
  const image = page.image;                // Blob + dimensions
  const pdf = await scanner.createPdf([page]);
} finally {
  await scanner.dispose();
}
```

`process` also accepts captured RGBA frames. Options include signal, crop, filter,
rotation and an onOriginal callback. `render(original, recipe)` reapplies edits
without requiring the caller to run models. All image work stays on the device.
The default is selective enhanced-color with honest model failure metadata.

For existing live-camera UIs, `createScannerEngine()` supplies detection and
render operations with the same owned runtime. `internal/*` exports are an
unstable compatibility/testing seam, not the integration API.

This source package targets TypeScript/ESM browser bundlers with worker URL
support (the supplied Vite adapter is tested). Other build systems need their
equivalent static-asset/worker integration once; no scanning algorithm is rewritten.
Native systems use the sibling C ABI package and language facade, not browser workers.

After editing source or C++ in the library, rebuild/package it and update the
consumer's dependency. A deployed website must be rebuilt/published to receive it.
Models remain external files bundled with the package; they are not embedded in DLL code.
