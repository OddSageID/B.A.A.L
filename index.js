import { BaalAgent } from './src/agent/BaalAgent.js';

const agent = new BaalAgent({
  maxConcurrentSubjects: parseInt(process.env.BAAL_MAX_SUBJECTS ?? '50', 10),
  inferenceThreshold:    parseFloat(process.env.BAAL_THRESHOLD  ?? '0.72'),
  planningDepth:         parseInt(process.env.BAAL_PLAN_DEPTH   ?? '3', 10),
  memoryWindowHours:     parseInt(process.env.BAAL_MEMORY_HOURS ?? '24', 10),
});

let shuttingDown = false;
async function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { await agent.shutdown(); }
  catch (err) { console.error('[BAAL] Shutdown error', err); code = 1; }
  process.exit(code);
}

async function main() {
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT',  () => shutdown(0));
  process.on('unhandledRejection', (reason) => console.error('[BAAL] Unhandled rejection', reason));
  await agent.initialize();
  await agent.run();
}

main().catch((err) => {
  console.error('[BAAL] Fatal startup error', err);
  shutdown(1);
});
