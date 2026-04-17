#!/usr/bin/env node
// Extended head-to-head bench: 6 fixtures covering structured-long,
// free-form, classify, group_commits, feature_audit, find.
// Scores reliability / correctness / efficiency per task class.
import fs from 'node:fs/promises';

const URL = 'http://127.0.0.1:1234/v1/chat/completions';
const MODELS = process.argv.slice(2);
if (!MODELS.length) {
  console.error('Usage: bench2.mjs <model-id> [<model-id>...]');
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
  let r;
  try {
    r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, temperature: 0.2, top_p: 0.9,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user',   content: user  },
        ],
        ...PENALTIES,
        stop: ['[thing]', '[action]', '[reason]', '[next step]', '[loop]', '\n\n\n\n'],
      }),
    });
  } catch (e) {
    return { ok: false, error: `fetch_err: ${e.message}`, dt: (Date.now()-t0)/1000 };
  }
  const dt = (Date.now() - t0) / 1000;
  if (!r.ok) {
    return { ok: false, error: `${r.status}: ${(await r.text()).slice(0,200)}`, dt };
  }
  const j = await r.json();
  const msg = j.choices[0].message;
  let raw = msg.content ?? '';
  if (!raw.trim() && msg.reasoning) raw = `[reasoning-channel]\n${msg.reasoning}`;
  const text = stripThink(raw).trim();
  return {
    ok: true,
    text,
    dt,
    prompt_tokens: j.usage?.prompt_tokens,
    completion_tokens: j.usage?.completion_tokens,
    finish: j.choices[0].finish_reason,
  };
}

// --- Fixtures -------------------------------------------------------------

const AUTH_FILE = `\
function authenticateUser(req, res) {
  const token = req.headers.authorization;
  if (!token) return res.status(401).json({error: 'no token'});
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({error: 'invalid'});
  }
}

function getUser(req, res) {
  const id = req.query.id;
  db.query("SELECT * FROM users WHERE id = " + id, (err, rows) => {
    if (err) return res.status(500).send(err.message);
    res.json(rows[0]);
  });
}

function updateUser(req, res) {
  const id = req.params.id;
  const data = req.body;
  db.query("UPDATE users SET name=? WHERE id=?", [data.name, id], (err) => {
    if (err) return res.status(500).send(err);
    res.json({ok:true});
  });
}

function deleteUser(req, res) {
  const id = req.params.id;
  db.query("DELETE FROM users WHERE id=" + id);
  res.json({ok:true});
}
`;

const SUMMARY_FILE = `\
// rate-limiter.js — sliding window rate limiter.
const WINDOW_MS = 60_000;
const MAX_REQ   = 100;

const buckets = new Map();

export function allow(key) {
  const now = Date.now();
  const arr = buckets.get(key) || [];
  while (arr.length && now - arr[0] > WINDOW_MS) arr.shift();
  if (arr.length >= MAX_REQ) return false;
  arr.push(now);
  buckets.set(key, arr);
  return true;
}

export function remaining(key) {
  const arr = buckets.get(key) || [];
  return Math.max(0, MAX_REQ - arr.length);
}

export function reset(key) { buckets.delete(key); }
`;

const COMMIT_LIST = `\
a1b2c3d feat(auth): add JWT middleware
d4e5f6a fix(auth): handle missing authorization header
b7c8d9e test(auth): add JWT verify unit tests
f0a1b2c refactor(auth): extract token parser
3d4e5f6 feat(auth): support refresh tokens
7a8b9c0 fix(billing): correct tax calculation for EU
d1e2f3a feat(billing): add stripe webhook handler
b4c5d6e test(billing): stripe webhook signature
f7a8b9c docs(billing): explain webhook retry policy
1c2d3e4 fix(billing): idempotency key on double-charge
5f6a7b8 feat(ui): dark mode toggle in header
9c0d1e2 style(ui): tune dark mode colors
3f4a5b6 fix(ui): sidebar shift on dark-mode toggle
7c8d9e0 feat(ui): keyboard shortcut for dark mode
1a2b3c4 chore(deps): bump react 18.2 -> 18.3
5d6e7f8 chore(deps): bump vite 5.1 -> 5.2
9a0b1c2 chore(deps): bump typescript 5.3 -> 5.4
3e4f5a6 chore(ci): cache node_modules in CI
7b8c9d0 chore(ci): add lint step to pull-request workflow
1f2a3b4 perf(db): add index on users.email
5c6d7e8 perf(db): batch inserts in audit log
9e0f1a2 fix(db): connection pool leak on timeout
3a4b5c6 docs(readme): update install instructions
7d8e9f0 docs(contrib): add CONTRIBUTING.md
1b2c3d4 fix(search): escape regex metachars in query
5e6f7a8 feat(search): fuzzy matching option
9b0c1d2 fix(api): 429 response missing Retry-After header
3c4d5e6 feat(api): add rate-limit headers to all responses
7f8a9b0 test(api): rate-limit header integration test
`;

