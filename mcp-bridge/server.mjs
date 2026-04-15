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
const TINY_MODEL   = process.env.LOCAL_TINY_MODEL || 'qwen3-1.7b';
const CAVEMAN_MODE = (process.env.CAVEMAN_MODE || 'on').toLowerCase() !== 'off';

// Inspired by JuliusBrussee/caveman — https://github.com/JuliusBrussee/caveman
// Output-side compression: every reply comes back terse, Claude reads fewer tokens.
const CAVEMAN_RULES = `Respond caveman style. Terse, telegraphic, no filler.
RULES:
- drop articles (the/a/an), filler (just/really/basically/actually/simply), pleasantries, hedging
- fragments OK. short synonyms. no greetings, no sign-offs, no meta
- technical substance EXACT. code blocks, file paths, URLs, numbers, identifiers, error messages UNCHANGED
- pattern: [thing] [action] [reason]. [next step].
- never apologize, never narrate your style
ACTIVE EVERY RESPONSE.`;

function composeSystem(base) {
  return CAVEMAN_MODE ? `${CAVEMAN_RULES}\n\n${base}` : base;
}

async function askLocal(system, user, { maxTokens = 4096, model = HEAVY_MODEL, temperature = 0.2 } = {}) {
  const r = await fetch(LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: composeSystem(system) },
        { role: 'user',   content: user },
      ],
      max_tokens: maxTokens,
      temperature,
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
  { name: 'local-llm-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const TOOLS = [
  {
    name: 'local_capabilities',
    description: 'Return a description of the local LLM server: which models are loaded, their context sizes, measured speeds, and which tool to use for which task. Call this ONCE at session start to understand what local tools can do. RETURNS a capabilities manifest.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'local_ask',
    description: 'Free-form prompt to the heavy local model (default Qwen3-Coder-30B-A3B). Use for bulk analysis, summaries, explanations, or anything that needs real reasoning but does not need premium Claude quality. Prefer local_audit/review/find/summarize when they fit — they are purpose-built. RETURNS the model\'s text response.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send.' },
        system: { type: 'string', description: 'Optional system message.' },
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
    name: 'local_triage',
    description: 'Ask the TINY local model a yes/no or one-label question. Use for classification, routing, and fast decisions — e.g. "is this file config or source code", "does this message follow Conventional Commits", "which of these paths is test data". Much faster and cheaper than local_ask. Returns a short label/answer in caveman style.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A specific short-answer question. Ask for one word or one line.' },
        context:  { type: 'string', description: 'Optional content the model should look at when answering (e.g. a file snippet or list of paths).' },
      },
      required: ['question'],
    },
  },
  {
    name: 'local_compress',
    description: 'TINY model compresses a blob of text caveman-style. Preserves code, paths, URLs, numbers, identifiers, error messages VERBATIM; drops articles/filler/hedging/pleasantries. Typical 40-60% reduction. Use BEFORE feeding long context into local_ask/local_summarize, or when you need to return a long blob to the cloud session without eating its input window.',
    inputSchema: {
      type: 'object',
      properties: {
        text:     { type: 'string', description: 'Text to compress.' },
        preserve: { type: 'string', description: 'Optional extra rules, e.g. "keep every line that contains a stack frame".' },
      },
      required: ['text'],
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
            ],
          },
          tiny_model: {
            name: TINY_MODEL,
            best_for: [
              'yes/no classification', 'one-label routing',
              'format checks', 'short field extraction',
              'caveman pre-compression before feeding HEAVY',
            ],
          },
          tools: {
            local_ask:        'HEAVY — free-form prompt, reasoning/analysis',
            local_audit:      'HEAVY — security/bug audit of a file',
            local_review:     'HEAVY — code review of a file',
            local_find:       'HEAVY — natural-language file finding with ripgrep prefilter',
            local_summarize:  'HEAVY — summarize one or more files',
            local_triage:     'TINY  — one-word/one-line classification (thinking on, accuracy-tuned)',
            local_compress:   'TINY  — caveman-compress a blob of text (/no_think, deterministic)',
          },
          routing_hints: [
            'If decision is yes/no or single label -> local_triage.',
            'If input is long and HEAVY must see it -> local_compress first, then call HEAVY tool.',
            'Architectural decisions / tricky debugging / novel design -> keep on cloud Claude.',
            'Code generation for critical prod code -> keep on cloud Claude. Local for drafts/refactors.',
          ],
        }, null, 2);
        break;

      case 'local_ask':
        out = await askLocal(a.system || 'You are a concise, accurate assistant.', a.prompt);
        break;

      case 'local_triage':
        // Thinking ON — measured 9/10 vs 6/10 for /no_think on yes/no classification
        // (Qwen3-1.7B, 2026-04-15 spot-check). Accuracy > speed for routing decisions.
        // maxTokens=800 gives reasoning room; final answer after </think> is typically
        // one word / one line.
        out = await askLocal(
          'You answer short classification/routing questions with one word or one short line. No preamble, no explanation unless asked.',
          a.context ? `${a.question}\n\n---\n${a.context}` : a.question,
          { model: TINY_MODEL, maxTokens: 800, temperature: 0 },
        );
        break;

      case 'local_compress':
        // /no_think: compression is a rewrite, not reasoning.
        out = await askLocal(
          `/no_think\nYou compress text. Preserve VERBATIM: code blocks, file paths, URLs, numbers, identifiers, error messages, CLI commands, stack frames. Drop: articles, filler, hedging, pleasantries, redundant restatements, meta commentary. Output ONLY the compressed text.${a.preserve ? ' Extra preservation: ' + a.preserve : ''}`,
          a.text,
          { model: TINY_MODEL, maxTokens: Math.max(512, Math.ceil(a.text.length / 3)), temperature: 0 },
        );
        break;

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
          `Summarize the following files${a.focus ? ` focusing on ${a.focus}` : ''}:\n\n${chunks.join('\n\n')}`,
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
