import { ResolutionSubscriber, ResolutionPublisher } from './ResolutionChannel.js';
import { InterventionLock }                          from './InterventionLock.js';
import { BaalLogger }                                from '../utils/BaalLogger.js';

export class ResolutionMonitor {
  #subscriber = null;
  #publisher  = null;
  #lock       = null;
  #logger     = new BaalLogger({ name: 'ResolutionMonitor' });
  #windows    = new Map();

  /** Cross-instance per-subject intervention lock (backed by Redis). */
  get interventionLock() {
    this.#lock ??= new InterventionLock(this.#publisher.client);
    return this.#lock;
  }

  static async create() {
    const monitor       = new ResolutionMonitor();
    monitor.#subscriber = await ResolutionSubscriber.connect();
    monitor.#publisher  = await ResolutionPublisher.connect();
    return monitor;
  }

  async waitForResolution(subjectId, windowMs, context = {}) {
    this.#logger.gaze('Resolution window opened', { subjectId, windowMs, intentClass: context.intentClass });
    this.#windows.set(subjectId, { openedAt: Date.now(), windowMs, intentClass: context.intentClass });
    this.#publisher.openWindow(subjectId);
    let signal = null;
    try {
      signal = await this.#subscriber.waitForSignal(subjectId, windowMs);
    } finally {
      this.#publisher.closeWindow(subjectId);
      this.#windows.delete(subjectId);
    }
    if (!signal) {
      this.#logger.gaze('Resolution window expired', { subjectId, windowMs });
      return { resolved: false, partiallyResolved: false, signal: null, timedOut: true };
    }
    const resolved          = signal.resolved;
    const partiallyResolved = !resolved && signal.partiallyResolved;
    this.#logger.gaze('Resolution signal received', { subjectId, resolved, partiallyResolved, severity: signal.deviation?.severity });
    return { resolved, partiallyResolved, signal, timedOut: false };
  }

  async forwardDeviation(subjectId, deviation, signalTimestamp) {
    if (!this.#publisher.isWindowOpen(subjectId)) return;
    await this.#publisher.publish(subjectId, deviation, signalTimestamp);
  }

  health() { return { connected: Boolean(this.#subscriber?.connected && this.#publisher?.connected) }; }

  get activeWindowCount()   { return this.#windows.size; }
  getWindowState(subjectId) { return this.#windows.get(subjectId) ?? null; }

  listActiveWindows() {
    const now = Date.now();
    return Array.from(this.#windows.entries()).map(([subjectId, w]) => ({
      subjectId,
      openedAt:    w.openedAt,
      windowMs:    w.windowMs,
      elapsedMs:   now - w.openedAt,
      remainingMs: Math.max(0, w.windowMs - (now - w.openedAt)),
      intentClass: w.intentClass,
    }));
  }

  async shutdown() {
    await this.#subscriber.disconnect();
    await this.#publisher.disconnect();
  }
}
