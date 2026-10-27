import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(fileURLToPath(import.meta.url));
const metadata = JSON.parse(readFileSync(join(root, 'assets.json'), 'utf8'));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
/** Serve/copy the library's own pinned resources; no model setup in the consuming app. */
export function docscanAssets() {
  const directory = join(root, 'assets');
  const assets = files(directory).map((path) => ({
    name: relative(directory, path).replaceAll('\\', '/'),
    bytes: readFileSync(path),
  }));
  return {
    name: 'docscan-owned-assets',
    config: () => ({
      optimizeDeps: { exclude: ['@docscan/browser'] },
      worker: {
        format: 'es',
        rollupOptions: {
          output: {
            manualChunks(id) {
              const path = id.replaceAll('\\', '/');
              if (path.endsWith('/shadow-runtime-error.ts')) return 'shadow-runtime-contract';
              if (path.endsWith('/scanic-ml-assets.ts')) return 'scanic-ml-config';
              if (path.endsWith('/docscan-assets.ts')) return 'docscan-config';
              if (path.endsWith('/sdk-assets.ts')) return 'docscan-sdk-config';
            },
          },
        },
      },
    }),
    configureServer(server) {
      const byName = new Map(assets.map((asset) => [asset.name, asset.bytes]));
      server.middlewares.use(metadata.base.slice(0, -1), (request, response, next) => {
        const name = new URL(request.url ?? '/', 'http://localhost').pathname.slice(1);
        const bytes = byName.get(name);
        if (!bytes) return next();
        response.setHeader(
          'Content-Type',
          name.endsWith('.wasm')
            ? 'application/wasm'
            : name.endsWith('.mjs')
              ? 'text/javascript; charset=utf-8'
              : 'application/octet-stream',
        );
        response.setHeader('Cache-Control', 'no-store');
        response.end(bytes);
      });
    },
    generateBundle() {
      for (const asset of assets)
        this.emitFile({
          type: 'asset',
          fileName: metadata.base.slice(1) + asset.name,
          source: asset.bytes,
        });
    },
  };
}
