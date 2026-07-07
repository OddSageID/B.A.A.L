import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AnatBoundary, VetoReason } from '../../src/neuroshield/AnatBoundary.js';
import { Modality, Intensity } from '../../src/planning/CloudPlanner.js';
import { IntentClass } from '../../src/inference/StormEngine.js';

const fullConsent = {
  active: true, optedOut: false, maxPermittedIntensity: Intensity.PROMPT,
  consentedModalities: Object.values(Modality), expiresAt: null,
};
const consentOf = (overrides) => ({ getConsentRecord: async () => ({ ...fullConsent, ...overrides }) });
const plan = (steps, extra = {}) => ({ plannedAt: Date.now(), requiresHuman: false, steps, ...extra });
const step = (intensity, modality = Modality.HAPTIC) => ({ step: 1, intensity, modality });
const intent = (cls = IntentClass.COGNITIVE_OVERLOAD) => ({ primary: { class: cls, confidence: 0.9 } });

describe('AnatBoundary.evaluate', () => {
  test('vetoes OVERRIDE always, even with full consent', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({ maxPermittedIntensity: Intensity.OVERRIDE }) });
    const res = await anat.evaluate({ plan: plan([step(Intensity.OVERRIDE, Modality.NOTIFICATION)]), intent: intent(), subjectId: 's1' });
    assert.equal(res.approved, false);
    assert.equal(res.reason, VetoReason.OVERRIDE_NEVER_PERMITTED);
  });

  test('vetoes when no consent record exists (fail closed)', async () => {
    const anat = new AnatBoundary({ consentProvider: { getConsentRecord: async () => null } });
    const res = await anat.evaluate({ plan: plan([step(Intensity.WHISPER)]), intent: intent(), subjectId: 's1' });
    assert.equal(res.approved, false);
    assert.equal(res.reason, VetoReason.CONSENT_NOT_ESTABLISHED);
  });

  test('vetoes when no consent provider is wired at all', async () => {
    const anat = new AnatBoundary();
    const res = await anat.evaluate({ plan: plan([step(Intensity.WHISPER)]), intent: intent(), subjectId: 's1' });
    assert.equal(res.approved, false);
    assert.equal(res.reason, VetoReason.CONSENT_NOT_ESTABLISHED);
  });

  test('vetoes when subject opted out', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({ optedOut: true }) });
    const res = await anat.evaluate({ plan: plan([step(Intensity.WHISPER)]), intent: intent(), subjectId: 's1' });
    assert.equal(res.reason, VetoReason.SUBJECT_OPT_OUT_ACTIVE);
  });

  test('vetoes expired consent', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({ expiresAt: new Date(Date.now() - 1000).toISOString() }) });
    const res = await anat.evaluate({ plan: plan([step(Intensity.WHISPER)]), intent: intent(), subjectId: 's1' });
    assert.equal(res.reason, VetoReason.CONSENT_EXPIRED);
  });

  test('vetoes modalities outside the consented set', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({ consentedModalities: [Modality.HAPTIC] }) });
    const res = await anat.evaluate({ plan: plan([step(Intensity.WHISPER, Modality.AUDITORY)]), intent: intent(), subjectId: 's1' });
    assert.equal(res.reason, VetoReason.MODALITY_NOT_CONSENTED);
  });

  test('silent_log never requires modality consent', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({ consentedModalities: [], maxPermittedIntensity: Intensity.WHISPER }) });
    const res = await anat.evaluate({ plan: plan([step(Intensity.WHISPER, Modality.SILENT_LOG)]), intent: intent(), subjectId: 's1' });
    assert.equal(res.approved, true);
  });

  test('vetoes intensity above the consented ceiling', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({ maxPermittedIntensity: Intensity.NUDGE }) });
    const res = await anat.evaluate({ plan: plan([step(Intensity.SIGNAL)]), intent: intent(), subjectId: 's1' });
    assert.equal(res.reason, VetoReason.INTENSITY_EXCEEDS_MANDATE);
  });

  test('intensity ceiling applies even on the human-in-loop path (regression: was bypassable)', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({ maxPermittedIntensity: Intensity.NUDGE }) });
    const res = await anat.evaluate({ plan: plan([step(Intensity.SIGNAL)]), intent: intent(IntentClass.PANIC_ONSET), subjectId: 's1' });
    assert.equal(res.approved, false);
    assert.equal(res.reason, VetoReason.INTENSITY_EXCEEDS_MANDATE);
  });

  test('prepends human notification for high-risk intents lacking one', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({}) });
    const res = await anat.evaluate({ plan: plan([step(Intensity.NUDGE)]), intent: intent(IntentClass.PANIC_ONSET), subjectId: 's1' });
    assert.equal(res.approved, true);
    assert.equal(res.modification, 'human_notification_prepended');
    assert.equal(res.modifiedPlan.steps[0].modality, Modality.NOTIFICATION);
    assert.equal(res.modifiedPlan.steps.length, 2);
  });

  test('durable intervention counts enforce limits across restarts', async () => {
    // Simulates a fresh process (empty in-memory log) whose consent provider
    // reports the subject already hit today's PROMPT cap in the database.
    const provider = {
      getConsentRecord: async () => ({ ...fullConsent }),
      countRecentInterventions: async () => ({ lastHour: 0, lastDay: 15 }),
    };
    const anat = new AnatBoundary({ consentProvider: provider });
    const res = await anat.evaluate({
      plan: plan([step(Intensity.PROMPT, Modality.NOTIFICATION)], { requiresHuman: true }),
      intent: intent(), subjectId: 's1',
    });
    assert.equal(res.approved, false);
    assert.equal(res.reason, VetoReason.RATE_LIMIT_EXCEEDED);
  });

  test('enforces hourly rate limits per subject', async () => {
    const anat = new AnatBoundary({ consentProvider: consentOf({}) });
    const promptPlan = () => plan([step(Intensity.PROMPT, Modality.NOTIFICATION)], { requiresHuman: true });
    for (let i = 0; i < 5; i++) {
      const res = await anat.evaluate({ plan: promptPlan(), intent: intent(), subjectId: 's1' });
      assert.equal(res.approved, true, `approval ${i + 1} should pass`);
    }
    const sixth = await anat.evaluate({ plan: promptPlan(), intent: intent(), subjectId: 's1' });
    assert.equal(sixth.approved, false);
    assert.equal(sixth.reason, VetoReason.RATE_LIMIT_EXCEEDED);
    // Rate limits are per subject — a different subject is unaffected.
    const other = await anat.evaluate({ plan: promptPlan(), intent: intent(), subjectId: 's2' });
    assert.equal(other.approved, true);
  });
});
