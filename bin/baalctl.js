#!/usr/bin/env node
/**
 * baalctl — operator CLI for B.A.A.L.
 *
 * Consent & subjects (talks to Postgres via .env / PG* variables):
 *   baalctl enroll <subjectId>
 *   baalctl consent grant <subjectId> --modalities haptic,auditory --max-intensity 3
 *   baalctl consent revoke <subjectId>
 *   baalctl consent show <subjectId>
 *   baalctl baseline <subjectId>
 *
 * Operations (talks to the running daemon's admin API):
 *   baalctl status
 *   baalctl metrics
 *   baalctl escalations
 *   baalctl escalations ack <id> --actor you@example.com
 *   baalctl abort <subjectId>
 *   baalctl erase <subjectId> --yes
 *
 * Admin API auth: set BAAL_ADMIN_TOKEN. API location: BAAL_HEALTH_HOST/PORT.
 */
import { parseArgs } from 'node:util';
import process from 'node:process';

const MODALITIES = ['haptic', 'auditory', 'visual', 'cognitive', 'environmental', 'notification', 'silent_log'];
const INTENSITY_NAMES = { 1: 'WHISPER', 2: 'NUDGE', 3: 'SIGNAL', 4: 'PROMPT', 5: 'OVERRIDE' };

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    modalities:      { type: 'string' },
    'max-intensity': { type: 'string' },
    actor:           { type: 'string' },
    yes:             { type: 'boolean', default: false },
    help:            { type: 'boolean', short: 'h', default: false },
  },
});

const usage = () => {
  console.log(`Usage:
  baalctl enroll <subjectId>
  baalctl consent grant <subjectId> --modalities haptic,auditory [--max-intensity 1..4]
  baalctl consent revoke <subjectId>
  baalctl consent show <subjectId>
  baalctl baseline <subjectId>
  baalctl status | metrics | escalations
  baalctl escalations ack <id> --actor <who>
  baalctl abort <subjectId>
  baalctl erase <subjectId> --yes`);
};

const fail = (message) => { console.error(`error: ${message}`); process.exit(1); };

// ── Admin API helpers ────────────────────────────────────────────────────────

const apiBase = () => `http://${process.env.BAAL_HEALTH_HOST ?? '127.0.0.1'}:${process.env.BAAL_HEALTH_PORT ?? '8787'}`;

