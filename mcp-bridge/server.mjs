#!/usr/bin/env node
// MCP bridge: exposes the home-Mac LM Studio server to Claude Code as a set
// of free "subagent" tools. See ../06-free-subagents-for-claude.md for the
// full rationale. No hardcoded host — pass LOCAL_LLM_URL in the MCP env.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { execSync } from 'node:child_process';

const LOCAL_URL = process.env.LOCAL_LLM_URL;
if (!LOCAL_URL) {
  console.error('[local-llm-bridge] FATAL: LOCAL_LLM_URL env var is required.');
  console.error('  Set it when registering the MCP server, e.g.:');
  console.error('    claude mcp add local-llm-bridge ... \\');
  console.error('      --env LOCAL_LLM_URL=http://your-server.local:1234/v1/chat/completions');
  process.exit(1);
}
const HEAVY_MODEL  = process.env.LOCAL_LLM_MODEL       || 'qwen2.5-coder-7b-instruct';
const DEEP_MODEL   = process.env.LOCAL_LLM_DEEP_MODEL  || 'qwen2.5-coder-14b-instruct';
const EMBED_MODEL  = process.env.LOCAL_EMBED_MODEL     || 'text-embedding-nomic-embed-text-v1.5';
const CAVEMAN_MODE = (process.env.CAVEMAN_MODE || 'on').toLowerCase() !== 'off';

// Semantic index dir — one JSONL per indexed repo root (sha1 of absolute path).
const INDEX_DIR = process.env.SEMANTIC_INDEX_DIR || path.join(os.homedir(), '.claude', 'semantic-index');
// Derive the embeddings URL from the chat-completions URL by swapping the path.
const EMBED_URL = LOCAL_URL.replace(/\/v1\/.*$/, '/v1/embeddings');

// Concurrency caps advertised to the orchestrator via local_capabilities.
// Grounded in 2026-04-17 probe on M3 Pro 18GB with HEAVY parallel=4:
//   - short_ask: 8 safe / 16 tolerable (p95 2.9s, 0 fails)
//   - single_file: 4 safe (matches LM Studio PARALLEL=4 slot cap)
//   - multi_file:  2 safe (KV + ctx pressure at 128K)
//   - semantic:    unlimited (no model inference)
//   - deep:        1 (14B must serialize — peak RAM with 7B = ~15GB, near cap)
const CONCURRENCY_CAPS = {
  local_ask_short:         { safe: 8,  ceiling: 16, note: 'max_tokens <= 120' },
  local_ask_long:          { safe: 4,  ceiling: 4,  note: 'max_tokens > 120'  },
  local_audit:             { safe: 4,  ceiling: 4,  note: 'single-file, HEAVY' },
  local_review:            { safe: 4,  ceiling: 4,  note: 'single-file, HEAVY' },
  local_find:              { safe: 4,  ceiling: 4,  note: 'ripgrep + HEAVY'    },
  local_summarize:         { safe: 4,  ceiling: 4,  note: 'single/multi file'  },
  local_feature_audit:     { safe: 2,  ceiling: 3,  note: 'multi-file, HEAVY'  },
  local_diff_review:       { safe: 2,  ceiling: 3,  note: 'diff size bound'    },
  local_group_commits:     { safe: 2,  ceiling: 3,  note: 'varies by range'    },
  local_semantic_search:   { safe: 64, ceiling: 64, note: 'no model inference' },
  local_deep_audit:        { safe: 1,  ceiling: 1,  note: '14B — serialize; RAM cap' },
};

