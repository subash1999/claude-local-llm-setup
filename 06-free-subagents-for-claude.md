# Free Subagents — Routing Claude's Delegated Tasks to the Local Mac

## The problem

Claude Code's native subagent system (`Agent` tool, custom agent types like `Explore`, `code-reviewer`, `feature-dev:code-explorer`) spawns each subagent with a model. On Max 20x **all subagents use your subscription quota** — there's no per-subagent routing to a custom endpoint, because Max 20x is OAuth (not API-key) so proxies like `claude-code-router` don't cleanly work.

This is painful because subagents often consume **more tokens than main sessions** — they get big context bundles, produce detailed reports, and get spawned repeatedly.

## The solution — MCP bridge + local tool commands

Instead of routing native subagents to local, we give Claude Code new **MCP tools** that it can call from the cloud session. Each tool is a thin shell around the home Mac's LM Studio. When Claude wants to "audit this file" or "find all files matching X," it calls these tools — which run on the local Mac, for free.

From Claude's perspective it's just calling tools. From yours, you're not burning subscription quota on bulk work.

## Architecture

```
┌────────── Other laptop ──────────┐        ┌───── Home Mac (192.168.1.21) ─────┐
│                                  │        │                                   │
│  Claude Code (cloud / Max 20x)   │        │  LM Studio server :1234           │
│  ┌─────────────────────────────┐ │        │  ┌─ HEAVY ─────────────────────┐  │
│  │ Main conversation           │ │        │  │ qwen3-coder-30b-a3b-instruct│  │
│  │ (orchestrator — cloud)      │ │        │  │ 32K ctx · ~63 tok/s · 12 GB │  │
│  └──────┬──────────────────────┘ │        │  └─────────────────────────────┘  │
│         │ calls MCP tool         │        │  ┌─ TINY  ─────────────────────┐  │
│         ▼                        │        │  │ qwen3-1.7b                  │  │
│  ┌─────────────────────────────┐ │  HTTP  │  │ 8K ctx  · ~57 tok/s · 1 GB  │  │
│  │ local-mcp-bridge (this doc) │◄┼───────►│  └─────────────────────────────┘  │
│  │ HEAVY tools:                │ │        │                                   │
│  │ • local_ask                 │ │        │  Both loaded in parallel          │
│  │ • local_audit               │ │        │  ~14.3 GB resident / 18 GB        │
│  │ • local_review              │ │        │                                   │
│  │ • local_find                │ │        │  All local replies come back      │
│  │ • local_summarize           │ │        │  caveman-compressed (CAVEMAN_MODE) │
│  │ TINY tools:                 │ │        │  → Claude reads 40-65% fewer      │
│  │ • local_triage              │ │        │    tokens on each MCP result      │
│  │ • local_compress            │ │        │                                   │
│  │ Meta:                       │ │        │                                   │
│  │ • local_capabilities        │ │        │                                   │
│  └─────────────────────────────┘ │        │                                   │
└──────────────────────────────────┘        └───────────────────────────────────┘
```

## Part 1 — Install the MCP bridge on the client laptop

The MCP bridge is a tiny Node.js script that exposes eight tools (five HEAVY, two TINY, one meta). Claude Code calls them; they forward to the home Mac.

### Create the bridge

