import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateEvent, EventValidationError } from '../../src/transport/validateEvent.js';

const NOW = 1_700_000_000_000;
const valid = () => ({
  eventId: 'evt-1',
  subjectId: 'subj-1',
  source: 'behavioral',
  type: 'keystroke_burst',
  payload: { cognitiveLoad: 0.4, arousal: 0.5 },
  timestamp: NOW - 1000,
});

describe('validateEvent', () => {
  test('accepts a well-formed event and returns it', () => {
    const event = valid();
    assert.equal(validateEvent(event, { now: NOW }), event);
  });

  test('rejects missing required fields', () => {
    for (const field of ['eventId', 'subjectId', 'source', 'type', 'payload', 'timestamp']) {
      const event = valid();
      delete event[field];
      assert.throws(() => validateEvent(event, { now: NOW }), EventValidationError, `should reject missing ${field}`);
    }
  });

  test('rejects unknown source', () => {
    const event = { ...valid(), source: 'telepathy' };
    assert.throws(() => validateEvent(event, { now: NOW }), /Invalid source/);
  });

  test('rejects stale events beyond maxAgeMs', () => {
    const event = { ...valid(), timestamp: NOW - 61000 };
    assert.throws(() => validateEvent(event, { now: NOW, maxAgeMs: 60000 }), /too stale/);
  });

  test('maxAgeMs of 0 disables the staleness gate', () => {
    const event = { ...valid(), timestamp: NOW - 999999999 };
    assert.equal(validateEvent(event, { now: NOW, maxAgeMs: 0 }), event);
  });

  test('rejects timestamps too far in the future', () => {
    const event = { ...valid(), timestamp: NOW + 6 * 60 * 1000 };
    assert.throws(() => validateEvent(event, { now: NOW }), /future/);
  });

  test('rejects out-of-bounds payload metrics', () => {
    assert.throws(() => validateEvent({ ...valid(), payload: { cognitiveLoad: 1.5 } }, { now: NOW }), /above maximum/);
    assert.throws(() => validateEvent({ ...valid(), payload: { arousal: -0.1 } }, { now: NOW }), /below minimum/);
    assert.throws(() => validateEvent({ ...valid(), payload: { cognitiveLoad: 'high' } }, { now: NOW }), /finite number/);
  });

  test('rejects oversized identifiers', () => {
    const event = { ...valid(), subjectId: 'x'.repeat(257) };
    assert.throws(() => validateEvent(event, { now: NOW }), /too long/);
  });

  test('rejects non-object payloads and array events', () => {
    assert.throws(() => validateEvent({ ...valid(), payload: [] }, { now: NOW }), EventValidationError);
    assert.throws(() => validateEvent([], { now: NOW }), EventValidationError);
    assert.throws(() => validateEvent(null, { now: NOW }), EventValidationError);
  });
});
