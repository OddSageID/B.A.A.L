import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EscalationDesk } from '../../src/oversight/EscalationDesk.js';
import { BaalMetrics } from '../../src/observability/BaalMetrics.js';

function fakeQueue() {
  return {
    handler: null,
    async consumeEscalations(handler) { this.handler = handler; },
  };
}

function fakeVault() {
  return {
    records: [], acks: [], alerted: [],
    overdue: [],
    async recordEscalation(entry) { this.records.push(entry); },
    async ackEscalation(id, actor) { this.acks.push({ id, actor }); return true; },
    async pendingEscalations() { return this.records; },
    async overdueEscalations() { return this.overdue; },
    async markEscalationAlerted(id) { this.alerted.push(id); },
  };
}

const escalation = { escalationId: 'esc-1', subjectId: 's1', reason: 'CONSENT_NOT_ESTABLISHED', intentClass: 'PANIC_ONSET' };

describe('EscalationDesk', () => {
  test('records consumed escalations with an ack deadline', async () => {
    const queue = fakeQueue(), vault = fakeVault();
    const desk = new EscalationDesk({ queue, vault, metrics: new BaalMetrics(), ackTimeoutMs: 60000 });
    await desk.start();
    await queue.handler(escalation);
    assert.equal(vault.records.length, 1);
    assert.equal(vault.records[0].escalationId, 'esc-1');
    assert.ok(vault.records[0].ackDeadline instanceof Date);
    assert.ok(vault.records[0].ackDeadline.getTime() > Date.now());
    await desk.stop();
  });

  test('ack delegates to the vault and reports success', async () => {
    const vault = fakeVault();
    const desk = new EscalationDesk({ queue: fakeQueue(), vault, metrics: new BaalMetrics() });
    assert.equal(await desk.ack('esc-1', 'operator@example.com'), true);
    assert.deepEqual(vault.acks, [{ id: 'esc-1', actor: 'operator@example.com' }]);
  });

  test('overdue escalations page, count in metrics, and are marked alerted', async () => {
    const vault = fakeVault();
    vault.overdue = [{ id: 'esc-9', subject_id: 's1', reason: 'X', ack_deadline: new Date(0) }];
    const metrics = new BaalMetrics();
    const paged = [];
    const desk = new EscalationDesk({ queue: fakeQueue(), vault, metrics, onOverdue: async (e) => paged.push(e.id) });
    await desk.sweepNow();
    assert.deepEqual(paged, ['esc-9']);
    assert.deepEqual(vault.alerted, ['esc-9']);
    assert.equal(metrics.snapshot().overdueEscalations, 1);
  });

  test('a failing paging hook still marks the escalation alerted', async () => {
    const vault = fakeVault();
    vault.overdue = [{ id: 'esc-9', subject_id: 's1', reason: 'X', ack_deadline: new Date(0) }];
    const desk = new EscalationDesk({ queue: fakeQueue(), vault, metrics: new BaalMetrics(), onOverdue: async () => { throw new Error('pager down'); } });
    await desk.sweepNow();
    assert.deepEqual(vault.alerted, ['esc-9']);
  });
});
