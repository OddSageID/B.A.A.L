import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebhookNotificationAdapter, ConsoleDeliveryAdapter, createConsoleDeliveryMap } from '../../src/execution/adapters/DeliveryAdapters.js';
import { Modality } from '../../src/planning/CloudPlanner.js';

const step = { step: 1, modality: Modality.NOTIFICATION, intensity: 4, cue: 'caregiver_alert', rationale: 'test' };

describe('WebhookNotificationAdapter', () => {
  let server, received, statusToReturn = 200, port;

  before(async () => {
    received = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        received.push({ url: req.url, body: JSON.parse(body) });
        res.writeHead(statusToReturn).end('{}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    port = server.address().port;
  });
  after(async () => { await new Promise((r) => server.close(r)); });

  test('POSTs the alert and reports delivery', async () => {
    statusToReturn = 200;
    const adapter = new WebhookNotificationAdapter({ url: `http://127.0.0.1:${port}/hook` });
    const result = await adapter.deliver(step, 's1');
    assert.equal(result.delivered, true);
    assert.equal(received.at(-1).body.subjectId, 's1');
    assert.equal(received.at(-1).body.cue, 'caregiver_alert');
  });

  test('throws on non-2xx so escalation failure is surfaced, not swallowed', async () => {
    statusToReturn = 500;
    const adapter = new WebhookNotificationAdapter({ url: `http://127.0.0.1:${port}/hook` });
    await assert.rejects(() => adapter.deliver(step, 's1'), /responded 500/);
  });

  test('requires a url', () => {
    assert.throws(() => new WebhookNotificationAdapter({}), /requires a url/);
  });
});

describe('Console delivery', () => {
  test('console map covers every modality except silent_log', () => {
    const map = createConsoleDeliveryMap();
    for (const modality of Object.values(Modality)) {
      if (modality === Modality.SILENT_LOG) assert.equal(map[modality], undefined);
      else assert.equal(typeof map[modality], 'function');
    }
  });

  test('adapter reports delivery and invokes the observer hook', async () => {
    const seen = [];
    const adapter = new ConsoleDeliveryAdapter('haptic', { onDeliver: (...args) => seen.push(args) });
    const result = await adapter.deliver({ ...step, modality: 'haptic', cue: 'slow_pulse' }, 's1');
    assert.equal(result.delivered, true);
    assert.equal(seen.length, 1);
  });
});