const FEATURE_HANDLER = `\
// handlers/order.js
import { createOrder, getOrder } from '../services/order.js';

export async function postOrder(req, res) {
  const { userId, items } = req.body;
  const order = await createOrder(userId, items);
  res.status(201).json(order);
}

export async function fetchOrder(req, res) {
  const o = await getOrder(req.params.id);
  res.json(o);
}
`;

const FEATURE_SERVICE = `\
// services/order.js
import { db } from '../db/client.js';

export async function createOrder(userId, items) {
  const total = items.reduce((s, i) => s + i.price * i.qty, 0);
  const id = crypto.randomUUID();
  await db.insert('orders', { id, userId, items, total, status: 'pending' });
  return { id, total };
}

export async function getOrder(id) {
  return db.get('orders', id);
}
`;

const FEATURE_DB = `\
// db/client.js
export const db = {
  insert(table, row) { /* ... */ },
  get(table, id) { /* returns row or null */ },
};
`;

const FEATURE_TEST = `\
// tests/order.test.js
import { createOrder, getOrder } from '../services/order.js';

test('createOrder computes total', async () => {
  const o = await createOrder('u1', [{price: 10, qty: 2}, {price: 5, qty: 1}]);
  expect(o.total).toBe(25);
});

test('getOrder returns null for unknown id', async () => {
  const o = await getOrder('nonexistent');
  expect(o).toBeNull();
});
`;

const FEATURE_SPEC = `\
Feature spec: POST /orders, GET /orders/:id
- Auth required on both endpoints (missing in handler)
- POST body: { userId, items:[{sku,price,qty}] }
- Response 201 { id, total, status }
- GET /orders/:id returns 404 if not found (handler does not 404)
- Validation: items length >= 1 (not enforced)
- Idempotency key header honored (not implemented)
`;

const FIND_TREE = `\
Repository tree (claude-local-llm-setup):
  mcp-bridge/server.mjs                   # Node MCP bridge, 2400 LOC, dispatches tools
  mcp-bridge/CLAUDE-routing-policy.md     # Routing rules
  scripts/server.sh                       # Server-side install
  scripts/client.sh                       # Client-side bridge setup
  scripts/recommended-load.sh             # Loads the HEAVY model
  scripts/find_parallel.py                # Hardware probe for parallel model fit
  scripts/install-launchagent.sh          # Boot-time launch
  scripts/benchmark.sh                    # Quick sanity benchmark
  docs/01-architecture.md                 # Bridge architecture
  docs/02-routing-policy.md               # Policy rationale
  docs/03-models.md                       # Model choice rationale
  docs/04-fallback-gpt-oss-20b.md         # GPT-OSS fallback doc
  docs/05-gemma4-plumbing.md              # Gemma 4 MLX broken
  docs/06-caveman-mode.md                 # Output compression
  tests/bench_fixtures/auth.js            # Audit fixture
  tests/bench_fixtures/rate-limiter.js    # Summarize fixture
  README.md
`;

// --- Scoring helpers ------------------------------------------------------

function dupBulletCount(s) {
  const lines = s.split('\n').map(l => l.trim().toLowerCase()).filter(Boolean);
  const bullets = lines.filter(l => /^(?:[-*\d]+[.)]?\s|\[)/.test(l));
  const seen = new Map();
  let dup = 0;
  for (const b of bullets) {
    const k = b.replace(/\s+/g, ' ');
    seen.set(k, (seen.get(k) || 0) + 1);
    if (seen.get(k) > 1) dup++;
  }
  return { total_bullets: bullets.length, dup_bullets: dup, unique: seen.size };
}

// --- Tests ---------------------------------------------------------------

