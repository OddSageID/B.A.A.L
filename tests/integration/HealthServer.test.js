import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import http from 'node:http';
import { HealthServer } from '../../src/observability/HealthServer.js';
import { BaalMetrics } from '../../src/observability/BaalMetrics.js';

const get = (path, port) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path }, (res) => {
    let body = '';
    res.on('data', (d) => body += d.toString('utf8'));
    res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
  }).on('error', reject);
});

describe('HealthServer', () => {
  const metrics = new BaalMetrics();
  const deps = {
    vault: { health: async () => ({ connected: true }) },
    queue: { health: () => ({ connected: true }) },
    monitor: { health: () => ({ connected: true }), activeWindowCount: 2 },
    metrics,
    startedAt: Date.now() - 1000,
  };
  const server = new HealthServer({ deps, port: 8788 });

  beforeAll(async () => { metrics.markIntervention('PANIC_ONSET'); metrics.markResolution('RESOLVED'); await server.start(); });
  afterAll(async () => { await server.stop(); });

  test('/health returns dependency statuses', async () => {
    const res = await get('/health', 8788);
    expect(res.status).toBe(200);
    expect(res.body.postgres.connected).toBe(true);
    expect(res.body.rabbitmq.connected).toBe(true);
    expect(res.body.redis.connected).toBe(true);
    expect(res.body.activeResolutionWindows).toBe(2);
    expect(res.body.uptimeMs).toBeGreaterThan(0);
  });

  test('/metrics returns counters', async () => {
    const res = await get('/metrics', 8788);
    expect(res.status).toBe(200);
    expect(res.body.interventionsByIntent.PANIC_ONSET).toBe(1);
    expect(res.body.resolution.resolved).toBe(1);
  });
});
