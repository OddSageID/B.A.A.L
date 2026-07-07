import amqplib from 'amqplib';
import { TOPOLOGY } from './topology.js';
import { validateEvent, EventValidationError } from './validateEvent.js';
import { EventAuth } from './EventAuth.js';
import { BaalLogger } from '../utils/BaalLogger.js';

const SIG_HEADER = 'x-baal-signature';
const KEY_HEADER = 'x-baal-key-id';
const DEDUP_MAX_ENTRIES = 10000;

export class EventQueue {
  #connection   = null;
  #channel      = null;
  #consuming    = false;
  #consumerTags = [];
  #maxAgeMs     = 60000;
  #auth         = null;
  #seenEvents   = new Map(); // eventId -> firstSeenMs (bounded FIFO)
  #logger       = new BaalLogger({ name: 'EventQueue' });

  static async connect(url = process.env.RABBITMQ_URL ?? 'amqp://localhost', options = {}) {
    const queue = new EventQueue();
    queue.#maxAgeMs = options.maxAgeMs ?? parseInt(process.env.BAAL_EVENT_MAX_AGE_MS ?? '60000', 10);
    queue.#auth = options.auth ?? EventAuth.fromEnv();
    if (!queue.#auth.enforced) queue.#logger.warn('Producer authentication DISABLED — set BAAL_INGEST_KEYS (mandatory in production)');
    await queue.#connect(url);
    return queue;
  }

  async #connect(url) {
    this.#connection = await amqplib.connect(url);
    this.#channel    = await this.#connection.createChannel();
    await this.#channel.prefetch(TOPOLOGY.prefetch);
    await this.#channel.assertExchange(TOPOLOGY.exchange, TOPOLOGY.exchangeType, { durable: true });
    for (const def of Object.values(TOPOLOGY.queues)) {
      await this.#channel.assertQueue(def.name, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange':    TOPOLOGY.exchange,
          'x-dead-letter-routing-key': `dlq.${def.name}`,
          'x-message-ttl':             86400000,
        },
      });
      await this.#channel.bindQueue(def.name, TOPOLOGY.exchange, def.routingKey);
    }
    this.#connection.on('error', (err) => this.#logger.error('Connection error', { err }));
    this.#connection.on('close', () => { this.#logger.warn('Connection closed'); this.#consuming = false; });
    this.#logger.info('Connected — topology initialized', { producerAuth: this.#auth.enforced ? 'enforced' : 'open' });
  }

  async consume(handler) {
    if (this.#consuming) throw new Error('Already consuming');
    this.#consuming = true;
    const queuesToConsume = [
      TOPOLOGY.queues.BEHAVIORAL,
      TOPOLOGY.queues.EEG,
      TOPOLOGY.queues.BIOMETRIC,
      TOPOLOGY.queues.INTERACTION,
    ];
    for (const queueDef of queuesToConsume) {
      const tag = await this.#consumeQueue(queueDef, async (msg, event) => {
        const verdict = this.#auth.verify(msg.content, {
          keyId: msg.properties.headers?.[KEY_HEADER],
          signature: msg.properties.headers?.[SIG_HEADER],
        }, event.source);
        if (!verdict.ok) {
          this.#logger.warn('Rejecting unauthenticated event — dead-lettering', { queue: queueDef.name, reason: verdict.reason, eventId: event.eventId });
          this.#channel.nack(msg, false, false);
          return;
        }
        if (this.#isDuplicate(event.eventId)) {
          this.#logger.debug('Duplicate event acked without processing', { eventId: event.eventId });
          this.#channel.ack(msg);
          return;
        }
        try {
          await handler(event);
          this.#channel.ack(msg);
        } catch (err) {
          // First failure: requeue once. Second failure (redelivered): dead-letter.
          // Without this guard a poison message redelivers in a hot loop forever.
          this.#seenEvents.delete(event.eventId); // allow the retry through dedup
          const requeue = !msg.fields.redelivered;
          this.#logger.error(requeue ? 'Handler error — requeueing once' : 'Handler failed twice — dead-lettering', {
            queue: queueDef.name, eventId: event.eventId, subjectId: event.subjectId, err,
          });
          this.#channel.nack(msg, false, requeue);
        }
      });
      this.#consumerTags.push(tag);
    }
    this.#logger.info('Consuming from all event queues');
  }

  /** Internal escalation stream — produced by the agent itself, not signed. */
  async consumeEscalations(handler) {
    const tag = await this.#consumeRaw(TOPOLOGY.queues.ESCALATION, handler);
    this.#consumerTags.push(tag);
  }

  async #consumeQueue(queueDef, process) {
    const { consumerTag } = await this.#channel.consume(queueDef.name, async (msg) => {
      if (!msg) return;
      let event;
      try {
        event = JSON.parse(msg.content.toString('utf8'));
        validateEvent(event, { maxAgeMs: this.#maxAgeMs });
      } catch (err) {
        const kind = err instanceof EventValidationError ? 'invalid' : 'malformed';
        this.#logger.warn(`Rejecting ${kind} message — dead-lettering`, { queue: queueDef.name, err });
        this.#channel.nack(msg, false, false);
        return;
      }
      await process(msg, event);
    }, { noAck: false });
    return consumerTag;
  }

  async #consumeRaw(queueDef, handler) {
    const { consumerTag } = await this.#channel.consume(queueDef.name, async (msg) => {
      if (!msg) return;
      let payload;
      try { payload = JSON.parse(msg.content.toString('utf8')); }
      catch (err) {
        this.#logger.warn('Rejecting malformed message — dead-lettering', { queue: queueDef.name, err });
        this.#channel.nack(msg, false, false);
        return;
      }
      try { await handler(payload); this.#channel.ack(msg); }
      catch (err) {
        const requeue = !msg.fields.redelivered;
        this.#logger.error('Escalation handler error', { queue: queueDef.name, requeue, err });
        this.#channel.nack(msg, false, requeue);
      }
    }, { noAck: false });
    return consumerTag;
  }

  #isDuplicate(eventId) {
    if (this.#seenEvents.has(eventId)) return true;
    this.#seenEvents.set(eventId, Date.now());
    if (this.#seenEvents.size > DEDUP_MAX_ENTRIES) {
      const oldest = this.#seenEvents.keys().next().value;
      this.#seenEvents.delete(oldest);
    }
    return false;
  }

  /** Producers publish through here; keyId is mandatory once auth is enforced. */
  async publish(event, { keyId = null } = {}) {
    if (!this.#channel) throw new Error('EventQueue not connected');
    validateEvent(event, { maxAgeMs: this.#maxAgeMs });
    const payload = Buffer.from(JSON.stringify(event));
    const headers = {};
    if (this.#auth.enforced) {
      if (!keyId) throw new Error('Producer authentication enforced: publish requires a keyId');
      headers[KEY_HEADER] = keyId;
      headers[SIG_HEADER] = this.#auth.sign(payload, keyId);
    }
    this.#channel.publish(TOPOLOGY.exchange, `event.${event.source}.${event.type}`, payload, {
      persistent:    true,
      contentType:   'application/json',
      timestamp:     Math.floor(event.timestamp / 1000),
      messageId:     event.eventId,
      correlationId: event.subjectId,
      headers,
    });
  }

  async publishEscalation(escalation) {
    if (!this.#channel) throw new Error('EventQueue not connected');
    if (!escalation || typeof escalation.reason !== 'string' || !escalation.reason.trim()) {
      throw new Error('Escalation requires a reason');
    }
    const payload = Buffer.from(JSON.stringify(escalation));
    this.#channel.publish(TOPOLOGY.exchange, `escalation.${escalation.reason}`, payload, {
      persistent: true, contentType: 'application/json',
    });
  }

  health() { return { connected: Boolean(this.#connection && this.#channel) }; }

  async close() {
    if (!this.#channel) return;
    for (const tag of this.#consumerTags) {
      try { await this.#channel.cancel(tag); } catch (err) { this.#logger.warn('Consumer cancel failed', { tag, err }); }
    }
    this.#consumerTags = [];
    try { await this.#channel.close(); } catch (err) { this.#logger.warn('Channel close failed', { err }); }
    try { await this.#connection.close(); } catch (err) { this.#logger.warn('Connection close failed', { err }); }
    this.#channel = null;
    this.#connection = null;
    this.#logger.info('Closed gracefully');
  }
}
