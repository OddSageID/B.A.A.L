import http from 'node:http';

/**
 * Liveness/metrics endpoint. Binds to 127.0.0.1 by default — it exposes
 * per-subject counters and dependency state, which is operational data,
 * not public data. Override with host for containerized deployments.
 */
export class HealthServer {
  #server = null;
  #port = 8787;
  #host = '127.0.0.1';
  #deps;

  constructor({ deps, port = 8787, host = '127.0.0.1' }) {
    this.#deps = deps;
    this.#port = port;
    this.#host = host;
  }

  async start() {
    this.#server = http.createServer(async (req, res) => {
      try {
        if (req.url === '/health') {
          const payload = await this.#healthPayload();
          const healthy = payload.postgres.connected && payload.rabbitmq.connected && payload.redis.connected;
          res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ...payload, status: healthy ? 'ok' : 'degraded' }));
          return;
        }
        if (req.url === '/metrics') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(this.#deps.metrics.snapshot()));
          return;
        }
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal', message: err.message }));
      }
    });
    await new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.removeListener('error', reject);
        resolve();
      });
    });
  }

  /** Actual bound port — useful when constructed with port 0 (ephemeral). */
  get port() { return this.#server?.address()?.port ?? this.#port; }

  async #healthPayload() {
    const { vault, queue, monitor, startedAt } = this.#deps;
    return {
      uptimeMs: Date.now() - startedAt,
      postgres: await vault.health(),
      rabbitmq: queue.health(),
      redis: monitor.health(),
      activeResolutionWindows: monitor.activeWindowCount,
    };
  }

  async stop() {
    if (!this.#server) return;
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = null;
  }
}
