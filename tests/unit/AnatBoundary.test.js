import { describe, test, expect } from '@jest/globals';
import { AnatBoundary, VetoReason } from '../../src/neuroshield/AnatBoundary.js';
import { Intensity } from '../../src/planning/CloudPlanner.js';
import { IntentClass } from '../../src/inference/StormEngine.js';

const basePlan = { plannedAt: Date.now(), requiresHuman: false, steps: [{ step:1, intensity: Intensity.SIGNAL, modality: 'haptic' }] };
const intent = { primary: { class: IntentClass.COGNITIVE_OVERLOAD } };

describe('AnatBoundary.evaluate', () => {
  test('vetoes override always', async () => {
    const anat = new AnatBoundary({ consentProvider: { getConsentRecord: async () => ({ active:true, optedOut:false, maxPermittedIntensity:4 }) } });
    const plan = { ...basePlan, steps: [{ step:1, intensity: Intensity.OVERRIDE, modality: 'notification' }] };
    const res = await anat.evaluate({ plan, intent, subjectId:'s1' });
    expect(res.approved).toBe(false);
    expect(res.reason).toBe(VetoReason.OVERRIDE_NEVER_PERMITTED);
  });

  test('vetoes when no active consent', async () => {
    const anat = new AnatBoundary({ consentProvider: { getConsentRecord: async () => null } });
    const res = await anat.evaluate({ plan: basePlan, intent, subjectId:'s1' });
    expect(res.approved).toBe(false);
    expect(res.reason).toBe(VetoReason.CONSENT_NOT_ESTABLISHED);
  });
});
