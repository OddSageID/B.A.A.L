import amqplib from 'amqplib';
import { TOPOLOGY } from './topology.js';
import { validateEvent, EventValidationError } from './validateEvent.js';
import { BaalLogger } from '../utils/BaalLogger.js';

export class EventQueue {
  #connection   = null;
  #channel      = null;
  #consuming    = false;
  #consumerTags = [];
  #maxAgeMs     = 60000;
  #logger       = new BaalLogger({ name: 'EventQueue' });

  static async connect(url = process.env.RABBITMQ_URL ?? 'amqp://localhost', options = {}) {
    const queue = new EventQueue();
    queue.#maxAgeMs = options.maxAgeMs ?? parseInt(process.env.BAAL_EVENT_MAX_AGE_MS ?? '60000', 10);
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
    this.#logger.info('Connected — topology initialized');
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
        try {
          await handler(event);
          this.#channel.ack(msg);
        } catch (err) {
          // First failure: requeue once. Second failure (redelivered): dead-letter.
          // Without this guard a poison message redelivers in a hot loop forever.
          const requeue = !msg.fields.redelivered;
          this.#logger.error(requeue ? 'Handler error — requeueing once' : 'Handler failed twice — dead-lettering', {
            queue: queueDef.name, eventId: event.eventId, subjectId: event.subjectId, err,
          });
          this.#channel.nack(msg, false, requeue);
        }
      }, { noAck: false });
      this.#consumerTags.push(consumerTag);
    }
    this.#logger.info('Consuming from all event queues');
  }

  async publish(event) {
    if (!this.#channel) throw new Error('EventQueue not connected');
    validateEvent(event, { maxAgeMs: this.#maxAgeMs });
    const routingKey = `event.${event.source}.${event.type}`;
    const payload    = Buffer.from(JSON.stringify(event));
    this.#channel.publish(TOPOLOGY.exchange, routingKey, payload, {
      persistent:    true,
      contentType:   'application/json',
      timestamp:     Math.floor(event.timestamp / 1000),
      messageId:     event.eventId,
      correlationId: event.subjectId,
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