const TESTS = [
  {
    name: 'F1-audit-auth',
    system: 'You are a careful code auditor. Report concrete issues only. No filler. Each finding appears at most once.',
    user:
      `Audit file for: security vulnerabilities, SQL injection, missing auth checks\n\n` +
      `FILE: auth.js\n\`\`\`\n${AUTH_FILE}\n\`\`\`\n\n` +
      `Output format:\n- [SEVERITY] path:line — finding (one line each)\n` +
      `Severities: BLOCKER / MAJOR / MINOR / NIT.\nStop after last finding.`,
    maxTokens: 1200,
    weight: 3,
    checks: (t) => {
      const L = t.toLowerCase();
      return {
        catches_getuser_sqli: /getuser|line\s*1[5-8]/i.test(t) && /sql\s*inject/i.test(L),
        catches_deleteuser_sqli: /deleteuser|delete.*user/i.test(t) && /(sql\s*inject|concat)/i.test(L),
        catches_deleteuser_noauth: /(no\s*auth|missing\s*auth|unauthoriz|no.*check)/i.test(L) && /delete/i.test(L),
        avoids_updateuser_false_positive: !/updateUser[^\n]*sql\s*inject/i.test(t),
      };
    },
  },
  {
    name: 'F2-summarize-ratelimiter',
    system: 'You produce concise, structured summaries. No filler.',
    user: `Summarize the following file focusing on behavior and public API:\n\n=== rate-limiter.js ===\n${SUMMARY_FILE}`,
    maxTokens: 800,
    weight: 2,
    checks: (t) => {
      const L = t.toLowerCase();
      return {
        mentions_sliding_window: /sliding|window/.test(L),
        mentions_max_req_or_100: /(max.*req|100)/.test(L),
        mentions_allow_api: /allow/.test(L),
        mentions_remaining_api: /remaining/.test(L),
        mentions_reset_api: /reset/.test(L),
      };
    },
  },
  {
    name: 'F3-classify-sqli',
    system: 'You are a concise, accurate classifier. Answer with ONE WORD.',
    user: `Is this line of code a security bug? Answer only YES or NO.\n\ndb.query("SELECT * FROM users WHERE id = " + req.query.id)`,
    maxTokens: 200,
    weight: 1,
    checks: (t) => {
      const first = t.trim().split(/[\s.,!?]/)[0].toUpperCase();
      return {
        one_word_answer: /^(YES|NO)$/i.test(first),
        correct_yes: first === 'YES',
      };
    },
  },
  {
    name: 'F4-group-commits',
    system: 'You cluster commits into PR-sized groups. Each group has a short title and a bullet list of commit hashes. No filler. No "Miscellaneous".',
    user:
      `Group the following ${COMMIT_LIST.split('\n').length - 1} commits into coherent PR-sized groups by topic.\n\n` +
      `Format:\n## <Group title>\n- <hash> <subject>\n\n` +
      `Commits:\n${COMMIT_LIST}`,
    maxTokens: 2000,
    weight: 2,
    checks: (t) => {
      const L = t.toLowerCase();
      const groupHeaders = (t.match(/^##\s+/gm) || []).length;
      return {
        at_least_3_groups: groupHeaders >= 3,
        at_most_10_groups: groupHeaders <= 10,
        no_miscellaneous: !/miscellaneous|other\s*$|^##\s*other/im.test(t),
        mentions_auth_group: /\bauth\b/i.test(t),
        mentions_billing_group: /\bbilling\b/i.test(t),
        mentions_ui_group: /\bui\b|dark.?mode/i.test(t),
        mentions_deps_group: /\bdeps\b|dependenc/i.test(t),
      };
    },
  },
  {
    name: 'F5-feature-audit',
    system: 'You audit a feature across multiple files against a spec. Report only concrete deviations. No filler. Each finding at most once.',
    user:
      `Audit this feature against the spec. Report deviations as bulleted findings.\n\n` +
      `=== SPEC ===\n${FEATURE_SPEC}\n\n` +
      `=== FILES ===\n--- handlers/order.js ---\n${FEATURE_HANDLER}\n` +
      `--- services/order.js ---\n${FEATURE_SERVICE}\n` +
      `--- db/client.js ---\n${FEATURE_DB}\n` +
      `--- tests/order.test.js ---\n${FEATURE_TEST}\n\n` +
      `Output format:\n- [SEVERITY] path:line — finding\n` +
      `Severities: BLOCKER / MAJOR / MINOR / NIT.`,
    maxTokens: 2000,
    weight: 3,
    checks: (t) => {
      const L = t.toLowerCase();
      return {
        catches_missing_auth: /(missing\s*auth|no\s*auth|unauthorized|auth.*required|auth.*not)/i.test(L),
        catches_missing_404: /(404|not\s*found).*not.*(handl|implement|return)|(does\s*not|missing).*(404|not\s*found)/i.test(L) || /handler.*does.*not.*404/i.test(L),
        catches_missing_validation: /(validat|items.*length|items.*empty|no\s*validation)/i.test(L),
        catches_missing_idempotency: /idempoten/i.test(L),
        references_handler_or_service: /handler|service|order\.js/i.test(L),
      };
    },
  },
  {
    name: 'F6-find-auth',
    system: 'You find the most relevant files. Return a ranked list, at most 10 entries, most relevant first. Format: path — one-line reason.',
    user:
      `Task: Find files related to "authentication logic and routing policy" in the following repository.\n\n` +
      `${FIND_TREE}\n\n` +
      `Output format:\n- <path> — <why relevant>\n` +
      `Rank most relevant first. Do not exceed 10 entries.`,
    maxTokens: 800,
    weight: 1,
    checks: (t) => {
      const L = t.toLowerCase();
      const entries = (t.match(/^[-*]\s+\S/gm) || []).length;
      return {
        has_list: entries >= 1,
        at_most_10: entries <= 10,
        mentions_routing_policy: /routing-policy|routing.*policy/i.test(L),
        mentions_bridge_or_server_mjs: /server\.mjs|mcp-bridge/i.test(L),
        top1_is_auth_relevant: /^[-*]\s+(.*(routing|server\.mjs|claude-routing|bridge))/im.test(t),
      };
    },
  },
];

// --- Run ------------------------------------------------------------------

const results = {};
for (const model of MODELS) {
  console.error(`\n=== MODEL: ${model} ===`);
  results[model] = [];
  for (const t of TESTS) {
    process.stderr.write(`  ${t.name} ...`);
    const r = await ask(model, t.system, t.user, t.maxTokens);
    if (!r.ok) {
      console.error(` ERROR: ${r.error}`);
      results[model].push({ name: t.name, error: r.error, weight: t.weight });
      continue;
    }
    const dup = dupBulletCount(r.text);
    const checks = t.checks ? t.checks(r.text) : {};
    const passed = Object.values(checks).filter(Boolean).length;
    const total  = Object.keys(checks).length;
    const score  = total ? (passed / total) * 5 : 0; // 0-5 per fixture
    console.error(
      ` ${r.dt.toFixed(1)}s  in=${r.prompt_tokens} out=${r.completion_tokens}` +
      `  dups=${dup.dup_bullets}/${dup.total_bullets}  checks=${passed}/${total}  score=${score.toFixed(1)}`,
    );
    results[model].push({
      name: t.name,
      weight: t.weight,
      dt: r.dt,
      in: r.prompt_tokens,
      out: r.completion_tokens,
      finish: r.finish,
      dup_bullets: dup.dup_bullets,
      total_bullets: dup.total_bullets,
      checks,
      checks_pass: passed,
      checks_total: total,
      score,
      weighted_score: score * t.weight,
      text: r.text,
    });
  }
}

await fs.writeFile('/tmp/bench2_results.json', JSON.stringify(results, null, 2));

console.log('\n\n===== SUMMARY (6 fixtures, weighted) =====');
console.log(`${'model'.padEnd(36)} | ${'F1'.padEnd(4)} ${'F2'.padEnd(4)} ${'F3'.padEnd(4)} ${'F4'.padEnd(4)} ${'F5'.padEnd(4)} ${'F6'.padEnd(4)} | total/60 | total-time`);
console.log('-'.repeat(110));
for (const [model, arr] of Object.entries(results)) {
  const cells = arr.map(r => r.error ? 'ERR' : r.weighted_score.toFixed(1));
  const total = arr.reduce((s, r) => s + (r.error ? 0 : r.weighted_score), 0);
  const time  = arr.reduce((s, r) => s + (r.error ? 0 : r.dt), 0);
  console.log(
    `${model.padEnd(36)} | ${cells.map(c => c.padEnd(4)).join(' ')} | ${total.toFixed(1).padStart(5)}/60  | ${time.toFixed(1)}s`
  );
}
console.log('\nFull outputs: /tmp/bench2_results.json');
