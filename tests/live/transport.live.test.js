/**
 * Live-path verification — the behaviors the in-memory suite cannot prove.
 * Requires real RabbitMQ/Postgres/Redis and BAAL_LIVE=1:
 *
 *   BAAL_LIVE=1 npm run test:live          # against docker compose services
 *
 * CI runs this against service containers on every push. Pointing the env
 * at a staging deployment turns this file into the staging soak test.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import amqplib from 'amqplib';
import pg from 'pg';
import { createClient } from 'redis';
import { EventQueue } from '../../src/transport/EventQueue.js';
import { EventAuth, KEY_HEADER, SIG_HEADER } from '../../src/transport/EventAuth.js';
import { TOPOLOGY } from '../../src/transport/topology.js';
import { BaalProducer } from '../../src/client/BaalProducer.js';
import { BaselineVault } from '../../src/memory/BaselineVault.js';
import { InterventionLock } from '../../src/execution/InterventionLock.js';
import { ResolutionPublisher, ResolutionSubscriber } from '../../src/execution/ResolutionChannel.js';

const LIVE = process.env.BAAL_LIVE === '1';
const AMQP_URL = process.env.RABBITMQ_URL ?? 'amqp://localhost';
const SECRET = 'live-test-secret-32-characters!!';
const AUTH_KEYS = { 'live-key': { secret: SECRET } };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(probe, { timeoutMs = 10000, intervalMs = 100, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

describe('live: RabbitMQ transport', { skip: !LIVE, concurrency: 1 }, () => {
  let raw, rawCh, queue, producer;
  const received = [];
  const attempts = new Map();
  const poisonIds = new Set();
  const dlqSeen = [];

  const drainDlq = async () => {
    for (;;) {
      const msg = await rawCh.get(TOPOLOGY.queues.DLQ.name, { noAck: true });
      if (!msg) return;
      try { dlqSeen.push(JSON.parse(msg.content.toString('utf8'))); } catch { /* non-JSON */ }
    }
  };

  before(async () => {
    raw = await amqplib.connect(AMQP_URL);
    rawCh = await raw.createChannel();
    queue = await EventQueue.connect(AMQP_URL, { auth: EventAuth.fromKeys(AUTH_KEYS) });
    for (const def of Object.values(TOPOLOGY.queues)) await rawCh.purgeQueue(def.name);
    await queue.consume(async (event) => {
      attempts.set(event.eventId, (attempts.get(event.eventId) ?? 0) + 1);
      if (poisonIds.has(event.eventId)) throw new Error('poison (intentional)');
      received.push(event);
    });
    producer = await BaalProducer.connect({ url: AMQP_URL, keyId: 'live-key', secret: SECRET });
  });

  after(async () => {
    await producer?.close();
    await queue?.close();
    try { await rawCh?.close(); } catch { /* closing */ }
    try { await raw?.close(); } catch { /* closing */ }
  });

  test('signed event flows producer → broker → daemon handler', async () => {
    const event = await producer.emit({ subjectId: 'live-s1', source: 'behavioral', type: 'ping', payload: { cognitiveLoad: 0.4 } });
    await waitFor(() => received.some(e => e.eventId === event.eventId), { label: 'signed event delivery' });
  });

  test('tampered signature dead-letters and never reaches the handler', async () => {
    const event = { eventId: crypto.randomUUID(), subjectId: 'live-s1', source: 'behavioral', type: 'ping', payload: {}, timestamp: Date.now() };
    rawCh.publish(TOPOLOGY.exchange, 'event.behavioral.ping', Buffer.from(JSON.stringify(event)), {
      headers: { [KEY_HEADER]: 'live-key', [SIG_HEADER]: 'deadbeef'.repeat(8) },
    });
    await waitFor(async () => { await drainDlq(); return dlqSeen.some(m => m.eventId === event.eventId); }, { label: 'tampered event in DLQ' });
    assert.ok(!received.some(e => e.eventId === event.eventId));
    assert.ok(!attempts.has(event.eventId), 'handler must never see an unauthenticated event');
  });

  test('unsigned event dead-letters when auth is enforced', async () => {
    const event = { eventId: crypto.randomUUID(), subjectId: 'live-s1', source: 'eeg', type: 'ping', payload: {}, timestamp: Date.now() };
    rawCh.publish(TOPOLOGY.exchange, 'event.eeg.ping', Buffer.from(JSON.stringify(event)), {});
    await waitFor(async () => { await drainDlq(); return dlqSeen.some(m => m.eventId === event.eventId); }, { label: 'unsigned event in DLQ' });
    assert.ok(!attempts.has(event.eventId));
  });

  test('poison message redelivers exactly once, then dead-letters', async () => {
    const eventId = crypto.randomUUID();
    poisonIds.add(eventId);
    await producer.emit({ eventId, subjectId: 'live-s1', source: 'behavioral', type: 'poison', payload: {} });
    await waitFor(async () => { await drainDlq(); return dlqSeen.some(m => m.eventId === eventId); }, { label: 'poison event in DLQ' });
    assert.equal(attempts.get(eventId), 2, 'exactly two delivery attempts (original + one redelivery)');
  });

  test('duplicate eventId is processed once (broker-side dedup)', async () => {
    const eventId = crypto.randomUUID();
    const payload = { subjectId: 'live-s1', source: 'behavioral', type: 'dup', payload: {} };
    await producer.emit({ eventId, ...payload });
    await producer.emit({ eventId, ...payload });
    await waitFor(() => attempts.get(eventId) >= 1, { label: 'first delivery' });
    await sleep(750); // give a wrongly-processed duplicate time to arrive
    assert.equal(attempts.get(eventId), 1);
    assert.equal(received.filter(e => e.eventId === eventId).length, 1);
  });
});