```bash
mkdir -p ~/.claude/mcp-servers/local-llm-bridge
cd ~/.claude/mcp-servers/local-llm-bridge

npm init -y
npm install @modelcontextprotocol/sdk node-fetch

cat > server.js <<'EOF'
#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import fetch from 'node-fetch';
import fs from 'node:fs/promises';
import { execSync } from 'node:child_process';

const LOCAL_URL    = process.env.LOCAL_LLM_URL    || 'http://192.168.1.21:1234/v1/chat/completions';
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
  return j.choices[0].message.content;
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
    description: 'Free-form prompt to the heavy local model (Qwen3-Coder-30B-A3B, 32K context, ~60 tok/s). Use for bulk analysis, summaries, explanations, or anything that needs real reasoning but does not need premium Claude quality. Prefer local_audit/review/find/summarize when they fit — they are purpose-built. RETURNS the model\'s text response.',
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
    description: 'Ask the TINY 1.7B model a yes/no or one-label question. Use for classification, routing, and fast decisions — e.g. "is this file config or source code", "does this message follow Conventional Commits", "which of these paths is test data". Much faster and cheaper than local_ask. Returns a short label/answer in caveman style.',
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
    description: 'TINY 1.7B compresses a blob of text caveman-style. Preserves code, paths, URLs, numbers, identifiers, error messages VERBATIM; drops articles/filler/hedging/pleasantries. Typical 40-60% reduction. Use BEFORE feeding long context into local_ask/local_summarize, or when you need to return a long blob to the cloud session without eating its input window.',
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
            params: '30B total, 3.3B active (MoE)',
            quant: 'MLX 3-bit (~12.4 GB)',
            context: 32768,
            decode_tok_per_sec: 63,
            best_for: [
              'code review', 'file audit', 'refactor suggestions',
              'multi-file summarization', 'architectural analysis',
              'bulk explain', 'natural-language file finding',
            ],
          },
          tiny_model: {
            name: TINY_MODEL,
            params: '1.7B dense',
            quant: 'MLX 4-bit (~1 GB)',
            context: 8192,
            decode_tok_per_sec: 57,
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
            local_triage:     'TINY  — one-word/one-line classification',
            local_compress:   'TINY  — caveman-compress a blob of text',
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
        out = await askLocal(
          'You answer short classification/routing questions with one word or one short line. No preamble, no explanation unless asked.',
          a.context ? `${a.question}\n\n---\n${a.context}` : a.question,
          { model: TINY_MODEL, maxTokens: 64, temperature: 0 },
        );
        break;

      case 'local_compress':
        out = await askLocal(
          `You compress text. Preserve VERBATIM: code blocks, file paths, URLs, numbers, identifiers, error messages, CLI commands, stack frames. Drop: articles, filler, hedging, pleasantries, redundant restatements, meta commentary. Output ONLY the compressed text.${a.preserve ? ' Extra preservation: ' + a.preserve : ''}`,
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
EOF

chmod +x server.js
```

Make `package.json` ESM-friendly:

```bash
node -e "const p=require('./package.json'); p.type='module'; require('fs').writeFileSync('package.json', JSON.stringify(p,null,2));"
```

Test it runs (Ctrl-C after a second):
```bash
node ~/.claude/mcp-servers/local-llm-bridge/server.js
```

### Register the MCP server with Claude Code

```bash
claude mcp add local-llm-bridge \
  --command node \
  --args /Users/$(whoami)/.claude/mcp-servers/local-llm-bridge/server.js \
  --scope user \
  --env LOCAL_LLM_URL=http://192.168.1.21:1234/v1/chat/completions \
  --env LOCAL_LLM_MODEL=qwen3-coder-30b-a3b-instruct \
  --env LOCAL_TINY_MODEL=qwen3-1.7b \
  --env CAVEMAN_MODE=on
```

> `CAVEMAN_MODE=on` is the default. Set to `off` in the env if you want verbose replies for a specific session — useful when debugging what the local model is actually saying.

Verify:
```bash
claude mcp list | grep local-llm
```

## Part 2 — Create custom Claude Code skills that use the bridge

Skills are auto-invokable when their triggers match. Put these in `~/.claude/skills/`.

### Skill: local-audit

```bash
mkdir -p ~/.claude/skills
cat > ~/.claude/skills/local-audit.md <<'EOF'
---
name: local-audit
description: Run a free security/bug/style audit on a file using the home-Mac local model. Use this WHENEVER the user asks to audit, review for issues, check for vulnerabilities, or scan a file — BEFORE using native Claude reasoning. Saves subscription quota.
---

Use the `local_audit` MCP tool (from local-llm-bridge server) with:
- `file_path`: absolute path of the file to audit
- `checklist`: what the user wants audited. If they didn't specify, default to "security vulnerabilities, logic bugs, error handling, style issues"

Return the audit report verbatim. If the user wants deeper analysis after, THEN escalate to your own reasoning — but start local.
EOF
```

### Skill: local-review

```bash
cat > ~/.claude/skills/local-review.md <<'EOF'
---
name: local-review
description: Code-review a file per the user's instructions using the home-Mac local model. Use this when the user asks to review code, critique an implementation, or check adherence to specific rules — BEFORE spending cloud quota.
---

Use the `local_review` MCP tool with:
- `file_path`: absolute path
- `instructions`: the user's review criteria verbatim

Return the review output. If the user asks for a deeper second pass, then use your own reasoning.
EOF
```

### Skill: local-find

```bash
cat > ~/.claude/skills/local-find.md <<'EOF'
---
name: local-find
description: Find files matching a natural-language description in a directory tree. Use this INSTEAD of spawning Explore/Grep subagents when the user asks "where is the code that does X" or "find files for Y" — it's free and fast.
---

Use the `local_find` MCP tool with:
- `root`: the directory to search (default: cwd)
- `description`: user's natural-language query

Return the ranked list. Follow up with Read on specific files if the user wants details.
EOF
```

