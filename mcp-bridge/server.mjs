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
import { execSync } from 'node:child_process';

const LOCAL_URL = process.env.LOCAL_LLM_URL;
if (!LOCAL_URL) {
  console.error('[local-llm-bridge] FATAL: LOCAL_LLM_URL env var is required.');
  console.error('  Set it when registering the MCP server, e.g.:');
  console.error('    claude mcp add local-llm-bridge ... \\');
  console.error('      --env LOCAL_LLM_URL=http://your-server.local:1234/v1/chat/completions');
  process.exit(1);
}
const HEAVY_MODEL  = process.env.LOCAL_LLM_MODEL  || 'qwen3-coder-30b-a3b-instruct';
const CAVEMAN_MODE = (process.env.CAVEMAN_MODE || 'on').toLowerCase() !== 'off';

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

async function askLocal(system, user, { maxTokens = 4096, model = HEAVY_MODEL, temperature = 0.2, caveman = CAVEMAN_MODE } = {}) {
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
      // Anti-loop: Qwen3 + caveman fragments + low temp degenerates into
      // duplicate bullet blocks when max_tokens budget overhangs the real
      // answer. Penalty fields keep backend from re-emitting same n-grams.
      // repetition_penalty = llama.cpp-native; frequency/presence =
      // OpenAI-standard. Send both so any LM Studio version honors one.
      top_p: 0.9,
      frequency_penalty: 0.3,
      presence_penalty: 0,
      repetition_penalty: 1.1,
      // Belt-and-braces: if model starts emitting literal placeholder
      // tokens from CAVEMAN_RULES examples ("[thing]", "[loop]", etc),
      // cut it off immediately. Observed 2026-04-16 on short prompts —
      // model degenerates into repeating the bracket template instead
      // of the compressed answer.
      stop: ['[thing]', '[action]', '[reason]', '[next step]', '[loop]', '[fix loop]'],
    }),
  });
  if (!r.ok) throw new Error(`local server ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const raw = j.choices[0].message.content;
  // Qwen3 emits <think>...</think> reasoning before the answer. Claude should only
  // see the final answer — strip the think block. (Keep thinking ON for accuracy;
  // we just don't forward the reasoning tokens upstream.)
  const i = raw.lastIndexOf('</think>');
  return (i >= 0 ? raw.slice(i + 8) : raw).trim();
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

const TOOLS = [
  {
    name: 'local_capabilities',
    description: 'Return a description of the local LLM server: which models are loaded, their context sizes, measured speeds, and which tool to use for which task. Call this ONCE at session start to understand what local tools can do. RETURNS a capabilities manifest.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'local_ask',
    description: 'Free-form prompt to the heavy local model (default Qwen3-Coder-30B-A3B). Use for bulk analysis, summaries, explanations, or anything that needs real reasoning but does not need premium Claude quality. Prefer local_audit/review/find/summarize when they fit — they are purpose-built. For prose/essay/docs output, set caveman=false. RETURNS the model\'s text response.',
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
];

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
          tools: {
            local_ask:            'HEAVY — free-form prompt, reasoning/analysis',
            local_audit:          'HEAVY — security/bug audit of a SINGLE file',
            local_review:         'HEAVY — code review of a SINGLE file',
            local_find:           'HEAVY — natural-language file finding with ripgrep prefilter',
            local_summarize:      'HEAVY — summarize one or more files',
            local_feature_audit:  'HEAVY — multi-file audit of a feature vs spec',
            local_diff_review:    'HEAVY — review a git diff between two refs',
            local_group_commits:  'HEAVY — cluster commits into PR-sized groups by theme',
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
        out = await askLocal(
          'You are a careful code auditor. Report concrete issues only. No filler.',
          `Audit the following file for: ${a.checklist}\n\nFILE: ${a.file_path}\n\`\`\`\n${code}\n\`\`\`\n\nReturn a list of findings with line numbers and severity.`,
        );
        break;
      }

      case 'local_review': {
        const code = await fs.readFile(a.file_path, 'utf8');
        out = await askLocal(
          'You are an experienced code reviewer. Be direct. Approve or request changes with reasons.',
          `Review this file per these instructions:\n\n${a.instructions}\n\nFILE: ${a.file_path}\n\`\`\`\n${code}\n\`\`\``,
        );
        break;
      }

      case 'local_find': {
        const grep = execSync(
          `cd ${JSON.stringify(a.root)} && (rg --files 2>/dev/null || find . -type f) | head -500`,
          { encoding: 'utf8' },
        );
        out = await askLocal(
          'You rank candidate file paths for relevance. Return the most relevant paths first with one-line reasons.',
          `Find files matching: ${a.description}\n\nCandidates (first 500 files in ${a.root}):\n${grep}`,
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
        );
        break;
      }

      case 'local_feature_audit': {
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
          chunks.push(`=== ${p} ===\n${trimmed}`);
          total += trimmed.length;
        }
        out = await askLocal(
          'You audit feature implementations across multiple files as a single unit. Report concrete findings with file:line references. Be direct — no filler, no restating the spec.',
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
            `Severities: BLOCKER / MAJOR / MINOR / NIT.\n\n` +
            `FILES:\n\n${chunks.join('\n\n')}`,
          ),
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
          'You are an experienced code reviewer. Read the diff carefully. Be direct: approve or request changes with concrete reasons. Reference file:line from the diff hunks.',
          capText(
            `Review this git diff per these instructions:\n\n${a.instructions}\n\n` +
            `Output format:\n` +
            `VERDICT: APPROVE | REQUEST CHANGES\n` +
            `Then a list of findings:\n- [SEVERITY] path:line — finding\n\n` +
            `DIFF (${a.ref_a}..${a.ref_b}):\n\`\`\`diff\n${diff}\n\`\`\``,
          ),
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
          'You cluster git commits into logical PR-sized groups by theme. Use Conventional Commits style for group titles (feat:, fix:, refactor:, chore:, docs:, test:). Be direct — no filler.',
          capText(
            `Group these commits by theme/feature. For each group, output:\n` +
            `- suggested PR title (Conventional Commits style)\n` +
            `- 1-2 sentence description of the group's purpose\n` +
            `- list of included commit hashes (short form)\n\n` +
            `Rules:\n` +
            `- don't force unrelated commits together\n` +
            `- if a commit is truly isolated, put it alone\n` +
            `- use a "Miscellaneous" bucket only as last resort\n` +
            `- order groups by logical merge order (dependencies first)\n\n` +
            `COMMITS (${a.range}):\n\n${log}`,
          ),
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
