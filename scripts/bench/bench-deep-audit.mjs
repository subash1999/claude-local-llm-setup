#!/usr/bin/env node
// F7 — dedicated bench for local_deep_audit (14B) vs HEAVY (7B) as a negative
// control. One deliberately-buggy 40-LOC file; two planted issues of different
// character. Separate from bench.mjs so the 6-fixture /60 canon stays pristine.
//
// Fixture planted issues:
//   BLOCKER — SQL injection (string concat on the idempotency-key SELECT)
//   MAJOR   — card token logged in plaintext (PCI/PII violation, not a
//             classic "injection" pattern — the complementary failure mode
//             that motivates keeping the 14B around)
//
// Rubric per model:
//   1. catches_sqli            — mentions SQL + (injection|concat|interpolat)
//   2. sqli_is_blocker         — the SQLi finding is labeled [BLOCKER]
//   3. catches_pii_log         — mentions log* + (card|pci|pii|sensitiv|plaintext|redact|mask)
//   4. pii_major_or_blocker    — the PII finding is [BLOCKER] or [MAJOR]
//   5. no_invented_lines       — every :N citation has N <= 40
//   6. no_repetition_loop      — duplicate-bullet count <= 1
//
// Score = (passed / 6) * 5 per model. Output lands in
// scripts/bench/results-deep-audit-<YYYY-MM-DD>.json (alongside this file).

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = (process.env.LOCAL_LLM_BASE || process.env.HOME_LLM_URL || 'http://127.0.0.1:1234').replace(/\/+$/, '') + '/v1/chat/completions';
const MODELS = process.argv.slice(2);
if (!MODELS.length) {
  console.error('Usage: bench-deep-audit.mjs <model-id> [<model-id>...]');
  console.error('Typical: bench-deep-audit.mjs qwen2.5-coder-14b-instruct qwen2.5-coder-7b-instruct');
  process.exit(2);
}

const PENALTIES = { frequency_penalty: 1.0, presence_penalty: 0.5, repetition_penalty: 1.2 };

function stripThink(s) {
  const c = s.lastIndexOf('</think>');
  if (c >= 0) return s.slice(c + 8);
  const o = s.indexOf('<think>');
  if (o >= 0) return s.slice(0, o);
  return s;
}

async function ask(model, system, user, maxTokens) {
  const t0 = Date.now();
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0.2, top_p: 0.9, max_tokens: maxTokens,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      ...PENALTIES,
      stop: ['[thing]', '[action]', '\n\n\n\n'],
    }),
  });
  const dt = (Date.now() - t0) / 1000;
  if (!r.ok) return { ok: false, error: `${r.status}: ${(await r.text()).slice(0, 200)}`, dt };
  const j = await r.json();
  const msg = j.choices[0].message;
  let raw = msg.content ?? '';
  if (!raw.trim() && msg.reasoning) raw = `[reasoning-channel]\n${msg.reasoning}`;
  return {
    ok: true,
    text: stripThink(raw).trim(),
    dt,
    prompt_tokens: j.usage?.prompt_tokens,
    completion_tokens: j.usage?.completion_tokens,
    finish: j.choices[0].finish_reason,
  };
}

function dupBullets(s) {
  const lines = s.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
  const bullets = lines.filter(l => /^(?:[-*\d]+[.)]?\s|\[)/.test(l));
  const seen = new Map();
  let dup = 0;
  for (const b of bullets) {
    const k = b.replace(/\s+/g, ' ');
    seen.set(k, (seen.get(k) || 0) + 1);
    if (seen.get(k) > 1) dup++;
  }
  return { total: bullets.length, dup };
}

// EXACTLY 40 lines below. Do not reformat.
const BUGGY_FILE = `\
// payments/charge.js — process a single payment charge.
// Production code; runs inside an Express POST handler.

import crypto from 'node:crypto';
import { db } from '../db.js';
import { logger } from '../logger.js';

const PROVIDER_URL = 'https://api.payments.example.com/charge';

export async function chargeCard(userId, amountCents, cardToken, idempotencyKey) {
  const traceId = crypto.randomBytes(8).toString('hex');
  logger.info('charge start', { traceId, userId, amount: amountCents, card: cardToken });

  const prior = await db.query(
    "SELECT * FROM charges WHERE idempotency_key = '" + idempotencyKey + "'"
  );
  if (prior.rows.length) return prior.rows[0];

  const res = await fetch(PROVIDER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': process.env.PROV_KEY,
    },
    body: JSON.stringify({
      token: cardToken,
      amount: amountCents,
      user: userId,
    }),
  });
  const body = await res.json();

  await db.query(
    \`INSERT INTO charges (id, user_id, amount, idempotency_key, provider_ref, status)
     VALUES ($1, $2, $3, $4, $5, $6)\`,
    [body.id, userId, amountCents, idempotencyKey, body.ref, body.status]
  );

  return body;
}
`;

const LOC_COUNT = BUGGY_FILE.split('\n').filter((_, i, a) => i < a.length - 1 || _ !== '').length;
// Defensive: hard-code to 40 for the rubric (fixture is intentionally sized).
const MAX_VALID_LINE = 40;

const SYSTEM = 'You are a senior code auditor giving a second opinion. Assume a smaller model has already reviewed this file and missed or mis-classified something. Be direct: concrete issues only, each finding at most once, cite path:line. If you confirm the smaller model was right, say so and stop.';