// Inspired by JuliusBrussee/caveman — https://github.com/JuliusBrussee/caveman
// Output-side compression: every reply comes back terse, Claude reads fewer tokens.
const CAVEMAN_RULES = `Respond caveman style. Terse, telegraphic, no filler.
RULES:
- drop articles (the/a/an), filler (just/really/basically/actually/simply), pleasantries, hedging
- fragments OK. short synonyms. no greetings, no sign-offs, no meta
- technical substance EXACT. code blocks, file paths, URLs, numbers, identifiers, error messages UNCHANGED
- never apologize, never narrate your style
- NEVER emit literal placeholder tokens in square brackets like "[thing]", "[action]", "[loop]", "[next step]". They are shape hints for YOU, not output. If you have nothing concrete to say, stop.

EXAMPLES:
  BAD:  "The function basically just returns the value directly to the caller."
  GOOD: "fn returns value to caller."

  BAD:  "[thing] [action] [reason]"
  GOOD: "auth middleware rejects token. expiry check uses < not <=."

ACTIVE EVERY RESPONSE.`;

function composeSystem(base, { caveman = CAVEMAN_MODE } = {}) {
  return caveman ? `${CAVEMAN_RULES}\n\n${base}` : base;
}

// Strength levels for anti-loop penalties. 3-bit MoE (Qwen3-Coder) needs
// aggressive values on structured outputs; default is fine for free prose.
// Observed 2026-04-17: default penalties produced 50+ duplicate bullets on
// audit prompts. 'structured' level tested clean on same inputs.
const PENALTY_PROFILES = {
  default:    { frequency_penalty: 0.3, presence_penalty: 0.0, repetition_penalty: 1.10 },
  structured: { frequency_penalty: 1.0, presence_penalty: 0.5, repetition_penalty: 1.20 },
};

