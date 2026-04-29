import http from 'node:http';

export class HealthServer {
  #server = null;
  #port = 8787;
  #deps;

  constructor({ deps, port = 8787 }) {
    this.#deps = deps;
    this.#port = port;
  }

  async start() {
    this.#server = http.createServer(async (req, res) => {
      if (req.url === '/health') {
        const body = JSON.stringify(await this.#healthPayload());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      if (req.url === '/metrics') {
        const body = JSON.stringify(this.#deps.metrics.snapshot());
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(body);
        return;
      }
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    await new Promise((resolve) => this.#server.listen(this.#port, resolve));
  }

  async #healthPayload() {
    const { vault, queue, monitor, startedAt } = this.#deps;
    return {
      status: 'ok',
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
  }
}
