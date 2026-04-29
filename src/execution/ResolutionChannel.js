import { createClient } from 'redis';

const channelFor = (subjectId) => `baal:resolution:${subjectId}`;

export class ResolutionSignal {
  constructor({ subjectId, deviation, signalTimestamp }) {
    this.subjectId       = subjectId;
    this.deviation       = deviation;
    this.signalTimestamp = signalTimestamp;
    this.publishedAt     = Date.now();
  }
  get resolved()          { return !this.deviation.significant; }
  get partiallyResolved() {
    const order = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
    return order[this.deviation.severity] <= order['low'];
  }
  serialize() {
    return JSON.stringify({ subjectId: this.subjectId, deviation: this.deviation, signalTimestamp: this.signalTimestamp, publishedAt: this.publishedAt });
  }
  static deserialize(raw) { return new ResolutionSignal(JSON.parse(raw)); }
}

export class ResolutionPublisher {
  #client = null;
  #connected = false;
  #active = new Set();

  static async connect(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
    const pub = new ResolutionPublisher();
    pub.#client = createClient({ url });
    pub.#client.on('error', (err) => console.error('[ResolutionPublisher] Redis error', err));
    await pub.#client.connect();
    pub.#connected = true;
    return pub;
  }

  openWindow(subjectId)   { this.#active.add(subjectId); }
  closeWindow(subjectId)  { this.#active.delete(subjectId); }
  isWindowOpen(subjectId) { return this.#active.has(subjectId); }

  async publish(subjectId, deviation, signalTimestamp) {
    if (!this.#active.has(subjectId)) return;
    const signal = new ResolutionSignal({ subjectId, deviation, signalTimestamp });
    await this.#client.publish(channelFor(subjectId), signal.serialize());
  }

  get connected() { return this.#connected; }

  async disconnect() { await this.#client.disconnect(); this.#connected = false; }
}

export class ResolutionSubscriber {
  #client = null;
  #connected = false;

  static async connect(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
    const sub = new ResolutionSubscriber();
    sub.#client = createClient({ url });
    sub.#client.on('error', (err) => console.error('[ResolutionSubscriber] Redis error', err));
    await sub.#client.connect();
    sub.#connected = true;
    return sub;
  }

  async waitForSignal(subjectId, windowMs) {
    return new Promise(async (resolve) => {
      const channel = channelFor(subjectId);
      let settled = false, timeoutId = null;
      const cleanup = async (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        try { await this.#client.unsubscribe(channel); } catch (_) {}
        resolve(result);
      };
      timeoutId = setTimeout(() => cleanup(null), windowMs);
      await this.#client.subscribe(channel, async (message) => {
        try { await cleanup(ResolutionSignal.deserialize(message)); }
        catch (err) { console.error('[ResolutionSubscriber] Malformed signal', err); }
      });
    });
  }

  get connected() { return this.#connected; }

  async disconnect() { await this.#client.disconnect(); this.#connected = false; }
}
