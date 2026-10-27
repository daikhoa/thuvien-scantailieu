import type { RenderPageRequest } from '../contracts/scanner-engine';
import { ScannerEngineError } from '../engines/scanner-engine-error';

const sourceDigests = new WeakMap<Blob, Promise<string>>();

function abortError(): Error {
  const error = new Error('Scanner operation cancelled.');
  error.name = 'AbortError';
  return error;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function subtleCrypto(): SubtleCrypto {
  try {
    const candidate: unknown = globalThis.crypto.subtle;
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      !('digest' in candidate) ||
      typeof candidate.digest !== 'function'
    ) {
      throw new ScannerEngineError('unavailable');
    }
    return candidate as SubtleCrypto;
  } catch (error) {
    if (error instanceof ScannerEngineError) throw error;
    throw new ScannerEngineError('unavailable');
  }
}

async function sha256(bytes: BufferSource, signal: AbortSignal): Promise<string> {
  checkAbort(signal);
  const digest = await subtleCrypto().digest('SHA-256', bytes);
  checkAbort(signal);
  return bytesToHex(digest);
}

async function sourceDigest(blob: Blob, signal: AbortSignal): Promise<string> {
  checkAbort(signal);
  let pending = sourceDigests.get(blob);
  if (pending === undefined) {
    pending = blob.arrayBuffer().then(async (bytes) => {
      return bytesToHex(await subtleCrypto().digest('SHA-256', bytes));
    });
    sourceDigests.set(blob, pending);
    pending.catch(() => sourceDigests.delete(blob));
  }
  const digest = await pending;
  checkAbort(signal);
  return digest;
}

function canonicalRequest(request: RenderPageRequest, imageDigest: string, engineVersion: string) {
  const parameters = Object.fromEntries(
    Object.entries(request.recipe.filter.parameters).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
  const crop =
    request.recipe.crop.kind === 'full-frame'
      ? { kind: 'full-frame' as const }
      : {
          kind: 'document' as const,
          corners: request.recipe.crop.corners.map(({ x, y }) => ({ x, y })),
        };
  const dewarp =
    request.recipe.dewarp.mode === 'perspective-only'
      ? { mode: 'perspective-only' as const }
      : {
          mode: 'auto' as const,
          policyVersion: request.recipe.dewarp.policyVersion,
        };
  return {
    engineVersion,
    source: {
      sha256: imageDigest,
      width: request.original.dimensions.width,
      height: request.original.dimensions.height,
    },
    orientation: request.orientation,
    maximumOutputLongSide: request.maximumOutputLongSide ?? null,
    recipe: {
      version: request.recipe.version,
      crop,
      rotation: request.recipe.rotation,
      dewarp,
      filter: {
        mode: request.recipe.filter.mode,
        presetVersion: request.recipe.filter.presetVersion,
        parameters,
      },
    },
  };
}

/** Content-addressed key for an immutable source, explicit recipe and engine implementation. */
export async function createRenderRecipeKey(
  request: RenderPageRequest,
  engineVersion: string,
  signal: AbortSignal,
): Promise<string> {
  checkAbort(signal);
  const imageDigest = await sourceDigest(request.original.blob, signal);
  const canonical = JSON.stringify(canonicalRequest(request, imageDigest, engineVersion));
  const digest = await sha256(new TextEncoder().encode(canonical), signal);
  return `sha256:${digest}`;
}