### Skill: local-summarize

```bash
cat > ~/.claude/skills/local-summarize.md <<'EOF'
---
name: local-summarize
description: Summarize one or more files using the home-Mac local model. Use INSTEAD of reading files into your context when the user just wants a high-level overview — saves huge amounts of cloud tokens.
---

Use the `local_summarize` MCP tool with:
- `file_paths`: absolute paths
- `focus`: optional topic the user cares about

Return the summary. Only Read files into your own context if the user explicitly needs detailed work on them afterward.
EOF
```

### Skill: local-triage

```bash
cat > ~/.claude/skills/local-triage.md <<'EOF'
---
name: local-triage
description: Answer a yes/no or one-label classification question via the TINY 1.7B local model. Use WHENEVER the task is "is X a Y", "which of these is Z", "does this match format", "classify this into bucket" — before spending any cloud reasoning. Faster than local_ask (57 tok/s, 8K context) and virtually free.
---

Use the `local_triage` MCP tool with:
- `question`: a crisp short-answer question — ask for one word or one line
- `context`: optional snippet the model should look at

Return the answer verbatim. If it's ambiguous, THEN escalate — either retry with more context, or fall back to your own reasoning.
EOF
```

### Skill: local-compress

```bash
cat > ~/.claude/skills/local-compress.md <<'EOF'
---
name: local-compress
description: Compress a long blob of text caveman-style using the TINY local model. Use BEFORE feeding long input into local_ask/local_summarize, or when you need to return a large chunk of text to the user without blowing up context. Preserves code, paths, URLs, numbers, identifiers verbatim; strips articles/filler/hedging. Typical 40-60% reduction.
---

Use the `local_compress` MCP tool with:
- `text`: the blob to compress
- `preserve`: optional extra rules about what must survive

Return the compressed text. If the result looks lossy on critical content, retry once with an explicit `preserve` clause (e.g. "keep every stack frame").
EOF
```

## Part 3 — Verify

1. Start a fresh `claude` session on the client laptop
2. Ask: "Audit `/path/to/some/file.js` for security issues"
3. Claude should auto-invoke the `local-audit` skill → `local_audit` MCP tool → home Mac does the work → returns to Claude
4. Your cloud token consumption should be **only the orchestration messages**, not the audit itself

Check by running `/context` in Claude Code — the audit text comes back as a tool result, not as Claude-generated content. That's the win.

## Part 4 — When to use what

| Task type | Without this setup | With this setup |
|---|---|---|
| "Find the auth code" | `Explore` agent → cloud → **burns quota** | `local-find` → HEAVY → **free** |
| "Audit this file for vulns" | Claude reads + analyzes → **burns quota** | `local-audit` → HEAVY → **free** |
| "Review this PR against our rules" | `code-reviewer` agent → cloud → **burns quota** | `local-review` → HEAVY → **free** |
| "Summarize these 10 files" | Reads all into context → **huge quota hit** | `local-summarize` → HEAVY → **free** |
| "Is this a test file or source?" | Claude reasons → burns small but frequent quota | `local-triage` → TINY → **free, ~instant** |
| "Does this commit msg follow convention?" | Claude reasons | `local-triage` → TINY → **free** |
| "Compress this 8K chunk before I feed it to HEAVY" | not possible on cloud | `local-compress` → TINY → **free** |
| Architectural decisions | Claude main (cloud) | Claude main (cloud) — keep this on real Claude |
| Tricky bug diagnosis | Claude main (cloud) | Claude main (cloud) |
| Tool-heavy agentic work | Claude main (cloud) | Claude main (cloud) |

### Routing cheat-sheet for Claude

Tell Claude at session start: "Call `local_capabilities` once, then follow its routing_hints." The manifest describes which model is fast at what, so Claude picks correctly without you having to name tools.

General rule:
- **Decision / classification / format check** → TINY (`local_triage`)
- **Read, analyze, summarize, audit, review** → HEAVY (`local_ask`/`local_audit`/`local_review`/`local_find`/`local_summarize`)
- **Pre-shrink long input before HEAVY** → TINY (`local_compress`), then the HEAVY tool
- **Novel design, tricky debugging, prod-critical code** → keep on cloud Claude

## Part 5 — Caveman mode (output compression)

**Every local tool response comes back caveman-compressed** when `CAVEMAN_MODE=on` (default). This is ~40–65% fewer tokens for Claude to read, measured on typical audit/review/summary outputs.

