import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";

export type WorkerWorkspaceOperationCoordinator = {
  run<T>(environmentId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
};

/** Serializes local workspace mutation and forced teardown per environment. */
export function createWorkerWorkspaceOperationCoordinator(): WorkerWorkspaceOperationCoordinator {
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(
      environmentId: string,
      operation: () => Promise<T>,
      signal?: AbortSignal,
    ): Promise<T> {
      const previous = tails.get(environmentId) ?? Promise.resolve();
      // Only queued work can detach. Once entered, mutation owns its settlement.
      const result = racePromiseWithAbortSignal(previous, signal).then(() => {
        signal?.throwIfAborted();
        return operation();
      });
      // A cancelled waiter must not let later work overtake the preceding writer.
      const tail = previous
        .then(() => result)
        .then(
          () => undefined,
          () => undefined,
        );
      tails.set(environmentId, tail);
      void tail.finally(() => {
        if (tails.get(environmentId) === tail) {
          tails.delete(environmentId);
        }
      });
      return await result;
    },
  };
}