async function api(method, path, body = null) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.BAAL_ADMIN_TOKEN) headers.authorization = `Bearer ${process.env.BAAL_ADMIN_TOKEN}`;
  let res;
  try {
    res = await fetch(`${apiBase()}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(5000) });
  } catch (err) {
    fail(`cannot reach B.A.A.L. admin API at ${apiBase()} — is the daemon running? (${err.cause?.code ?? err.message})`);
  }
  const payload = await res.json().catch(() => ({}));
  if (res.status === 401) fail('unauthorized — check BAAL_ADMIN_TOKEN');
  if (res.status === 403) fail(payload.message ?? 'admin routes disabled — set BAAL_ADMIN_TOKEN on the daemon');
  return { status: res.status, payload };
}

// ── Vault helpers (lazy import so API-only commands need no Postgres) ───────

async function withVault(fn) {
  const { BaselineVault } = await import('../src/memory/BaselineVault.js');
  let vault;
  try { vault = await BaselineVault.connect(); }
  catch (err) { fail(`cannot connect to Postgres (${err.message}) — check PG* env variables`); }
  try { return await fn(vault); }
  finally { await vault.disconnect(); }
}

const requireSubject = (value) => {
  if (!value || value.length > 256) fail('a subjectId is required');
  return value;
};

// ── Commands ─────────────────────────────────────────────────────────────────

async function main() {
  if (flags.help || positionals.length === 0) return usage();
  const [command, ...rest] = positionals;

  switch (command) {
    case 'enroll': {
      const subjectId = requireSubject(rest[0]);
      await withVault(async (vault) => {
        await vault.enrollSubject(subjectId);
        console.log(`Enrolled ${subjectId} (no consent yet — interventions are vetoed until 'consent grant').`);
      });
      return;
    }

    case 'consent': {
      const [action, subjectArg] = rest;
      const subjectId = requireSubject(subjectArg);
      if (action === 'grant') {
        if (!flags.modalities) fail('--modalities is required (e.g. --modalities haptic,auditory)');
        const modalities = flags.modalities.split(',').map(m => m.trim()).filter(Boolean);
        const unknown = modalities.filter(m => !MODALITIES.includes(m));
        if (unknown.length) fail(`unknown modalities: ${unknown.join(', ')} (valid: ${MODALITIES.join(', ')})`);
        const maxIntensity = parseInt(flags['max-intensity'] ?? '3', 10);
        if (!(maxIntensity >= 1 && maxIntensity <= 4)) fail('--max-intensity must be 1–4 (OVERRIDE=5 is never grantable)');
        await withVault(async (vault) => {
          await vault.activateConsent(subjectId, modalities, maxIntensity);
          console.log(`Consent active for ${subjectId}: ${modalities.join(', ')} up to ${INTENSITY_NAMES[maxIntensity]}.`);
        });
        return;
      }
      if (action === 'revoke') {
        await withVault(async (vault) => {
          await vault.revokeConsent(subjectId);
          console.log(`Consent revoked for ${subjectId}. In-flight interventions abort at the next ladder step.`);
        });
        return;
      }
      if (action === 'show') {
        await withVault(async (vault) => {
          const record = await vault.getConsentRecord(subjectId);
          if (!record) return console.log(`No consent record for ${subjectId}.`);
          console.log(JSON.stringify({ ...record, maxPermittedIntensity: `${record.maxPermittedIntensity} (${INTENSITY_NAMES[record.maxPermittedIntensity] ?? '?'})` }, null, 2));
        });
        return;
      }
      return fail(`unknown consent action '${action}' (grant|revoke|show)`);
    }

    case 'baseline': {
      const subjectId = requireSubject(rest[0]);
      await withVault(async (vault) => {
        const baseline = await vault.getBaseline(subjectId);
        if (!baseline) return console.log(`No baseline for ${subjectId} yet.`);
        for (const [dim, stats] of Object.entries(baseline.dimensions)) {
          const pinned = stats.referenceMean != null ? ` ref=${stats.referenceMean.toFixed(3)}` : ' (calibrating)';
          console.log(`  ${dim.padEnd(18)} mean=${stats.mean.toFixed(3)} σ=${stats.stdDev.toFixed(3)} n=${stats.sampleCount}${pinned}`);
        }
      });
      return;
    }

    case 'status': {
      const { status, payload } = await api('GET', '/health');
      console.log(`daemon: ${payload.status} (HTTP ${status})  uptime: ${Math.round((payload.uptimeMs ?? 0) / 1000)}s`);
      for (const dep of ['postgres', 'rabbitmq', 'redis']) {
        console.log(`  ${dep.padEnd(9)} ${payload[dep]?.connected ? 'connected' : `DOWN${payload[dep]?.error ? ` (${payload[dep].error})` : ''}`}`);
      }
      console.log(`  resolution windows open: ${payload.activeResolutionWindows ?? 0}`);
      return;
    }

    case 'metrics': {
      const { payload } = await api('GET', '/metrics');
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    case 'escalations': {
      if (rest[0] === 'ack') {
        const id = rest[1] ?? fail('escalation id required');
        if (!flags.actor) fail('--actor is required for the audit trail');
        const { status, payload } = await api('POST', `/escalations/${encodeURIComponent(id)}/ack`, { actor: flags.actor });
        if (status === 200) console.log(`Acknowledged ${id} as ${flags.actor}.`);
        else fail(payload.error ?? `HTTP ${status}`);
        return;
      }
      const { payload } = await api('GET', '/escalations');
      const pending = payload.pending ?? [];
      if (pending.length === 0) return console.log('No pending escalations.');
      for (const e of pending) {
        const overdue = new Date(e.ack_deadline) < new Date() ? '  ⚠ OVERDUE' : '';
        console.log(`  ${e.id}  ${e.subject_id}  ${e.reason}  deadline ${e.ack_deadline}${overdue}`);
      }
      return;
    }

    case 'abort': {
      const subjectId = requireSubject(rest[0]);
      const { payload } = await api('POST', `/abort/${encodeURIComponent(subjectId)}`);
      console.log(payload.aborted ? `Abort signaled for ${subjectId}.` : `No intervention in flight for ${subjectId}.`);
      return;
    }

    case 'erase': {
      const subjectId = requireSubject(rest[0]);
      if (!flags.yes) fail(`erasure is irreversible — re-run with --yes to remove every trace of ${subjectId}`);
      const { status } = await api('DELETE', `/subjects/${encodeURIComponent(subjectId)}`);
      if (status === 200) console.log(`Erased ${subjectId}: baselines, signals, interventions, consents, escalations.`);
      else fail(`HTTP ${status}`);
      return;
    }

    default:
      usage();
      fail(`unknown command '${command}'`);
  }
}

main().catch((err) => fail(err.message));
