import { Modality } from '../../planning/CloudPlanner.js';

const ok = (channel, step, subjectId, extra = {}) => ({
  delivered: channel !== 'silent_log',
  channel,
  cue: step.cue,
  subjectId,
  ...extra,
});

export class HapticAdapter { async deliver(step, subjectId) { return ok('haptic', step, subjectId); } }
export class AuditoryAdapter { async deliver(step, subjectId) { return ok('auditory', step, subjectId); } }
export class VisualAdapter { async deliver(step, subjectId) { return ok('visual', step, subjectId); } }
export class CognitiveAdapter { async deliver(step, subjectId) { return ok('cognitive', step, subjectId); } }
export class EnvironmentalAdapter { async deliver(step, subjectId) { return ok('environmental', step, subjectId); } }
export class NotificationAdapter { async deliver(step, subjectId) { return ok('notification', step, subjectId, { acknowledged: false }); } }
export class SilentLogAdapter { async deliver(step, subjectId) { return ok('silent_log', step, subjectId); } }

/**
 * Real notification delivery: POSTs the alert to any JSON webhook
 * (Slack incoming webhook, ntfy.sh, PagerDuty events proxy, …).
 * Throws on non-2xx/timeout so a failed caregiver alert surfaces as
 * escalationFailed instead of being silently swallowed.
 *
 * Privacy note: the payload includes subjectId — point this only at
 * endpoints cleared to receive it.
 */
export class WebhookNotificationAdapter {
  #url; #timeoutMs;
  constructor({ url, timeoutMs = 5000 }) {
    if (!url) throw new Error('WebhookNotificationAdapter requires a url');
    this.#url = url;
    this.#timeoutMs = timeoutMs;
  }

  async deliver(step, subjectId) {
    const alert = {
      text: `⚔ B.A.A.L. ${step.cue.replaceAll('_', ' ')} — subject ${subjectId} (intensity ${step.intensity})`,
      subjectId, cue: step.cue, intensity: step.intensity, rationale: step.rationale,
      at: new Date().toISOString(),
    };
    const res = await fetch(this.#url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(alert),
      signal: AbortSignal.timeout(this.#timeoutMs),
    });
    if (!res.ok) throw new Error(`Notification webhook responded ${res.status}`);
    return { delivered: true, channel: 'notification', cue: step.cue, subjectId, webhookStatus: res.status };
  }
}

/** Prints deliveries to the terminal — used by the demo and useful in dev. */
export class ConsoleDeliveryAdapter {
  #channel; #onDeliver;
  constructor(channel, { onDeliver = null } = {}) { this.#channel = channel; this.#onDeliver = onDeliver; }
  async deliver(step, subjectId) {
    const symbols = { haptic: '📳', auditory: '🔊', visual: '👁', cognitive: '🧠', environmental: '💡', notification: '📟' };
    console.log(`      ${symbols[this.#channel] ?? '▸'}  ${this.#channel.toUpperCase()} → ${subjectId}: ${step.cue.replaceAll('_', ' ')} (intensity ${step.intensity})`);
    this.#onDeliver?.(this.#channel, step, subjectId);
    return { delivered: true, channel: this.#channel, cue: step.cue, subjectId };
  }
}

export function createConsoleDeliveryMap({ onDeliver = null } = {}) {
  const map = {};
  for (const modality of Object.values(Modality)) {
    if (modality === Modality.SILENT_LOG) continue;
    const adapter = new ConsoleDeliveryAdapter(modality, { onDeliver });
    map[modality] = (step, subjectId) => adapter.deliver(step, subjectId);
  }
  return map;
}

export function createDefaultDeliveryMap() {
  const haptic        = new HapticAdapter();
  const auditory      = new AuditoryAdapter();
  const visual        = new VisualAdapter();
  const cognitive     = new CognitiveAdapter();
  const environmental = new EnvironmentalAdapter();
  const notification  = new NotificationAdapter();
  const silentLog     = new SilentLogAdapter();

  return {
    [Modality.HAPTIC]:        (step, subjectId) => haptic.deliver(step, subjectId),
    [Modality.AUDITORY]:      (step, subjectId) => auditory.deliver(step, subjectId),
    [Modality.VISUAL]:        (step, subjectId) => visual.deliver(step, subjectId),
    [Modality.COGNITIVE]:     (step, subjectId) => cognitive.deliver(step, subjectId),
    [Modality.ENVIRONMENTAL]: (step, subjectId) => environmental.deliver(step, subjectId),
    [Modality.NOTIFICATION]:  (step, subjectId) => notification.deliver(step, subjectId),
    [Modality.SILENT_LOG]:    (step, subjectId) => silentLog.deliver(step, subjectId),
  };
}
