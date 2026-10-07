/**
 * Adaptive polling utility with exponential backoff.
 *
 * Starts at `baseInterval`, increases to `maxInterval` on each
 * consecutive identical result, resets on change or activity.
 */

export interface AdaptivePollOptions {
  /** Initial polling interval in ms (default: 2000) */
  baseInterval?: number;
  /** Maximum polling interval in ms (default: 30000) */
  maxInterval?: number;
  /** Multiplier for exponential backoff (default: 1.5) */
  backoffFactor?: number;
  /** Called on each successful poll with the result */
  onResult: (data: unknown) => void;
  /** The fetch function — should return parsed data */
  fetcher: () => Promise<unknown>;
  /** Optional: returns a fingerprint of the data. When unchanged, interval grows. */
  fingerprint?: (data: unknown) => string;
  /** Optional: stop polling when this returns true */
  shouldStop?: (data: unknown) => boolean;
}

export class AdaptivePoll {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private currentInterval: number;
  private lastFingerprint: string | null = null;
  private destroyed = false;

  private readonly baseInterval: number;
  private readonly maxInterval: number;
  private readonly backoffFactor: number;
  private readonly onResult: (data: unknown) => void;
  private readonly fetcher: () => Promise<unknown>;
  private readonly fingerprint: (data: unknown) => string;
  private readonly shouldStop: ((data: unknown) => boolean) | undefined;

  constructor(opts: AdaptivePollOptions) {
    this.baseInterval = opts.baseInterval ?? 2_000;
    this.maxInterval = opts.maxInterval ?? 30_000;
    this.backoffFactor = opts.backoffFactor ?? 1.5;
    this.onResult = opts.onResult;
    this.fetcher = opts.fetcher;
    this.fingerprint = opts.fingerprint ?? JSON.stringify;
    this.shouldStop = opts.shouldStop;
    this.currentInterval = this.baseInterval;
  }

  start() {
    if (this.destroyed) return;
    this.tick();
  }

  /** Reset interval back to base (e.g. on user activity) */
  reset() {
    this.currentInterval = this.baseInterval;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.destroyed) this.schedule();
  }

  stop() {
    this.destroyed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule() {
    if (this.destroyed) return;
    this.timer = setTimeout(() => this.tick(), this.currentInterval);
  }

  private async tick() {
    if (this.destroyed) return;
    try {
      const data = await this.fetcher();
      if (this.destroyed) return;
      this.onResult(data);

      if (this.shouldStop?.(data)) {
        this.stop();
        return;
      }

      const fp = this.fingerprint(data);
      if (fp === this.lastFingerprint) {
        // Data unchanged — back off
        this.currentInterval = Math.min(
          this.currentInterval * this.backoffFactor,
          this.maxInterval,
        );
      } else {
        // Data changed — reset to base
        this.currentInterval = this.baseInterval;
      }
      this.lastFingerprint = fp;
    } catch {
      // On error, back off
      this.currentInterval = Math.min(
        this.currentInterval * this.backoffFactor,
        this.maxInterval,
      );
    }
    this.schedule();
  }
}
