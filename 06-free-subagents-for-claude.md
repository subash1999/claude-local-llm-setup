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
│  ┌─────────────────────────────┐ │        │  Qwen3-Coder-30B-A3B loaded       │
│  │ Main conversation           │ │        │                                   │
│  │ (orchestrator — cloud)      │ │        │                                   │
│  └──────┬──────────────────────┘ │        │                                   │
│         │ calls MCP tool         │        │                                   │
│         ▼                        │        │                                   │
│  ┌─────────────────────────────┐ │  HTTPS │  ┌──────────────────────────────┐ │
│  │ local-mcp-bridge (this doc) │ │◄──────►│  │ /v1/chat/completions         │ │
│  │ • local_audit(file)         │ │        │  │                              │ │
│  │ • local_review(code)        │ │        │  └──────────────────────────────┘ │
│  │ • local_find(pattern)       │ │        │                                   │
│  │ • local_summarize(files)    │ │        │                                   │
│  │ • local_ask(prompt)         │ │        │                                   │
│  └─────────────────────────────┘ │        │                                   │
└──────────────────────────────────┘        └───────────────────────────────────┘
```

## Part 1 — Install the MCP bridge on the client laptop

The MCP bridge is a tiny Node.js script that exposes five tools. Claude Code calls them; they forward to the home Mac.

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

const LOCAL_URL   = process.env.LOCAL_LLM_URL   || 'http://192.168.1.21:1234/v1/chat/completions';
const LOCAL_MODEL = process.env.LOCAL_LLM_MODEL || 'qwen3-coder-30b-a3b-instruct';

async function askLocal(system, user, maxTokens = 4096) {
  const r = await fetch(LOCAL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LOCAL_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user',   content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
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
    name: 'local_ask',
    description: 'Send a free-form prompt to the local Qwen3-Coder model on the home Mac. Use for bulk analysis, summaries, explanations, or anything that does not need premium Claude quality. RETURNS the model\'s text response.',
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
    description: 'Ask the local model to audit a file for issues (security, performance, bugs, style). Pass the absolute path to the file and what to check. RETURNS an audit report.',
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
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a } = req.params;
  try {
    let out;
    switch (name) {
      case 'local_ask':
        out = await askLocal(a.system || 'You are a concise, accurate assistant.', a.prompt);
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
  --env LOCAL_LLM_MODEL=qwen3-coder-30b-a3b-instruct
```

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

## Part 3 — Verify

1. Start a fresh `claude` session on the client laptop
2. Ask: "Audit `/path/to/some/file.js` for security issues"
3. Claude should auto-invoke the `local-audit` skill → `local_audit` MCP tool → home Mac does the work → returns to Claude
4. Your cloud token consumption should be **only the orchestration messages**, not the audit itself

Check by running `/context` in Claude Code — the audit text comes back as a tool result, not as Claude-generated content. That's the win.

## Part 4 — When to use what

| Task type | Without this setup | With this setup |
|---|---|---|
| "Find the auth code" | `Explore` agent → cloud → **burns quota** | `local-find` → home Mac → **free** |
| "Audit this file for vulns" | Claude reads + analyzes → **burns quota** | `local-audit` → home Mac → **free** |
| "Review this PR against our rules" | `code-reviewer` agent → cloud → **burns quota** | `local-review` → home Mac → **free** |
| "Summarize these 10 files" | Reads all into context → **huge quota hit** | `local-summarize` → home Mac → **free** |
| Architectural decisions | Claude main (cloud) | Claude main (cloud) — keep this on real Claude |
| Tricky bug diagnosis | Claude main (cloud) | Claude main (cloud) |
| Tool-heavy agentic work | Claude main (cloud) | Claude main (cloud) |

## Expected savings

Best estimate based on typical Claude Code sessions:
- Subagent tool calls (`Explore`, `Agent`, `code-reviewer`) are often 30–50% of total session tokens
- If this bridge handles 70% of those, you save **~25–35% of your total daily consumption**
- Burning through Max 20x in 5 days → should stretch to 7–8 days

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
- **Audits, reviews, find, summarize** = routed to home Mac via MCP bridge = **free, no quota**
- **Custom skills** make the routing automatic — you don't have to remember to invoke local tools

This is the piece that actually stretches your subscription. The `claude-local` alias from `02-client-setup-other-laptop.md` is still useful for fully-offline mode; this MCP bridge is the surgical-savings mode.
