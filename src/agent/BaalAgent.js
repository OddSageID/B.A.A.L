import { GazeEngine }        from '../perception/GazeEngine.js';
import { StormEngine }       from '../inference/StormEngine.js';
import { CloudPlanner }      from '../planning/CloudPlanner.js';
import { WarExecutor }       from '../execution/WarExecutor.js';
import { ResolutionMonitor } from '../execution/ResolutionMonitor.js';
import { AnatBoundary }      from '../neuroshield/AnatBoundary.js';
import { BaselineVault }     from '../memory/BaselineVault.js';
import { AgentMemory }       from '../memory/AgentMemory.js';
import { EventQueue }        from '../transport/EventQueue.js';
import { BaalLogger }        from '../utils/BaalLogger.js';
import { BaalMetrics }       from '../observability/BaalMetrics.js';
import { HealthServer }      from '../observability/HealthServer.js';

export const AgentState = Object.freeze({
  OBSERVING: 'OBSERVING', INFERRING: 'INFERRING', PLANNING: 'PLANNING',
  DECLARING: 'DECLARING', EXECUTING: 'EXECUTING', EVALUATING: 'EVALUATING', VETOED: 'VETOED',
});

const TOOLS = {
  READ_BEHAVIORAL_SIGNAL: 'read_behavioral_signal',
  QUERY_BASELINE:         'query_baseline',
  INFER_INTENT:           'infer_intent',
  PLAN_INTERVENTION:      'plan_intervention',
  CHECK_NEUROSHIELD:      'check_neuroshield',
  EXECUTE_INTERVENTION:   'execute_intervention',
  EVALUATE_OUTCOME:       'evaluate_outcome',
  UPDATE_BASELINE:        'update_baseline',
  ESCALATE_TO_ANAT:       'escalate_to_anat',
};

export class BaalAgent {
  #gaze = null; #storm = null; #cloud = null; #war = null;
  #anat = null; #vault = null; #memory = null; #queue = null;
  #monitor = null; #logger = null;
  #subjects = new Map();
  #interveningSubjects = new Set();
  #running  = false;
  #metrics = new BaalMetrics();
  #healthServer = null;
  #startedAt = Date.now();
  #sweepTimer = null;

  constructor(config = {}) {
    this.config = {
      maxConcurrentSubjects: config.maxConcurrentSubjects ?? 50,
      inferenceThreshold:    config.inferenceThreshold    ?? 0.72,
      planningDepth:         config.planningDepth         ?? 3,
      memoryWindowHours:     config.memoryWindowHours     ?? 24,
      sessionIdleTtlMs:      config.sessionIdleTtlMs      ?? 6 * 3600 * 1000,
      healthPort:            config.healthPort            ?? parseInt(process.env.BAAL_HEALTH_PORT ?? '8787', 10),
      healthHost:            config.healthHost            ?? (process.env.BAAL_HEALTH_HOST ?? '127.0.0.1'),
      ...config,
    };
    this.#logger = new BaalLogger({ name: 'BaalAgent' });
  }

