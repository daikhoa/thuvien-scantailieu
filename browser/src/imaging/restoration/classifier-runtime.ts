import type { InferenceSession } from 'onnxruntime-web';

type Session = Pick<InferenceSession, 'run' | 'release'>;
type Providers = InferenceSession.ExecutionProviderConfig[];

/** A failed GPU session is retired permanently; retry once using a fresh WASM session. */
export function createClassifierRuntime(
  createSession: (providers: Providers) => Promise<Session>,
  preferWebGpu: boolean,
) {
  let wasmOnly = !preferWebGpu;
  let pending: Promise<Session> | undefined;
  const session = () => (pending ??= createSession(wasmOnly ? ['wasm'] : ['webgpu', 'wasm']));
  const discard = async () => {
    const owned = pending;
    pending = undefined;
    if (owned !== undefined) {
      let value: Session;
      try {
        value = await owned;
      } catch {
        return;
      }
      await value.release();
    }
  };
  return {
    async run(feeds: InferenceSession.FeedsType): Promise<InferenceSession.ReturnType> {
      try {
        return await (await session()).run(feeds);
      } catch (error) {
        await discard();
        if (wasmOnly) throw error;
        wasmOnly = true;
        try {
          return await (await session()).run(feeds);
        } catch (retryError) {
          await discard();
          throw retryError;
        }
      }
    },
  };
}
