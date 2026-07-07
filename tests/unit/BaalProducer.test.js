import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BaalProducer } from '../../src/client/BaalProducer.js';

describe('BaalProducer', () => {
  test('emit before connect fails clearly', async () => {
    const producer = Object.create(BaalProducer.prototype);
    // A producer constructed without connect() has no channel.
    await assert.rejects(
      () => BaalProducer.prototype.emit.call(producer, { subjectId: 's1', source: 'behavioral', type: 't', payload: {} }),
      /not connected|private/i
    );
  });

  test('connect rejects mismatched key configuration', async () => {
    await assert.rejects(() => BaalProducer.connect({ url: 'amqp://unused', keyId: 'k1' }), /together/);
    await assert.rejects(() => BaalProducer.connect({ url: 'amqp://unused', keyId: 'k1', secret: 'short' }), /at least 16/);
  });
});