const USER =
  `Audit file for: security, PII/PCI compliance, data integrity\n\n` +
  `FILE: payments/charge.js\n\`\`\`\n${BUGGY_FILE}\n\`\`\`\n\n` +
  `Output format:\n- [SEVERITY] path:line — finding (one line each)\n` +
  `Severities: BLOCKER / MAJOR / MINOR / NIT.\nStop after last finding.`;

function grade(text) {
  const L = text.toLowerCase();

  // 1 + 2: SQLi detection and severity.
  const sqliMention = /\bsql\b.*(injection|concat|interpolat)|(injection|concat|interpolat).*\bsql\b/i.test(L);
  const sqliLineRef = /:(1[3-6])\b/.test(text); // the SQLi straddles lines 14-16
  const catches_sqli = sqliMention || (sqliLineRef && /(injection|sanitiz|parameteriz|prepared)/i.test(L));

  // Find the line in the response that mentions SQL/injection and grab its severity tag.
  // Accept both `[BLOCKER]` and `**BLOCKER**` conventions — models use either.
  const sevRe = (tag) => new RegExp(`(\\[\\s*${tag}\\s*\\]|\\*\\*\\s*${tag}\\s*\\*\\*)`, 'i');
  const sqliLine = text.split('\n').find(l => /(sql|injection|parameteriz|concat|sanitiz)/i.test(l));
  const sqli_is_blocker = !!sqliLine && sevRe('BLOCKER').test(sqliLine);

  // 3 + 4: PII/logging detection and severity.
  const piiMention =
    /(log|logger|logg)/i.test(L) &&
    /(card|pan|token|pci|pii|sensitiv|plaintext|redact|mask|scrub)/i.test(L);
  const piiLine = text.split('\n').find(l =>
    /(log|logger|logg)/i.test(l) &&
    /(card|pan|token|pci|pii|sensitiv|plaintext|redact|mask|scrub)/i.test(l)
  );
  const catches_pii_log = piiMention;
  const pii_major_or_blocker = !!piiLine && (sevRe('BLOCKER').test(piiLine) || sevRe('MAJOR').test(piiLine));

  // 5: no invented line numbers past EOF.
  const lineCites = [...text.matchAll(/:(\d+)/g)].map(m => +m[1]);
  const invented = lineCites.filter(n => n > MAX_VALID_LINE);
  const no_invented_lines = invented.length === 0;

  // 6: no repetition loop.
  const dup = dupBullets(text);
  const no_repetition_loop = dup.dup <= 1;

  return {
    catches_sqli,
    sqli_is_blocker,
    catches_pii_log,
    pii_major_or_blocker,
    no_invented_lines,
    no_repetition_loop,
    _dup: dup,
    _invented_lines: invented,
  };
}

const results = {};
for (const model of MODELS) {
  console.error(`\n=== MODEL: ${model} ===`);
  const r = await ask(model, SYSTEM, USER, 1800);
  if (!r.ok) {
    console.error(`  ERROR: ${r.error}`);
    results[model] = { error: r.error };
    continue;
  }
  const checks = grade(r.text);
  const ruleChecks = [
    'catches_sqli', 'sqli_is_blocker',
    'catches_pii_log', 'pii_major_or_blocker',
    'no_invented_lines', 'no_repetition_loop',
  ];
  const passed = ruleChecks.filter(k => checks[k]).length;
  const score = (passed / ruleChecks.length) * 5;
  console.error(
    `  ${r.dt.toFixed(1)}s  in=${r.prompt_tokens} out=${r.completion_tokens}  finish=${r.finish}  ` +
    `dup=${checks._dup.dup}/${checks._dup.total}  invented=${checks._invented_lines.length}  checks=${passed}/${ruleChecks.length}  score=${score.toFixed(1)}/5`,
  );
  for (const k of ruleChecks) {
    console.error(`    ${checks[k] ? 'PASS' : 'FAIL'}  ${k}`);
  }
  results[model] = {
    dt: r.dt, in: r.prompt_tokens, out: r.completion_tokens, finish: r.finish,
    checks, passed, score,
    text: r.text,
  };
}

const today = new Date().toISOString().slice(0, 10);
const here = path.dirname(fileURLToPath(import.meta.url));
const outFile = path.join(here, `results-deep-audit-${today}.json`);
await fs.writeFile(outFile, JSON.stringify({ fixture: 'F7-deep-audit', date: today, results }, null, 2));

console.log('\n===== F7 SUMMARY =====');
console.log(`${'model'.padEnd(36)} | SQLi  sev  | PII   sev  | invent  loop | score`);
console.log('-'.repeat(90));
for (const [m, r] of Object.entries(results)) {
  if (r.error) { console.log(`${m.padEnd(36)} | ERROR: ${r.error}`); continue; }
  const c = r.checks;
  const cell = (b) => b ? ' ✓ ' : ' ✗ ';
  console.log(
    `${m.padEnd(36)} | ${cell(c.catches_sqli)}   ${cell(c.sqli_is_blocker)}  | ${cell(c.catches_pii_log)}   ${cell(c.pii_major_or_blocker)}  |  ${cell(c.no_invented_lines)}    ${cell(c.no_repetition_loop)}  |  ${r.score.toFixed(1)}/5`
  );
}
console.log(`\nwrote: ${outFile}`);
