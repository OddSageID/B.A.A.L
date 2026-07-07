import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HealthServer } from '../../src/observability/HealthServer.js';
import { BaalMetrics } from '../../src/observability/BaalMetrics.js';

const get = (path, port) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.on('data', (d) => { body += d.toString('utf8'); });
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  }).on('error', reject);
});

const depsWith = (metrics, overrides = {}) => ({
  vault: { health: async () => ({ connected: true }) },
  queue: { health: () => ({ connected: true }) },
  monitor: { health: () => ({ connected: true }), activeWindowCount: 2 },
  metrics,
  startedAt: Date.now() - 1000,
  ...overrides,
});

describe('HealthServer — healthy', () => {
  const metrics = new BaalMetrics();
  const server = new HealthServer({ deps: depsWith(metrics), port: 0 });

  before(async () => {
    metrics.markIntervention('PANIC_ONSET');
    metrics.markResolution('RESOLVED');
    await server.start();
  });
  after(async () => { await server.stop(); });

  test('/health returns 200 with dependency statuses', async () => {
    const res = await get('/health', server.port);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.postgres.connected, true);
    assert.equal(res.body.rabbitmq.connected, true);
    assert.equal(res.body.redis.connected, true);
    assert.equal(res.body.activeResolutionWindows, 2);
    assert.ok(res.body.uptimeMs > 0);
  });

  test('/metrics returns counters', async () => {
    const res = await get('/metrics', server.port);
    assert.equal(res.status, 200);
    assert.equal(res.body.interventionsByIntent.PANIC_ONSET, 1);
    assert.equal(res.body.resolution.resolved, 1);
  });

  test('unknown paths return 404', async () => {
    const res = await get('/nope', server.port);
    assert.equal(res.status, 404);
  });
});

describe('HealthServer — admin routes', () => {
  const TOKEN = 'a-long-admin-token-123456';
  const request = (method, path, port, { token, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      'content-type': 'application/json',
    } }, (res) => {
      let data = '';
      res.on('data', (d) => { data += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

  test('mutating routes require the bearer token', async () => {
    const acked = [];
    const server = new HealthServer({
      deps: depsWith(new BaalMetrics(), {
        escalations: { list: async () => [], ack: async (id, actor) => { acked.push({ id, actor }); return true; } },
        abort: async () => true,
      }),
      port: 0, adminToken: TOKEN,
    });
    await server.start();
    try {
      const unauthorized = await request('POST', '/escalations/esc-1/ack', server.port, { body: { actor: 'op' } });
      assert.equal(unauthorized.status, 401);
      const wrongToken = await request('POST', '/abort/s1', server.port, { token: 'wrong-token-wrong-token' });
      assert.equal(wrongToken.status, 401);
      const ok = await request('POST', '/escalations/esc-1/ack', server.port, { token: TOKEN, body: { actor: 'op' } });
      assert.equal(ok.status, 200);
      assert.deepEqual(acked, [{ id: 'esc-1', actor: 'op' }]);
      const aborted = await request('POST', '/abort/s1', server.port, { token: TOKEN });
      assert.deepEqual(aborted, { status: 200, body: { aborted: true } });
      // Read-only escalation listing needs no token.
      const listing = await request('GET', '/escalations', server.port, {});
      assert.equal(listing.status, 200);
    } finally { await server.stop(); }
  });

  test('admin routes are disabled entirely when no token is configured (fail closed)', async () => {
    const server = new HealthServer({
      deps: depsWith(new BaalMetrics(), { abort: async () => true }),
      port: 0, adminToken: null,
    });
    await server.start();
    try {
      const res = await request('POST', '/abort/s1', server.port, { token: 'anything-goes-here-x' });
      assert.equal(res.status, 403);
      assert.equal(res.body.error, 'admin_disabled');
    } finally { await server.stop(); }
  });

  test('/metrics?format=prometheus returns exposition text', async () => {
    const metrics = new BaalMetrics();
    metrics.markIntervention('PANIC_ONSET');
    const server = new HealthServer({ deps: depsWith(metrics), port: 0 });
    await server.start();
    try {
      const raw = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: server.port, path: '/metrics?format=prometheus' }, (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
        }).on('error', reject);
      });
      assert.equal(raw.status, 200);
      assert.match(raw.type, /text\/plain/);
      assert.match(raw.body, /baal_interventions_total\{intent_class="PANIC_ONSET"\} 1/);
    } finally { await server.stop(); }
  });

  test('consent routes: grant validates, revoke and get round-trip', async () => {
    const store = new Map();
    const server = new HealthServer({
      deps: depsWith(new BaalMetrics(), {
        consent: {
          get: async (sid) => store.get(sid) ?? null,
          grant: async (sid, { modalities, maxIntensity }) => {
            if (!Array.isArray(modalities) || modalities.length === 0) return { ok: false, error: 'modalities must be a non-empty array' };
            store.set(sid, { subjectId: sid, active: true, consentedModalities: modalities, maxPermittedIntensity: maxIntensity });
            return { ok: true };
          },
          revoke: async (sid) => { const r = store.get(sid); if (r) { r.active = false; r.optedOut = true; } },
        },
      }),
      port: 0, adminToken: TOKEN,
    });
    await server.start();
    try {
      const noToken = await request('PUT', '/subjects/s1/consent', server.port, { body: { modalities: ['haptic'] } });
      assert.equal(noToken.status, 401, 'consent routes require the token');
      const bad = await request('PUT', '/subjects/s1/consent', server.port, { token: TOKEN, body: { modalities: [] } });
      assert.equal(bad.status, 400);
      const ok = await request('PUT', '/subjects/s1/consent', server.port, { token: TOKEN, body: { modalities: ['haptic'], maxIntensity: 2 } });
      assert.equal(ok.status, 200);
      const got = await request('GET', '/subjects/s1/consent', server.port, { token: TOKEN });
      assert.equal(got.body.active, true);
      const revoked = await request('DELETE', '/subjects/s1/consent', server.port, { token: TOKEN });
      assert.deepEqual(revoked, { status: 200, body: { revoked: true } });
      assert.equal((await request('GET', '/subjects/s1/consent', server.port, { token: TOKEN })).body.optedOut, true);
      const missing = await request('GET', '/subjects/unknown/consent', server.port, { token: TOKEN });
      assert.equal(missing.status, 404);
    } finally { await server.stop(); }
  });

  test('erasure route delegates to the eraseSubject hook', async () => {
    const erased = [];
    const server = new HealthServer({
      deps: depsWith(new BaalMetrics(), { eraseSubject: async (sid) => { erased.push(sid); } }),
      port: 0, adminToken: TOKEN,
    });
    await server.start();
    try {
      const res = await request('DELETE', '/subjects/s%201', server.port, { token: TOKEN });
      assert.equal(res.status, 200);
      assert.deepEqual(erased, ['s 1']);
    } finally { await server.stop(); }
  });
});

describe('HealthServer — degraded', () => {
  const server = new HealthServer({
    deps: depsWith(new BaalMetrics(), { queue: { health: () => ({ connected: false }) } }),
    port: 0,
  });

  before(async () => { await server.start(); });
  after(async () => { await server.stop(); });

  test('/health returns 503 when a dependency is down', async () => {
    const res = await get('/health', server.port);
    assert.equal(res.status, 503);
    assert.equal(res.body.status, 'degraded');
    assert.equal(res.body.rabbitmq.connected, false);
  });
});
