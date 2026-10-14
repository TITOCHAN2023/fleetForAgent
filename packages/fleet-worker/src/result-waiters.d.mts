/** Ephemeral waits; no authority or execution state. */
export class ResultWaiters<T> {
  constructor(options: { read: (corr: string) => Promise<T | undefined>; isDone: (row: T | undefined) => boolean; fallbackMs?: number });
  wait(corr: string, waitMs: number, signal?: AbortSignal): Promise<T | undefined>;
  notify(corr: string, row: T | undefined): void;
}
