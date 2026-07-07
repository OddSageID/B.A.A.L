import { BaalLogger } from '../utils/BaalLogger.js';

/**
 * Closes the human-oversight loop: consumes the escalation queue, records
 * each escalation with an acknowledgment deadline, and raises an alert when
 * a deadline passes unacknowledged. Without this, `requiresAck: true` was a
 * message that died of queue TTL.
 *
 * `onOverdue` is the paging hook — wire it to PagerDuty/SMS/etc. in
 * deployment. Default behavior is an ERROR log plus a metrics counter.
 */
export class EscalationDesk {
  #queue; #vault; #metrics; #onOverdue;
  #ackTimeoutMs;
  #timer = null;
  #logger = new BaalLogger({ name: 'EscalationDesk' });

  constructor({ queue, vault, metrics, ackTimeoutMs = 15 * 60 * 1000, onOverdue = null }) {
    this.#queue = queue;
    this.#vault = vault;
    this.#metrics = metrics;
    this.#ackTimeoutMs = ackTimeoutMs;
    this.#onOverdue = onOverdue;
  }

  async start() {
    await this.#queue.consumeEscalations(async (escalation) => {
      await this.#vault.recordEscalation({
        escalationId: escalation.escalationId,
        subjectId:    escalation.subjectId,
        reason:       escalation.reason,
        intentClass:  escalation.intentClass,
        payload:      escalation,
        ackDeadline:  new Date(Date.now() + this.#ackTimeoutMs),
      });
      this.#logger.anat('Escalation recorded — awaiting human acknowledgment', {
        escalationId: escalation.escalationId, subjectId: escalation.subjectId, reason: escalation.reason,
      });
    });
    this.#timer = setInterval(() => { this.sweepNow().catch((err) => this.#logger.error('Overdue sweep failed', { err })); }, 60000);
    this.#timer.unref?.();
    this.#logger.info('Escalation desk online');
  }

  /** Alert on every unacknowledged escalation past its deadline (once each). */
  async sweepNow() {
    const overdue = await this.#vault.overdueEscalations();
    for (const escalation of overdue) {
      this.#logger.error('ESCALATION ACK OVERDUE — human oversight loop is broken', {
        escalationId: escalation.id, subjectId: escalation.subject_id,
        reason: escalation.reason, deadline: escalation.ack_deadline,
      });
      this.#metrics?.markOverdueEscalation();
      try { await this.#onOverdue?.(escalation); }
      catch (err) { this.#logger.error('onOverdue hook failed', { escalationId: escalation.id, err }); }
      await this.#vault.markEscalationAlerted(escalation.id);
    }
  }

  async ack(escalationId, ackedBy) {
    const acked = await this.#vault.ackEscalation(escalationId, ackedBy);
    if (acked) this.#logger.info('Escalation acknowledged', { escalationId, ackedBy });
    return acked;
  }

  async pending() { return this.#vault.pendingEscalations(); }

  async stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
  }
}
