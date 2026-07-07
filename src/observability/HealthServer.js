import http from 'node:http';
import crypto from 'node:crypto';

const MAX_BODY_BYTES = 10 * 1024;

/**
 * Liveness/metrics/admin endpoint. Binds to 127.0.0.1 by default — it exposes
 * operational state and admin actions. Mutating routes require a bearer token
 * (BAAL_ADMIN_TOKEN); with no token configured they are disabled entirely
 * (fail closed), never open.
 *
 * Routes:
 *   GET    /health                  liveness (503 when a dependency is down)
 *   GET    /metrics                 counters snapshot
 *   GET    /escalations             pending human-oversight escalations
 *   POST   /escalations/{id}/ack    acknowledge an escalation   [token]
 *   POST   /abort/{subjectId}       kill an in-flight intervention [token]
 *   DELETE /subjects/{subjectId}    right-to-erasure               [token]
 */
export class HealthServer {
  #server = null;
  #port = 8787;
  #host = '127.0.0.1';
  #deps;
  #adminToken;

  constructor({ deps, port = 8787, host = '127.0.0.1', adminToken = process.env.BAAL_ADMIN_TOKEN ?? null }) {
    this.#deps = deps;
    this.#port = port;
    this.#host = host;
    this.#adminToken = adminToken && adminToken.length >= 16 ? adminToken : null;
  }

  async start() {
    this.#server = http.createServer((req, res) => {
      this.#route(req, res).catch((err) => {
        if (!res.headersSent) this.#json(res, 500, { error: 'internal', message: err.message });
      });
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

  async #route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health')  return this.#health(res);
    if (req.method === 'GET' && url.pathname === '/metrics') return this.#json(res, 200, this.#deps.metrics.snapshot());

    if (req.method === 'GET' && url.pathname === '/escalations') {
      if (!this.#deps.escalations) return this.#json(res, 404, { error: 'not_available' });
      return this.#json(res, 200, { pending: await this.#deps.escalations.list() });
    }

    if (req.method === 'POST' && parts[0] === 'escalations' && parts.length === 3 && parts[2] === 'ack') {
      if (!this.#authorize(req, res)) return;
      if (!this.#deps.escalations) return this.#json(res, 404, { error: 'not_available' });
      const body = await this.#readJson(req);
      const acked = await this.#deps.escalations.ack(parts[1], body?.actor ?? 'unknown');
      return acked ? this.#json(res, 200, { acked: true }) : this.#json(res, 404, { error: 'unknown_or_already_acked' });
    }

    if (req.method === 'POST' && parts[0] === 'abort' && parts.length === 2) {
      if (!this.#authorize(req, res)) return;
      if (!this.#deps.abort) return this.#json(res, 404, { error: 'not_available' });
      const aborted = await this.#deps.abort(decodeURIComponent(parts[1]));
      return this.#json(res, 200, { aborted });
    }

    if (req.method === 'DELETE' && parts[0] === 'subjects' && parts.length === 2) {
      if (!this.#authorize(req, res)) return;
      if (!this.#deps.eraseSubject) return this.#json(res, 404, { error: 'not_available' });
      await this.#deps.eraseSubject(decodeURIComponent(parts[1]));
      return this.#json(res, 200, { erased: true });
    }

    return this.#json(res, 404, { error: 'not_found' });
  }

  #authorize(req, res) {
    if (!this.#adminToken) {
      this.#json(res, 403, { error: 'admin_disabled', message: 'Set BAAL_ADMIN_TOKEN (≥16 chars) to enable admin routes' });
      return false;
    }
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
    const expected = Buffer.from(this.#adminToken);
    const actual = Buffer.from(provided);
    const ok = actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
    if (!ok) { this.#json(res, 401, { error: 'unauthorized' }); return false; }
    return true;
  }

  async #health(res) {
    const { vault, queue, monitor, startedAt } = this.#deps;
    const payload = {
      uptimeMs: Date.now() - startedAt,
      postgres: await vault.health(),
      rabbitmq: queue.health(),
      redis: monitor.health(),
      activeResolutionWindows: monitor.activeWindowCount,
    };
    const healthy = payload.postgres.connected && payload.rabbitmq.connected && payload.redis.connected;
    this.#json(res, healthy ? 200 : 503, { ...payload, status: healthy ? 'ok' : 'degraded' });
  }

  #readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) { req.destroy(); return reject(new Error('Body too large')); }
        chunks.push(chunk);
      });
      req.on('end', () => {
        if (chunks.length === 0) return resolve(null);
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { resolve(null); }
      });
      req.on('error', reject);
    });
  }

  #json(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  async stop() {
    if (!this.#server) return;
    this.#server.closeIdleConnections?.();
    await new Promise((resolve) => this.#server.close(resolve));
    this.#server = null;
  }
}
