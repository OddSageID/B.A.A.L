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
