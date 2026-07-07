import amqplib from 'amqplib';
import crypto from 'node:crypto';
import { TOPOLOGY } from '../transport/topology.js';
import { validateEvent } from '../transport/validateEvent.js';
import { KEY_HEADER, SIG_HEADER } from '../transport/EventAuth.js';

/**
 * Lightweight producer SDK — the way signals get INTO B.A.A.L.
 *
 * Handles the parts that are easy to get wrong by hand: event shape
 * validation against the schema, HMAC-SHA256 signing over the exact bytes
 * published, and the signature headers the daemon verifies.
 *
 *   const producer = await BaalProducer.connect({
 *     url: 'amqp://localhost',
 *     keyId: 'wearable-fleet',
 *     secret: process.env.MY_PRODUCER_SECRET,
 *   });
 *   await producer.emit({
 *     subjectId: 'subject-42',
 *     source: 'biometric',
 *     type: 'heart_rate',
 *     payload: { heartRate: 96, arousal: 0.7 },
 *   });
 */
export class BaalProducer {
  #connection = null;
  #channel = null;
  #keyId = null;
  #secret = null;

  static async connect({ url = process.env.RABBITMQ_URL ?? 'amqp://localhost', keyId = null, secret = null } = {}) {
    if ((keyId == null) !== (secret == null)) throw new Error('keyId and secret must be provided together');
    if (secret != null && secret.length < 16) throw new Error('secret must be at least 16 characters');
    const producer = new BaalProducer();
    producer.#keyId = keyId;
    producer.#secret = secret;
    producer.#connection = await amqplib.connect(url);
    producer.#channel = await producer.#connection.createConfirmChannel();
    await producer.#channel.assertExchange(TOPOLOGY.exchange, TOPOLOGY.exchangeType, { durable: true });
    return producer;
  }

  /**
   * Validates, signs, and publishes one behavioral event. eventId and
   * timestamp are filled in when omitted. Resolves once the broker confirms
   * the publish; returns the full event (keep eventId for tracing).
   */
  async emit({ subjectId, source, type, payload, timestamp = Date.now(), eventId = crypto.randomUUID() }) {
    if (!this.#channel) throw new Error('Producer not connected');
    const event = { eventId, subjectId, source, type, payload, timestamp };
    validateEvent(event, { maxAgeMs: 0 }); // staleness is the daemon's call
    const body = Buffer.from(JSON.stringify(event));
    const headers = {};
    if (this.#keyId) {
      headers[KEY_HEADER] = this.#keyId;
      headers[SIG_HEADER] = crypto.createHmac('sha256', this.#secret).update(body).digest('hex');
    }
    await new Promise((resolve, reject) => {
      this.#channel.publish(TOPOLOGY.exchange, `event.${source}.${type}`, body, {
        persistent:    true,
        contentType:   'application/json',
        timestamp:     Math.floor(timestamp / 1000),
        messageId:     eventId,
        correlationId: subjectId,
        headers,
      }, (err) => (err ? reject(err) : resolve()));
    });
    return event;
  }

  async close() {
    if (!this.#channel) return;
    try { await this.#channel.close(); } catch { /* already closing */ }
    try { await this.#connection.close(); } catch { /* already closing */ }
    this.#channel = null;
    this.#connection = null;
  }
}
