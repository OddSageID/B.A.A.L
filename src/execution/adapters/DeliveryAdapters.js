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
