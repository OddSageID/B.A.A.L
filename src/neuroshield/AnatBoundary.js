import { Modality, Intensity } from '../planning/CloudPlanner.js';
import { IntentClass }         from '../inference/StormEngine.js';

export const VetoReason = Object.freeze({
  CONSENT_NOT_ESTABLISHED:   'CONSENT_NOT_ESTABLISHED',
  INTENSITY_EXCEEDS_MANDATE: 'INTENSITY_EXCEEDS_MANDATE',
  OVERRIDE_NEVER_PERMITTED:  'OVERRIDE_NEVER_PERMITTED',
  SUBJECT_OPT_OUT_ACTIVE:    'SUBJECT_OPT_OUT_ACTIVE',
  RATE_LIMIT_EXCEEDED:       'RATE_LIMIT_EXCEEDED',
  ESCALATION_REQUIRED:       'ESCALATION_REQUIRED',
});

export class AnatBoundary {
  static RATE_LIMITS = {
    [Intensity.WHISPER]:  { perHour: 50,  perDay: 200 },
    [Intensity.NUDGE]:    { perHour: 20,  perDay: 80  },
    [Intensity.SIGNAL]:   { perHour: 10,  perDay: 40  },
    [Intensity.PROMPT]:   { perHour: 5,   perDay: 15  },
    [Intensity.OVERRIDE]: { perHour: 0,   perDay: 0   },
  };

  static REQUIRES_HUMAN_NOTIFICATION = new Set([
    IntentClass.PANIC_ONSET,
    IntentClass.RAGE_VECTOR,
    IntentClass.EMOTIONAL_SUPPRESSION,
  ]);

  #interventionLog = new Map();
  #consentProvider = null;

  constructor({ consentProvider = null } = {}) { this.#consentProvider = consentProvider; }

  async evaluate({ plan, intent, subjectId }) {
    if (plan.steps.some(s => s.intensity === Intensity.OVERRIDE))
      return this.#veto(VetoReason.OVERRIDE_NEVER_PERMITTED, { message: 'OVERRIDE requires explicit human authorization.', plan });

    const consent = await this.#getConsentRecord(subjectId);
    if (!consent || !consent.active)  return this.#veto(VetoReason.CONSENT_NOT_ESTABLISHED, { message: `No active consent for ${subjectId}`, plan });
    if (consent.optedOut) return this.#veto(VetoReason.SUBJECT_OPT_OUT_ACTIVE,  { message: `Subject ${subjectId} opted out`, plan });

    const rateCheck = this.#checkRateLimits(subjectId, plan);
    if (!rateCheck.passed) return this.#veto(VetoReason.RATE_LIMIT_EXCEEDED, { message: rateCheck.message, plan });

    if (AnatBoundary.REQUIRES_HUMAN_NOTIFICATION.has(intent.primary.class) && !plan.requiresHuman)
      return this.#requireHumanInLoop(plan, intent, subjectId);

    const maxIntensity     = consent.maxPermittedIntensity ?? Intensity.SIGNAL;
    const planMaxIntensity = Math.max(...plan.steps.map(s => s.intensity));
    if (planMaxIntensity > maxIntensity)
      return this.#veto(VetoReason.INTENSITY_EXCEEDS_MANDATE, { message: `Plan intensity (${planMaxIntensity}) exceeds consented max (${maxIntensity})`, plan });

    this.#logIntervention(subjectId, plan);
    return { approved: true, subjectId, planId: plan.plannedAt, approvedAt: Date.now() };
  }

  async escalate({ plan, intent, subjectId, reason }) {
    const escalation = {
      type: 'ANAT_ESCALATION', subjectId, reason,
      intentClass: intent.primary?.class, confidence: intent.primary?.confidence,
      plan, escalatedAt: Date.now(), requiresAck: true,
    };
    console.warn('[ANAT] Escalation triggered', escalation);
    return escalation;
  }

  #veto(reason, context = {}) {
    return { approved: false, reason, ...context, vetoedAt: Date.now() };
  }

  #requireHumanInLoop(plan, intent, subjectId) {
    return {
      approved: true, requiresHumanAck: true, subjectId,
      modification: 'human_notification_prepended',
      message: `Intent class ${intent.primary.class} requires human notification.`,
      modifiedPlan: {
        ...plan,
        steps: [
          { step: 0, modality: Modality.NOTIFICATION, intensity: Intensity.PROMPT, cue: 'human_oversight_alert', rationale: 'Anat mandate: human oversight required', delayMs: 0 },
          ...plan.steps,
        ],
      },
    };
  }

  async #getConsentRecord(subjectId) {
    if (this.#consentProvider?.getConsentRecord) {
      const consent = await this.#consentProvider.getConsentRecord(subjectId);
      if (consent) return consent;
    }
    return null;
  }

  #checkRateLimits(subjectId, plan) {
    const maxIntensity = Math.max(...plan.steps.map(s => s.intensity));
    const limits = AnatBoundary.RATE_LIMITS[maxIntensity];
    const now    = Date.now();
    const log    = this.#interventionLog.get(subjectId) ?? [];
    const lastHour = log.filter(e => now - e.timestamp < 3600000);
    const lastDay  = log.filter(e => now - e.timestamp < 86400000);
    if (lastHour.length >= limits.perHour) return { passed: false, message: `Rate limit: ${lastHour.length}/${limits.perHour} per hour` };
    if (lastDay.length  >= limits.perDay)  return { passed: false, message: `Rate limit: ${lastDay.length}/${limits.perDay} per day`   };
    return { passed: true };
  }

  #logIntervention(subjectId, plan) {
    const log = this.#interventionLog.get(subjectId) ?? [];
    log.push({ timestamp: Date.now(), intensity: Math.max(...plan.steps.map(s => s.intensity)) });
    this.#interventionLog.set(subjectId, log.filter(e => Date.now() - e.timestamp < 86400000));
  }
}
