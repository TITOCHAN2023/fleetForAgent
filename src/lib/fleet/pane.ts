/**
 * Tmux-hub anti-stutter.
 *
 * tmux does not stream a pane's PTY to every observer. The job owns a local
 * buffer. Observers call capture-pane (a snapshot). pipe-pane is how you
 * freeze the control path.
 *
 * Same rules here:
 * 1. The process never runs on the hub request. Spawn, return `accepted`.
 * 2. Bytes stay on the device in a ring. The wire only sees snapshots.
 * 3. Latest-wins: if a frame is in flight / inside the min interval, drop
 *    intermediates. A 10k-line compile does not enqueue 10k WS messages.
 * 4. Control (ping, type, read_screen) must not wait on Wait()/ CombinedOutput.
 */

export const SCREEN_HZ = 4;
export const SCREEN_INTERVAL_MS = 1000 / SCREEN_HZ;
export const SCREEN_LINES = 80;
export const RING_LINES = 200;

export type ScreenFrame = {
  paneId: string;
  corr: string;
  seq: number;
  text: string;
  running: boolean;
  exitCode: number | null;
  t: number;
};

export class ScreenCoalescer {
  lastEmit = 0;
  dirty: ScreenFrame | null = null;
  emitted = 0;
  dropped = 0;

  constructor(
    private minIntervalMs = SCREEN_INTERVAL_MS,
    private now: () => number = () => Date.now(),
  ) {}

  /** Local write. Returns a wire frame only when the rate window is open. */
  onWrite(frame: ScreenFrame): ScreenFrame | null {
    if (this.dirty) this.dropped += 1;
    this.dirty = frame;
    if (this.now() - this.lastEmit < this.minIntervalMs) return null;
    return this.flush();
  }

  tick(): ScreenFrame | null {
    if (!this.dirty) return null;
    if (this.now() - this.lastEmit < this.minIntervalMs) return null;
    return this.flush();
  }

  private flush(): ScreenFrame {
    const frame = this.dirty!;
    this.dirty = null;
    this.lastEmit = this.now();
    this.emitted += 1;
    return frame;
  }
}

/** One-slot mailbox: unread previous frame is discarded. */
export class LatestWins<T> {
  current: T | null = null;
  dropped = 0;

  offer(value: T) {
    if (this.current !== null) this.dropped += 1;
    this.current = value;
  }

  take(): T | null {
    const v = this.current;
    this.current = null;
    return v;
  }
}

export class LocalPane {
  lines: string[] = [];
  running = true;
  exitCode: number | null = null;
  seq = 0;
  started: number;

  constructor(
    readonly id: string,
    readonly corr: string,
    readonly command: string,
    now = Date.now(),
  ) {
    this.started = now;
  }

  append(chunk: string) {
    const parts = chunk.replace(/\r/g, "").split("\n");
    if (this.lines.length === 0) this.lines.push("");
    this.lines[this.lines.length - 1] += parts[0] ?? "";
    for (let i = 1; i < parts.length; i++) this.lines.push(parts[i]!);
    if (this.lines.length > RING_LINES) {
      this.lines.splice(0, this.lines.length - RING_LINES);
    }
  }

  finish(code: number) {
    this.running = false;
    this.exitCode = code;
  }

  snapshot(now = Date.now()): ScreenFrame {
    this.seq += 1;
    return {
      paneId: this.id,
      corr: this.corr,
      seq: this.seq,
      text: this.lines.slice(-SCREEN_LINES).join("\n"),
      running: this.running,
      exitCode: this.exitCode,
      t: now,
    };
  }
}

export type Accepted = {
  corr: string;
  paneId: string;
  status: "accepted";
  ms: number;
};

/** Spawn must return before the job's own delay — that is the stutter test. */
export function acceptSpawn(
  corr: string,
  paneId: string,
  startedAt: number,
  finishedAt: number,
): Accepted {
  return { corr, paneId, status: "accepted", ms: finishedAt - startedAt };
}