describe('live: Postgres vault', { skip: !LIVE, concurrency: 1 }, () => {
  let vault, pool;
  const SUBJECT = `live-pg-${crypto.randomUUID().slice(0, 8)}`;

  before(async () => {
    vault = await BaselineVault.connect(); // runs migrations
    pool = new pg.Pool({
      host: process.env.PGHOST ?? 'localhost',
      port: parseInt(process.env.PGPORT ?? '5432', 10),
      database: process.env.PGDATABASE ?? 'baal',
      user: process.env.PGUSER ?? 'baal',
      password: process.env.PGPASSWORD,
    });
  });
  after(async () => { await pool?.end(); await vault?.disconnect(); });

  test('both migrations applied and recorded', async () => {
    const { rows } = await pool.query('SELECT filename FROM schema_migrations ORDER BY filename');
    const files = rows.map(r => r.filename);
    assert.ok(files.includes('001_init.sql'), '001 applied');
    assert.ok(files.includes('002_hardening.sql'), '002 applied');
  });

  test('durable eventId dedup: second write commits nothing', async () => {
    const signal = { source: 'behavioral', dimensions: { cognitive_load: 0.5 } };
    const eventId = `live-dup-${crypto.randomUUID()}`;
    const first = await vault.updateBaseline(SUBJECT, signal, 0.05, { eventId });
    const second = await vault.updateBaseline(SUBJECT, signal, 0.05, { eventId });
    assert.equal(first.duplicate, false);
    assert.equal(second.duplicate, true);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM signal_events WHERE event_id = $1', [eventId]);
    assert.equal(rows[0].n, 1);
  });

  test('consent lifecycle and erasure against the real schema', async () => {
    await vault.activateConsent(SUBJECT, ['haptic'], 3);
    const consent = await vault.getConsentRecord(SUBJECT);
    assert.equal(consent.active, true);
    assert.deepEqual(consent.consentedModalities, ['haptic']);
    await vault.revokeConsent(SUBJECT);
    assert.equal((await vault.getConsentRecord(SUBJECT)).optedOut, true);
    await vault.eraseSubject(SUBJECT);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM subjects WHERE subject_id = $1', [SUBJECT]);
    assert.equal(rows[0].n, 0);
  });
});

describe('live: Redis lock and resolution channel', { skip: !LIVE, concurrency: 1 }, () => {
  let client;
  before(async () => {
    client = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6379' });
    await client.connect();
  });
  after(async () => { await client?.disconnect(); });

  test('intervention lock excludes a second holder, TTL and release both free it', async () => {
    const lock = new InterventionLock(client);
    const subject = `live-r-${crypto.randomUUID().slice(0, 8)}`;
    const token = await lock.acquire(subject, 5000);
    assert.ok(token);
    assert.equal(await lock.acquire(subject, 5000), null, 'contending acquire must fail');
    await lock.release(subject, token);
    const again = await lock.acquire(subject, 200);
    assert.ok(again, 'released lock is acquirable');
    await waitFor(async () => (await lock.acquire(subject, 5000)) !== null, { label: 'TTL expiry reclaim' });
  });

  test('resolution signal round-trips through pub/sub', async () => {
    const pub = await ResolutionPublisher.connect();
    const sub = await ResolutionSubscriber.connect();
    const subject = `live-w-${crypto.randomUUID().slice(0, 8)}`;
    try {
      pub.openWindow(subject);
      const pending = sub.waitForSignal(subject, 8000);
      await sleep(300); // let the subscription settle before publishing
      await pub.publish(subject, { significant: false, severity: 'none' }, Date.now());
      const signal = await pending;
      assert.ok(signal, 'signal received before window timeout');
      assert.equal(signal.resolved, true);
    } finally {
      pub.closeWindow(subject);
      await pub.disconnect();
      await sub.disconnect();
    }
  });
});