### The rules applied

```
Respond caveman style. Terse, telegraphic, no filler.
- drop articles (the/a/an), filler (just/really/basically/actually/simply),
  pleasantries, hedging
- fragments OK. short synonyms. no greetings, no sign-offs, no meta
- technical substance EXACT. code, paths, URLs, numbers, identifiers,
  error messages UNCHANGED
- pattern: [thing] [action] [reason]. [next step].
```

This is inspired by [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) (viral Apr 2026 Claude Code skill). We bake the prompt directly into the MCP bridge instead of shipping it as a separate skill, because:
- Skills only affect the **outer** Claude session's output
- We want the **local model's** output compressed (that's what Claude has to read and pay input tokens on)

### Why it stacks with the MCP bridge

| Layer | What caveman saves |
|---|---|
| Local model → MCP → Claude | HEAVY/TINY reply is ~50% shorter → Claude's **input** tokens drop |
| TINY pre-compresses long context for HEAVY | HEAVY gets shorter prompts → local compute faster, HEAVY's reply also shorter |
| (Optional) JuliusBrussee skill on client laptop | Claude's **own** replies shorter too — user reads less, and follow-up turns carry less history |

### Optional — install the JuliusBrussee skill on the client laptop

This is the client-laptop equivalent: it compresses Claude's *own* output (not the local model's). Independent of the MCP bridge. Install with one command:

```bash
# On the client laptop:
claude plugin marketplace add JuliusBrussee/caveman
claude plugin install caveman@caveman
```

Then inside a session you can toggle intensity: `/caveman lite`, `/caveman full` (default), `/caveman ultra`. If Claude's replies turn too cryptic for code review, drop to `lite` or `/caveman off`.

### Turning caveman off

For one session, override the env var when launching Claude Code:

```bash
CAVEMAN_MODE=off claude
```

Or permanently: edit the `claude mcp add` command's `--env CAVEMAN_MODE=on` to `off` and re-run.

Leave it off when you explicitly need a verbose, readable local-model reply — e.g. a teaching-style explanation or a long-form draft. For everything else (audits, triage, summaries), caveman is pure win.

## Expected savings

Stacked best-case, typical Claude Code day:
- Subagent-style calls (find/audit/review/summarize) routed to local → **cuts ~30% of cloud tokens** (MCP bridge alone)
- Caveman compression on those local replies → **further ~40% off what does come back** → another **~10–12%** of total daily tokens
- `local_triage` replacing small reasoning-style calls Claude would otherwise do → ~3–5% more
- Optional JuliusBrussee skill on Claude's own output → another ~10–15%

Rough combined: **35–50% of a typical day's cloud quota offloaded**. Burning through Max 20x in 5 days → should stretch to 8–10 days.

Numbers vary by workload — lots of "explain this code" work saves more than lots of "design this new system" work.

## Troubleshooting

### Skill doesn't auto-invoke
- Run `claude` with `--verbose` to see skill matching
- Edit the skill's `description` to match your phrasing better
- Manually: "Use the local-audit skill to audit `file.js`"

### MCP server shows as disconnected
```bash
claude mcp list
# If local-llm-bridge is red, check:
cd ~/.claude/mcp-servers/local-llm-bridge && node server.js   # look for errors
```

### Home Mac unreachable from MCP tool
- Same network? `curl -s -m 3 http://192.168.1.21:1234/v1/models` from client
- IP changed? Update `LOCAL_LLM_URL` env var in the `claude mcp add` command (re-run with updated `--env`)

### Responses are truncated
- Raise `maxTokens` in `server.js` (currently 4096)
- Raise the loaded context on server Mac: `lms load ... --context-length 65536`

## Summary

- **Main Claude session (cloud)** = orchestration, planning, hard reasoning = Max 20x quota
- **Audits, reviews, find, summarize** = HEAVY (Qwen3-Coder-30B-A3B) via MCP bridge = **free, no quota**
- **Yes/no + classification + pre-compression** = TINY (Qwen3-1.7B) via MCP bridge = **free, ~instant**
- **Caveman mode** compresses every local reply ~40–65% before Claude reads it = **free input-token cut**
- **Custom skills** make the routing automatic — you don't have to remember to invoke local tools
- **Optional client-side** [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) skill compresses Claude's own replies too

This is the piece that actually stretches your subscription. The `claude-local` alias from `02-client-setup-other-laptop.md` is still useful for fully-offline mode; this MCP bridge is the surgical-savings mode.