  /**
   * deps allows injecting vault/queue/monitor/etc. for tests and alternate
   * backends. Anything not provided is constructed against real services.
   */
  async initialize(deps = {}) {
    this.#logger.storm('B.A.A.L. initializing — The Gaze opens');
    this.#vault   = deps.vault   ?? await BaselineVault.connect();
    this.#memory  = deps.memory  ?? new AgentMemory({ windowHours: this.config.memoryWindowHours });
    this.#queue   = deps.queue   ?? await EventQueue.connect();
    this.#gaze    = deps.gaze    ?? new GazeEngine({ vault: this.#vault });
    this.#storm   = deps.storm   ?? new StormEngine({ threshold: this.config.inferenceThreshold });
    this.#cloud   = deps.cloud   ?? new CloudPlanner({ depth: this.config.planningDepth });
    this.#war     = deps.executor ?? new WarExecutor();
    this.#anat    = deps.boundary ?? new AnatBoundary({ consentProvider: this.#vault });
    this.#monitor = deps.monitor ?? await ResolutionMonitor.create();
    this.#war.setMonitor(this.#monitor);
    this.#healthServer = deps.healthServer ?? new HealthServer({
      deps: { vault: this.#vault, queue: this.#queue, monitor: this.#monitor, metrics: this.#metrics, startedAt: this.#startedAt },
      port: this.config.healthPort,
      host: this.config.healthHost,
    });
    await this.#healthServer.start();
    this.#logger.storm('B.A.A.L. initialized — The Storm is ready');
  }

  async run() {
    if (this.#running) throw new Error('B.A.A.L. is already running');
    this.#running = true;
    this.#sweepTimer = setInterval(() => this.#sweep(), 60000);
    this.#sweepTimer.unref?.();
    this.#logger.declare('B.A.A.L. agent loop started — The Gaze is open');
    await this.#queue.consume(async (event) => {
      try { await this.#processEvent(event); }
      catch (err) {
        this.#logger.error('Agent loop error', { subjectId: event.subjectId, eventId: event.eventId, err });
        throw err; // let the queue's redelivery/DLQ policy decide
      }
    });
  }

  async #processEvent(event) {
    const { subjectId } = event;
    const session = this.#getOrCreateSession(subjectId);
    session.lastSeenAt = Date.now();
    this.#logger.gaze('Event received', { subjectId, type: event.type });

    // Perception is never serialized: signals must keep flowing into any open
    // resolution window, or the closed feedback loop starves.
    const signal    = await this.#tool(TOOLS.READ_BEHAVIORAL_SIGNAL, { event, session });
    const baseline  = await this.#tool(TOOLS.QUERY_BASELINE, { subjectId });
    const deviation = this.#gaze.computeDeviation(signal, baseline);
    await this.#monitor.forwardDeviation(subjectId, deviation, signal.timestamp);

    if (!deviation.significant) {
      await this.#tool(TOOLS.UPDATE_BASELINE, { subjectId, signal, weight: 0.05 });
      this.#logger.gaze('No significant deviation', { subjectId });
      return;
    }

    // One intervention per subject at a time. A second significant deviation
    // during an active intervention already fed the resolution loop above;
    // starting a parallel intervention would race on the same Redis channel
    // and double-stimulate the subject.
    if (this.#interveningSubjects.has(subjectId)) {
      this.#logger.gaze('Intervention already in flight — signal forwarded to resolution loop only', { subjectId });
      return;
    }
    this.#interveningSubjects.add(subjectId);
    try {
      await this.#intervene({ event, session, signal, baseline, deviation });
    } finally {
      this.#interveningSubjects.delete(subjectId);
    }
  }

  async #intervene({ session, signal, baseline, deviation }) {
    const { subjectId } = session;
    this.#transition(session, AgentState.INFERRING);
    const intent = await this.#tool(TOOLS.INFER_INTENT, { signal, baseline, deviation, history: this.#memory.getHistory(subjectId) });
    this.#logger.storm('Intent inferred', { subjectId, intentClass: intent.primary?.class, confidence: intent.primary?.confidence });

    this.#transition(session, AgentState.PLANNING);
    const plan = await this.#tool(TOOLS.PLAN_INTERVENTION, { intent, subjectId, sessionContext: this.#sessionContext(session) });
    this.#logger.cloud('Plan constructed', { subjectId, steps: plan.steps.length, severity: plan.severity });

    const clearance = await this.#tool(TOOLS.CHECK_NEUROSHIELD, { plan, intent, subjectId });
    if (!clearance.approved) {
      this.#transition(session, AgentState.VETOED);
      session.vetoes += 1;
      this.#logger.anat('Vetoed by Anat', { subjectId, reason: clearance.reason });
      this.#metrics.markVeto(clearance.reason);
      const escalation = await this.#tool(TOOLS.ESCALATE_TO_ANAT, { plan, intent, subjectId, reason: clearance.reason });
      await this.#publishEscalation(escalation);
      await this.#auditVeto({ subjectId, plan, vetoReason: clearance.reason });
      this.#transition(session, AgentState.OBSERVING);
      return;
    }

    // Anat may have modified the plan (e.g. prepended a mandatory human
    // notification). Executing the original here would silently drop the
    // oversight step — the modified plan is the authorized one.
    const authorizedPlan = clearance.modifiedPlan ?? plan;

    this.#transition(session, AgentState.DECLARING);
    this.#logger.declare('War declared — intervention authorized', { subjectId, modified: Boolean(clearance.modifiedPlan) });
    this.#transition(session, AgentState.EXECUTING);
    session.interventions += 1;
    this.#metrics.markIntervention(intent.primary?.class);
    const result = await this.#tool(TOOLS.EXECUTE_INTERVENTION, { plan: authorizedPlan, subjectId });

    this.#transition(session, AgentState.EVALUATING);
    const evaluation = await this.#tool(TOOLS.EVALUATE_OUTCOME, { intent, plan: authorizedPlan, result, subjectId });
    this.#metrics.markResolution(evaluation.outcome);
    await this.#tool(TOOLS.UPDATE_BASELINE, { subjectId, signal, weight: evaluation.outcomeWeight });
    this.#memory.record(subjectId, { intent, plan: authorizedPlan, result, evaluation });
    await this.#auditIntervention({ subjectId, intent, plan: authorizedPlan, result, evaluation });
    this.#logger.declare('Cycle complete', { subjectId, outcome: evaluation.outcome });
    this.#transition(session, AgentState.OBSERVING);
  }

  async #tool(toolName, params) {
    switch (toolName) {
      case TOOLS.READ_BEHAVIORAL_SIGNAL: return this.#gaze.readSignal(params.event, params.session);
      case TOOLS.QUERY_BASELINE:         return this.#vault.getBaseline(params.subjectId);
      case TOOLS.INFER_INTENT:           return this.#storm.infer(params);
      case TOOLS.PLAN_INTERVENTION:      return this.#cloud.plan(params);
      case TOOLS.CHECK_NEUROSHIELD:      return this.#anat.evaluate(params);
      case TOOLS.EXECUTE_INTERVENTION:   return this.#war.execute(params.plan, params.subjectId);
      case TOOLS.EVALUATE_OUTCOME:       return this.#war.evaluate(params);
      case TOOLS.UPDATE_BASELINE:        return this.#vault.updateBaseline(params.subjectId, params.signal, params.weight);
      case TOOLS.ESCALATE_TO_ANAT:       return this.#anat.escalate(params);
      default: throw new Error(`Unknown tool: ${toolName}`);
    }
  }

  async #publishEscalation(escalation) {
    if (typeof this.#queue.publishEscalation !== 'function') return;
    try { await this.#queue.publishEscalation(escalation); }
    catch (err) { this.#logger.error('Escalation publish failed', { subjectId: escalation.subjectId, err }); }
  }

  async #auditVeto(entry) {
    if (typeof this.#vault.logVeto !== 'function') return;
    try { await this.#vault.logVeto(entry); }
    catch (err) { this.#logger.error('Veto audit write failed', { subjectId: entry.subjectId, err }); }
  }

  async #auditIntervention({ subjectId, intent, plan, result, evaluation }) {
    if (typeof this.#vault.logIntervention !== 'function') return;
    try {
      await this.#vault.logIntervention({
        subjectId,
        intentClass: intent.primary?.class ?? 'UNKNOWN',
        confidence:  intent.primary?.confidence ?? 0,
        plan, result, evaluation,
      });
    } catch (err) { this.#logger.error('Intervention audit write failed', { subjectId, err }); }
  }

  #sessionContext(session) {
    return {
      interventionCount: session.interventions,
      vetoCount:         session.vetoes,
      sessionAgeMs:      Date.now() - session.createdAt,
    };
  }

  #getOrCreateSession(subjectId) {
    let session = this.#subjects.get(subjectId);
    if (!session) {
      this.#evictIfFull();
      session = { subjectId, state: AgentState.OBSERVING, interventions: 0, vetoes: 0, createdAt: Date.now(), lastSeenAt: Date.now() };
      this.#subjects.set(subjectId, session);
    }
    return session;
  }

  // Session records are in-memory bookkeeping (counters, state); evicting an
  // idle one loses escalation counters but never consent or audit data —
  // those live in the vault.
  #evictIfFull() {
    if (this.#subjects.size < this.config.maxConcurrentSubjects) return;
    let oldest = null;
    for (const session of this.#subjects.values()) {
      if (this.#interveningSubjects.has(session.subjectId)) continue;
      if (!oldest || session.lastSeenAt < oldest.lastSeenAt) oldest = session;
    }
    if (oldest) {
      this.#subjects.delete(oldest.subjectId);
      this.#logger.debug('Evicted idle session (subject cap reached)', { subjectId: oldest.subjectId });
    }
  }

  #sweep() {
    const now = Date.now();
    for (const [subjectId, session] of this.#subjects) {
      if (this.#interveningSubjects.has(subjectId)) continue;
      if (now - session.lastSeenAt > this.config.sessionIdleTtlMs) this.#subjects.delete(subjectId);
    }
    this.#memory.sweep?.();
    this.#anat.sweep?.();
  }

  #transition(session, newState) { session.state = newState; }

  get metrics() { return this.#metrics; }
  get healthServer() { return this.#healthServer; }

  async shutdown() {
    if (!this.#running && !this.#queue && !this.#vault) return;
    this.#running = false;
    if (this.#sweepTimer) { clearInterval(this.#sweepTimer); this.#sweepTimer = null; }
    const closers = [
      ['queue',        () => this.#queue?.close()],
      ['vault',        () => this.#vault?.disconnect()],
      ['monitor',      () => this.#monitor?.shutdown()],
      ['healthServer', () => this.#healthServer?.stop()],
    ];
    for (const [name, close] of closers) {
      try { await close(); }
      catch (err) { this.#logger?.error(`Shutdown: ${name} close failed`, { err }); }
    }
    this.#queue = null; this.#vault = null; this.#monitor = null; this.#healthServer = null;
    this.#logger.storm('B.A.A.L. shutdown — The Gaze closes');
  }
}
