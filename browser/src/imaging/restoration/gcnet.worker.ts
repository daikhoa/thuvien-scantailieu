import { predictIllumination } from './gcnet-inference';
import type { ShadowField } from './shadow-field';
import { shadowFailureCode } from './shadow-runtime-error';
const scope = self as unknown as {
  onmessage:
    ((event: MessageEvent<{ type: string; id: number; sample: ShadowField }>) => void) | null;
  postMessage(value: unknown, transfer: Transferable[]): void;
};
scope.onmessage = (event) => {
  const { id, sample } = event.data;
  void predictIllumination(sample).then(
    (field) => {
      scope.postMessage({ type: 'result', id, field }, [field.data.buffer]);
    },
    (error: unknown) => {
      scope.postMessage({ type: 'error', id, code: shadowFailureCode(error, 'runtime') }, []);
    },
  );
};