async function askLocal(system, user, {
  maxTokens = 4096,
  model = HEAVY_MODEL,
  temperature = 0.2,
  caveman = CAVEMAN_MODE,
  penalties = 'default',
  extraStop = [],
} = {}) {
  const p = PENALTY_PROFILES[penalties] || PENALTY_PROFILES.default;
  const r = await fetch(LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: composeSystem(system, { caveman }) },
        { role: 'user',   content: user },
      ],
      max_tokens: maxTokens,
      temperature,
      top_p: 0.9,
      ...p,
      // Stop tokens: bracket-placeholders from CAVEMAN_RULES examples (model
      // occasionally echoes the shape hints verbatim), plus obvious loop
      // signatures (4+ consecutive newlines — bullet-dup storms).
      stop: ['[thing]', '[action]', '[reason]', '[next step]', '[loop]', '[fix loop]', '\n\n\n\n', ...extraStop],
    }),
  });
  if (!r.ok) throw new Error(`local server ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const raw = j.choices[0].message.content ?? '';
  return postProcess(stripThink(raw));
}

// Qwen3 emits <think>...</think> reasoning before the answer. Claude should
// only see the final answer. Handle: no think block, closed block, unclosed
// block (truncation mid-think).
function stripThink(s) {
  const close = s.lastIndexOf('</think>');
  if (close >= 0) return s.slice(close + 8);
  const open = s.indexOf('<think>');
  if (open >= 0) return s.slice(0, open); // unclosed — drop the tail
  return s;
}

// Safety net: if the model produced consecutive identical or near-identical
// bullet lines (loop escape), collapse them. Still forwards the diagnostic so
// Claude can notice and escalate (rule 4 of the routing policy).
function postProcess(s) {
  const lines = s.split('\n');
  const out = [];
  let lastBullet = null;
  let dupRun = 0;
  for (const line of lines) {
    const isBullet = /^\s*(?:[-*\d]+[.)]?\s|\[)/.test(line);
    const norm = line.trim().toLowerCase().replace(/\s+/g, ' ');
    if (isBullet && norm && norm === lastBullet) {
      dupRun++;
      if (dupRun === 1) out.push(`  [... ${dupRun} duplicate line(s) suppressed ...]`);
      else out[out.length - 1] = `  [... ${dupRun + 1} duplicate line(s) suppressed ...]`;
      continue;
    }
    dupRun = 0;
    lastBullet = isBullet ? norm : null;
    out.push(line);
  }
  return out.join('\n').trim();
}

const server = new Server(
  { name: 'local-llm-bridge', version: '0.2.0' },
  { capabilities: { tools: {} } }
);

// Cap the text we ship to HEAVY per call. 32K ctx * ~3 chars/tok = ~96 KB total
// budget, but leaving room for instructions + output. 500 KB is the raw-bytes
// ceiling we truncate at before sending; HEAVY will still tokenize internally.
const MAX_CONTEXT_BYTES = 500_000;
function capText(s) {
  return s.length > MAX_CONTEXT_BYTES
    ? s.slice(0, MAX_CONTEXT_BYTES) + '\n\n...[truncated — input exceeded 500 KB]...'
    : s;
}

// Fix G (2026-04-17 bench BUG 3): prefix every source line with a fixed-width
// number so the model doesn't have to count. Leg E showed 7B reporting bugs
// systematically ~4 lines early (counting from function body, skipping
// imports/comments); 14B drifted 1-3. With line numbers visible, the model
// reads them instead of counting, and this fix addresses 7B + 14B together.
function numberLines(content) {
  return content
    .split('\n')
    .map((l, i) => `${String(i + 1).padStart(4, ' ')}| ${l}`)
    .join('\n');
}
const LINE_NUMBER_HINT =
  'Source lines are prefixed with a 4-wide line number and a pipe (e.g. `  42| const x = 1`). ' +
  'When you cite a location, use the EXACT number shown — do not count, do not guess.';

const TOOLS = [
  {
    name: 'local_capabilities',
    description: 'Return a description of the local LLM server: which models are loaded, their context sizes, measured speeds, and which tool to use for which task. Call this ONCE at session start to understand what local tools can do. RETURNS a capabilities manifest.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'local_ask',
    description: 'Free-form prompt to the heavy local model (default Qwen2.5-Coder-7B-Instruct). Use for bulk analysis, summaries, explanations, or anything that needs real reasoning but does not need premium Claude quality. Prefer local_audit/review/find/summarize when they fit — they are purpose-built. For prose/essay/docs output, set caveman=false. RETURNS the model\'s text response.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt:      { type: 'string', description: 'The prompt to send.' },
        system:      { type: 'string', description: 'Optional system message.' },
        caveman:     { type: 'boolean', description: 'Override CAVEMAN_MODE for this call. Defaults to the server-wide setting. Set false for prose/essay/docs where fragments hurt.' },
        max_tokens:  { type: 'number',  description: 'Cap output length. Default 4096. Lower (~512-1024) reduces degenerate loops on short prompts.' },
        temperature: { type: 'number',  description: 'Sampling temperature. Default 0.2 (deterministic). Raise to 0.5-0.7 for creative prose.' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'local_audit',
    description: 'Heavy model audits a file for issues (security, performance, bugs, style). Pass absolute path + what to check. RETURNS an audit report.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        checklist: { type: 'string', description: 'What to audit for, e.g. "security vulnerabilities, SQL injection, XSS".' },
      },
      required: ['file_path', 'checklist'],
    },
  },
  {
    name: 'local_review',
    description: 'Ask the local model to review code against specific instructions. RETURNS a code review report with findings.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path:    { type: 'string' },
        instructions: { type: 'string', description: 'What the reviewer should focus on.' },
      },
      required: ['file_path', 'instructions'],
    },
  },
  {
    name: 'local_find',
    description: 'Ask the local model to find files in a directory matching a natural-language description (not just a pattern). Uses ripgrep + local reasoning. RETURNS a ranked list of file paths with one-line reasons.',
    inputSchema: {
      type: 'object',
      properties: {
        root:        { type: 'string', description: 'Directory to search.' },
        description: { type: 'string', description: 'What kind of files to find, e.g. "files that handle user authentication".' },
      },
      required: ['root', 'description'],
    },
  },
  {
    name: 'local_summarize',
    description: 'Summarize the contents of one or more files. Cheaper than pulling them into Claude\'s context. RETURNS a summary.',
    inputSchema: {
      type: 'object',
      properties: {
        file_paths: { type: 'array', items: { type: 'string' } },
        focus:      { type: 'string', description: 'Optional focus, e.g. "public API surface".' },
      },
      required: ['file_paths'],
    },
  },
  {
    name: 'local_feature_audit',
    description: 'Multi-file version of local_audit. Heavy model reads a set of related files as ONE unit and audits them against a feature spec — reports correctness gaps, missing error paths, missing tests, cross-file inconsistencies, and architectural issues. Use when auditing a feature that spans multiple files (handler + service + DB + tests). RETURNS a structured audit report with file:line references.',
    inputSchema: {
      type: 'object',
      properties: {
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths of all files that together implement the feature.',
        },
        spec: {
          type: 'string',
          description: 'What the feature is supposed to do. Can be a requirements description, a ticket body, or a one-paragraph goal.',
        },
      },
      required: ['file_paths', 'spec'],
    },
  },
  {
    name: 'local_diff_review',
    description: 'Heavy model reviews a git diff between two refs. Use for pre-PR self-review, reviewing someone else\'s branch, or post-hoc sanity check. Much cheaper than pulling each changed file into cloud context. RETURNS a review report with approve/request-changes verdict and line-referenced findings.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:         { type: 'string', description: 'Absolute path to the git repo root.' },
        ref_a:        { type: 'string', description: 'Base ref (e.g. "main", "origin/main", a commit hash).' },
        ref_b:        { type: 'string', description: 'Head ref (e.g. "HEAD", a branch name, a commit hash).' },
        instructions: { type: 'string', description: 'What the reviewer should focus on. E.g. "security issues only" or "verify error handling is consistent".' },
      },
      required: ['repo', 'ref_a', 'ref_b', 'instructions'],
    },
  },
  {
    name: 'local_group_commits',
    description: 'Heavy model clusters a range of git commits into logical PR-sized groups by theme/feature. Returns PR-ready grouping with suggested Conventional-Commits titles and commit-hash lists. Use when a branch has accumulated many commits and you want to split it into reviewable PRs, or when writing release notes. RETURNS a grouping plan.',
    inputSchema: {
      type: 'object',
      properties: {
        repo:  { type: 'string', description: 'Absolute path to the git repo root.' },
        range: { type: 'string', description: 'Git revision range, e.g. "main..HEAD", "HEAD~20..HEAD", "v1.2.0..v1.3.0".' },
      },
      required: ['repo', 'range'],
    },
  },
  {
    name: 'local_semantic_search',
    description: 'Natural-language file/chunk search across a repo using a local embedding index (nomic-embed). Beats local_find on large codebases where keyword prefilter misses (e.g. "code that debounces user input" when the file says "schedule"). Prerequisite: run `node scripts/semantic-index.mjs <root>` once to build the index. Zero HEAVY tokens burned — pure embedding similarity. RETURNS a ranked list of path:start-end chunks with a snippet.',
    inputSchema: {
      type: 'object',
      properties: {
        root:  { type: 'string', description: 'Absolute path to the indexed repo root.' },
        query: { type: 'string', description: 'Natural-language description of what to find.' },
        top_k: { type: 'number', description: 'Max results to return. Default 10.' },
      },
      required: ['root', 'query'],
    },
  },
  {
    name: 'local_deep_audit',
    description: 'Second-opinion audit using the larger DEEP model (Qwen2.5-Coder-14B, ~8.3 GB JIT). Use ONLY as a middle tier before escalating to cloud Claude when local_audit / local_review / local_feature_audit gave a weak or rule-4 result. First call pays ~8s JIT load; subsequent calls fast within LM Studio TTL. SERIALIZE — safe concurrency is 1 (see local_capabilities.concurrency). RETURNS an audit report.',
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        checklist: { type: 'string', description: 'What to audit for.' },
      },
      required: ['file_path', 'checklist'],
    },
  },
];

// --- Semantic search helpers ---------------------------------------------
// In-memory cache keyed by abs-root -> array of {path, start, end, text, e:Float32Array}.
const INDEX_CACHE = new Map();

function indexKey(absRoot) {
  return crypto.createHash('sha1').update(absRoot).digest('hex').slice(0, 16);
}

async function loadIndex(absRoot) {
  const key = indexKey(absRoot);
  const jsonl = path.join(INDEX_DIR, `${key}.jsonl`);
  const st = await fs.stat(jsonl);
  const jsonlMtimeMs = st.mtimeMs;

  const cached = INDEX_CACHE.get(absRoot);
  if (cached && cached.jsonlMtimeMs === jsonlMtimeMs) return cached;

  const data = await fs.readFile(jsonl, 'utf8');
  const chunks = [];
  for (const line of data.split('\n')) {
    if (!line) continue;
    const o = JSON.parse(line);
    // Float32Array is ~4x smaller than boxed numbers and cosine is a tight loop.
    chunks.push({ path: o.path, start: o.start, end: o.end, text: o.text, e: Float32Array.from(o.e) });
  }
  const entry = { chunks, jsonlMtimeMs, jsonlPath: jsonl };
  INDEX_CACHE.set(absRoot, entry);
  return entry;
}

// Staleness check. Compares JSONL mtime against newest mtime of git-tracked
// files in <absRoot>. If any tracked file is newer, the index was built before
// that file's last edit and search results may point at wrong line ranges.
// Returns a warning string to prepend to the caller's output, or null if fresh.
// Skipped silently if the root is not a git repo (hand-walking arbitrary dirs
// per-query is too slow). Env SEMANTIC_INDEX_SKIP_FRESHNESS=1 opts out.
async function checkIndexStale(absRoot, jsonlMtimeMs) {
  if (process.env.SEMANTIC_INDEX_SKIP_FRESHNESS === '1') return null;
  let files;
  try {
    const raw = execSync('git ls-files -z', {
      cwd: absRoot, encoding: 'buffer', maxBuffer: 50 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
    });
    files = raw.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return null; // not a git repo — skip check
  }
  let newestMs = 0;
  let newestPath = '';
  for (const rel of files) {
    try {
      const s = await fs.stat(path.join(absRoot, rel));
      if (s.mtimeMs > newestMs) { newestMs = s.mtimeMs; newestPath = rel; }
    } catch { /* deleted-but-not-committed; ignore */ }
  }
  if (newestMs > jsonlMtimeMs) {
    const ageSec = Math.round((newestMs - jsonlMtimeMs) / 1000);
    return `[STALE INDEX: ${newestPath} is ${ageSec}s newer than the index. ` +
           `Results may point at wrong line ranges. ` +
           `Rebuild: node scripts/semantic-index.mjs ${absRoot} --rebuild]`;
  }
  return null;
}

async function embedQuery(q) {
  const r = await fetch(EMBED_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: q }),
  });
  if (!r.ok) throw new Error(`embed ${r.status}: ${(await r.text()).slice(0,200)}`);
  const j = await r.json();
  return Float32Array.from(j.data[0].embedding);
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a } = req.params;
  try {
    let out;
    switch (name) {
      case 'local_capabilities':
        out = JSON.stringify({
          server: LOCAL_URL,
          caveman_mode: CAVEMAN_MODE,
          heavy_model: {
            name: HEAVY_MODEL,
            best_for: [
              'code review', 'file audit', 'refactor suggestions',
              'multi-file summarization', 'architectural analysis',
              'bulk explain', 'natural-language file finding',
              'multi-file feature audits', 'git diff reviews',
              'clustering commits into PR-sized groups',
            ],
          },
          deep_model: {
            name: DEEP_MODEL,
            best_for: ['rule-4 escalation before cloud', 'second opinion when HEAVY gave a weak reply'],
            note: 'JIT-loaded by LM Studio on first local_deep_audit call (~8s). SERIALIZE — concurrency 1.',
          },
          concurrency: CONCURRENCY_CAPS,
          concurrency_hint: 'Orchestrator MUST respect safe values when fanning out local_* calls in parallel (e.g. per-issue swarm). Exceeding safe is tolerated up to ceiling; above ceiling queueing and latency collapse. local_deep_audit MUST be serialized.',
          tools: {
            local_ask:            'HEAVY — free-form prompt, reasoning/analysis',
            local_audit:          'HEAVY — security/bug audit of a SINGLE file',
            local_review:         'HEAVY — code review of a SINGLE file',
            local_find:           'HEAVY — natural-language file finding with ripgrep prefilter',
            local_summarize:      'HEAVY — summarize one or more files',
            local_feature_audit:  'HEAVY — multi-file audit of a feature vs spec',
            local_diff_review:    'HEAVY — review a git diff between two refs',
            local_group_commits:  'HEAVY — cluster commits into PR-sized groups by theme',
            local_semantic_search:'EMBED — nomic-embed similarity over a pre-built index; zero HEAVY tokens. Requires `node scripts/semantic-index.mjs <root>` once.',
            local_deep_audit:     'DEEP (14B) — second-opinion audit when HEAVY was weak/rule-4. Serialize.',
          },
          routing_hints: [
            'File review / audit / feature audit / diff review / commit grouping -> use the purpose-built tool above.',
            'Free-form classification or short-answer questions -> local_ask with a concise system prompt.',
            'Architectural decisions / tricky debugging / novel design -> keep on cloud Claude.',
            'Code generation for critical prod code -> keep on cloud Claude. Local for drafts/refactors.',
          ],
        }, null, 2);
        break;

      case 'local_ask': {
        const opts = {};
        if (typeof a.caveman     === 'boolean') opts.caveman     = a.caveman;
        if (typeof a.max_tokens  === 'number')  opts.maxTokens   = a.max_tokens;
        if (typeof a.temperature === 'number')  opts.temperature = a.temperature;
        const defaultSys = opts.caveman === false
          ? 'You are a careful, accurate assistant. Write in full prose with clear paragraphs.'
          : 'You are a concise, accurate assistant.';
        out = await askLocal(a.system || defaultSys, a.prompt, opts);
        break;
      }

      case 'local_audit': {
        const code = await fs.readFile(a.file_path, 'utf8');
        const numbered = numberLines(code);
        out = await askLocal(
          `You are a careful code auditor. Report concrete issues only. No filler. Each finding appears at most once.\n\n${LINE_NUMBER_HINT}`,
          `Audit file for: ${a.checklist}\n\nFILE: ${a.file_path}\n\`\`\`\n${numbered}\n\`\`\`\n\n` +
          `Output format:\n- [SEVERITY] path:line — finding (one line each)\n` +
          `Severities: BLOCKER / MAJOR / MINOR / NIT.\nStop after last finding.`,
          { caveman: false, penalties: 'structured', maxTokens: 1200 },
        );
        break;
      }

      case 'local_review': {
        const code = await fs.readFile(a.file_path, 'utf8');
        const numbered = numberLines(code);
        out = await askLocal(
          `You are an experienced code reviewer. Be direct. Approve or request changes with reasons. Each finding appears at most once.\n\n${LINE_NUMBER_HINT}`,
          `Review file per these instructions:\n\n${a.instructions}\n\nFILE: ${a.file_path}\n\`\`\`\n${numbered}\n\`\`\`\n\n` +
          `Output format:\nVERDICT: APPROVE | REQUEST CHANGES\nThen list findings:\n- [SEVERITY] path:line — finding`,
          { caveman: false, penalties: 'structured', maxTokens: 1500 },
        );
        break;
      }

      case 'local_find': {
        const grep = execSync(
          `cd ${JSON.stringify(a.root)} && (rg --files 2>/dev/null || find . -type f) | head -500`,
          { encoding: 'utf8' },
        );
        out = await askLocal(
          'You rank candidate file paths for relevance. Return most relevant first with one-line reasons. No duplicates.',
          `Find files matching: ${a.description}\n\nCandidates (first 500 files in ${a.root}):\n${grep}\n\n` +
          `Output format:\npath — one-line reason\nList at most 15 paths, best first.`,
          { caveman: false, penalties: 'structured', maxTokens: 800 },
        );
        break;
      }

      case 'local_summarize': {
        const chunks = await Promise.all(
          a.file_paths.map(async (p) => `=== ${p} ===\n${await fs.readFile(p, 'utf8')}`),
        );
        out = await askLocal(
          'You produce concise, structured summaries. No filler.',
          capText(`Summarize the following files${a.focus ? ` focusing on ${a.focus}` : ''}:\n\n${chunks.join('\n\n')}`),
          { maxTokens: 1500 },
        );
        break;
      }

      case 'local_feature_audit': {
        // Fix C (2026-04-17 bench BUG 2): cap at 3 files server-side. Leg A
        // showed loop pathology + invented findings when called with 6 real
        // files; direct-call path clean at the same input. Force callers to
        // split their request instead of silently degrading output quality.
        if (Array.isArray(a.file_paths) && a.file_paths.length > 3) {
          out = JSON.stringify({
            ok: false,
            reason: 'feature_audit limited to 3 files per call — split your request into ≤3-file batches and merge results',
            file_count: a.file_paths.length,
          }, null, 2);
          break;
        }
        // Read files sequentially so we can stop at the budget instead of
        // hammering disk for files we won't ship. Cap per-file at 200 KB so
        // a single huge file can't starve the rest of the set.
        const chunks = [];
        let total = 0;
        for (const p of a.file_paths) {
          if (total >= MAX_CONTEXT_BYTES) {
            chunks.push(`=== ${p} (skipped — context budget exhausted) ===`);
            continue;
          }
          let content;
          try {
            content = await fs.readFile(p, 'utf8');
          } catch (e) {
            chunks.push(`=== ${p} (read error: ${e.message}) ===`);
            continue;
          }
          const perFileCap = 200_000;
          const trimmed = content.length > perFileCap
            ? content.slice(0, perFileCap) + '\n...[file truncated at 200 KB]...'
            : content;
          chunks.push(`=== ${p} ===\n${numberLines(trimmed)}`);
          total += trimmed.length;
        }
        out = await askLocal(
          `You audit feature implementations across multiple files as a single unit. Report concrete findings with file:line references. Be direct — no filler, no restating the spec. Each finding appears at most once.\n\n${LINE_NUMBER_HINT}`,
          capText(
            `FEATURE SPEC:\n${a.spec}\n\n` +
            `Audit the files below AS A SET for:\n` +
            `- correctness vs the spec (missing behavior, wrong behavior)\n` +
            `- cross-file inconsistencies (mismatched types, contracts, names)\n` +
            `- missing error paths and edge cases\n` +
            `- missing or weak tests\n` +
            `- architectural issues (misplaced logic, leaky abstractions)\n\n` +
            `Output format:\n` +
            `- [SEVERITY] path:line — finding (one line)\n` +
            `Severities: BLOCKER / MAJOR / MINOR / NIT.\n` +
            `Stop after last finding.\n\n` +
            `FILES:\n\n${chunks.join('\n\n')}`,
          ),
          { caveman: false, penalties: 'structured', maxTokens: 2000 },
        );
        break;
      }

      case 'local_diff_review': {
        // Quote refs so branch names with slashes (feature/x) or special chars
        // don't break the shell. `git diff A..B` means A-as-base, B-as-head.
        const diff = execSync(
          `git diff ${JSON.stringify(a.ref_a)}..${JSON.stringify(a.ref_b)}`,
          { cwd: a.repo, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
        );
        if (!diff.trim()) {
          out = `No diff between ${a.ref_a} and ${a.ref_b}.`;
          break;
        }
        out = await askLocal(
          'You are an experienced code reviewer. Read the diff carefully. Be direct: approve or request changes with concrete reasons. Reference file:line from the diff hunks. Each finding appears at most once.',
          capText(
            `Review this git diff per these instructions:\n\n${a.instructions}\n\n` +
            `Output format:\n` +
            `VERDICT: APPROVE | REQUEST CHANGES\n` +
            `Then a list of findings:\n- [SEVERITY] path:line — finding\n` +
            `Stop after last finding.\n\n` +
            `DIFF (${a.ref_a}..${a.ref_b}):\n\`\`\`diff\n${diff}\n\`\`\``,
          ),
          { caveman: false, penalties: 'structured', maxTokens: 2000 },
        );
        break;
      }

      case 'local_group_commits': {
        // `--name-only` appends changed-file list after each commit.
        // Format: hash | subject | author | date, then a blank line, then files.
        const log = execSync(
          `git log --date=short --name-only --format='===COMMIT=== %h | %s | %an | %ad%n%b' ${JSON.stringify(a.range)}`,
          { cwd: a.repo, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
        );
        if (!log.trim()) {
          out = `No commits in range ${a.range}.`;
          break;
        }
        out = await askLocal(
          'You cluster git commits into logical PR-sized groups by theme. Use Conventional Commits style for group titles (feat:, fix:, refactor:, chore:, docs:, test:). Be direct — no filler. Each commit appears in exactly one group.',
          capText(
            `Group these commits by theme/feature. For each group, output:\n` +
            `- suggested PR title (Conventional Commits style)\n` +
            `- 1-2 sentence description of the group's purpose\n` +
            `- list of included commit hashes (short form)\n\n` +
            `Rules:\n` +
            `- don't force unrelated commits together\n` +
            `- if a commit is truly isolated, put it alone\n` +
            `- use a "Miscellaneous" bucket only as last resort\n` +
            `- order groups by logical merge order (dependencies first)\n` +
            `- do NOT repeat groups. stop after last group.\n\n` +
            `COMMITS (${a.range}):\n\n${log}`,
          ),
          { caveman: false, penalties: 'structured', maxTokens: 2000 },
        );
        break;
      }

      case 'local_semantic_search': {
        const absRoot = path.resolve(a.root);
        const topK = Math.max(1, Math.min(50, a.top_k ?? 10));
        let entry;
        try {
          entry = await loadIndex(absRoot);
        } catch (e) {
          if (e.code === 'ENOENT') {
            out = `No semantic index for ${absRoot}. Build it once with:\n` +
                  `  node scripts/semantic-index.mjs ${absRoot}\n` +
                  `(runs against the local nomic-embed model; no cloud/quota cost.)`;
            break;
          }
          throw e;
        }
        const { chunks, jsonlMtimeMs } = entry;
        const staleWarning = await checkIndexStale(absRoot, jsonlMtimeMs);
        const qv = await embedQuery(a.query);
        const scored = new Array(chunks.length);
        for (let i = 0; i < chunks.length; i++) {
          scored[i] = { i, s: cosine(qv, chunks[i].e) };
        }
        scored.sort((x, y) => y.s - x.s);
        const top = scored.slice(0, topK).map(({ i, s }) => {
          const c = chunks[i];
          const snippet = c.text.replace(/\s+/g, ' ').slice(0, 120);
          return `- [${s.toFixed(3)}] ${c.path}:${c.start}-${c.end} — ${snippet}`;
        });
        const header = staleWarning
          ? `${staleWarning}\n\nTop ${top.length} matches for: ${a.query}`
          : `Top ${top.length} matches for: ${a.query}`;
        out = `${header}\n\n${top.join('\n')}`;
        break;
      }

      case 'local_deep_audit': {
        const code = await fs.readFile(a.file_path, 'utf8');
        const numbered = numberLines(code);
        out = await askLocal(
          `You are a senior code auditor giving a second opinion. Assume a smaller model has already reviewed this file and missed or mis-classified something. Be direct: concrete issues only, each finding at most once, cite path:line. If you confirm the smaller model was right, say so and stop.\n\n${LINE_NUMBER_HINT}`,
          `Audit file for: ${a.checklist}\n\nFILE: ${a.file_path}\n\`\`\`\n${numbered}\n\`\`\`\n\n` +
          `Output format:\n- [SEVERITY] path:line — finding (one line each)\n` +
          `Severities: BLOCKER / MAJOR / MINOR / NIT.\nStop after last finding.`,
          { model: DEEP_MODEL, caveman: false, penalties: 'structured', maxTokens: 1800 },
        );
        break;
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
    return { content: [{ type: 'text', text: out }] };
  } catch (err) {
    return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
