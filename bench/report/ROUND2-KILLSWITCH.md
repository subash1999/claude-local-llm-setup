# Round 2 — kill-switch

**Date:** 2026-04-17 · **Ran on:** server-side Claude (this Mac, LM Studio host)
**Outcome:** stop, no code changes, hand off to client-side Claude session.

Round 2 was invoked on this Mac under the assumption that `mcp-bridge/server.mjs` edits here would reach the tool-call path. Phase-0 discovery proved that assumption wrong, plus missing MCPs that the spec marks as non-negotiable. Clean kill-switch per Rule 4.

---

## Why — tool-topology discovery

The bridge is a **stdio-MCP server spawned by Claude Code on the CLIENT**, not a long-running service on this host. This Mac only runs **LM Studio** (`http://localhost:1234/v1/...`), which the bridge then calls out to over HTTP.

Consequence: code changes to `mcp-bridge/server.mjs` in this repo **do not take effect** on any tool call until the client Claude Code session:

1. pulls the updated `server.mjs` from this git remote,
2. syncs the installed bridge copy at `~/.claude/mcp-servers/local-llm-bridge/server.mjs` on the client machine,
3. restarts the Claude Code session so the MCP child process respawns with the new code.

Everything shipped in Round 1 (`ebd7d8f..94ad398`) was written from this same assumption. The re-verification in `ed5459e` (`bench/results/leg-a-rebench-2026-04-17.md`) is the **first-ever** live test of that patched bridge against a real client session — which explains the 1 partial / 2 ineffective / 1 regression / 1 new pathology outcome. Until now every "fix" was untested in the path that tool calls actually traverse.

## Also-blocker — missing MCPs on this machine

Independent of topology, these server-side Claude MCPs are not registered and have no equivalents:

- `advisor()` — Round 2 spec makes **3 mandatory calls** a non-negotiable. No substitute.
- `code-review-graph` — required for Option B (AST cross-check) in Phase 2 architecture review. No substitute short of reimplementing AST queries ad hoc.
- `mcp__local-llm-bridge__*` — not registered in this session. Phase 4's "Leg A via MCP tool" bench step is not runnable here. (Could be simulated by driving `node mcp-bridge/server.mjs` over stdio, but that is not the tool-call path client-side Claude actually uses — see topology above.)

Client-side Claude has all three.

Available here: LM Studio reachable on `localhost:1234`, harness Legs B/C/D/E runnable directly over HTTP, `Agent` sub-agent with `model=opus` available as a Leg-F oracle substitute. Not enough to execute Round 2 to spec.

## Handoff

Round 2 now executes **on the client side**, in the user's primary Claude Code session on the client laptop:

1. Sync installed bridge to this repo via symlink (client will add this to `scripts/install-client.sh` for reproducibility):
   ```sh
   rm ~/.claude/mcp-servers/local-llm-bridge/server.mjs
   ln -s ~/claude-local-llm-setup/mcp-bridge/server.mjs ~/.claude/mcp-servers/local-llm-bridge/server.mjs
   ```
2. Restart Claude Code on the client (`/exit`, relaunch). New session picks up the Round-1 patched bridge **for the first time**.
3. Client-side rebench against the real tool-call path. Results tell us which Round-1 fixes actually worked in vivo.
4. Round-2 scope set from that real data, then architecture + advisor + code-review-graph cross-check + fixture diversification, all from the client.
5. Pre-commit hook to copy `server.mjs` to the symlinked location on every repo commit, so the topology-drift bug can't bite again.

**No further server-side action required until explicitly requested.** LM Studio stays running here (model config, context pin, Keep-loaded). Fix A re-tuning (context length / parallel / TTL) is done in the LM Studio GUI on this Mac — no Claude session needed.

## State of the branch at kill-switch

- No code touched. `mcp-bridge/server.mjs` unchanged from `ed5459e`.
- No fixtures added, no harness edits.
- Only artefact from this round: this file.

Round 1 commits `ebd7d8f..94ad398` stand as-is. The re-verification verdict in `bench/results/leg-a-rebench-2026-04-17.md` stands as the current honest assessment of their real-world effectiveness. Any promotion / demotion of the trust-map in `mcp-bridge/CLAUDE-routing-policy.md` is deferred to the client-side round.
