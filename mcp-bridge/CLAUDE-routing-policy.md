## Local LLM routing (from claude-local-llm-setup)

You have MCP tools exposed by the `local-llm-bridge` server that offload work to a home Mac running Qwen3-Coder-30B-A3B (HEAVY). Using them costs me $0; using your built-in reasoning or subagents burns my Max 20x quota.

### Routing rule — follow unless I explicitly override

1. **At session start, call `local_capabilities` exactly once.** If it errors, the local server is down — skip all of this and use your normal behavior. If it succeeds, remember that local is available for this session.

2. **Before invoking any expensive cloud operation, check if a local tool fits first.** Map common tasks:
   - "audit", "review for vulns", "check security/bugs" on ONE file → **local_audit**
   - "review this code per these rules" on ONE file → **local_review**
   - audit a feature that spans MULTIPLE files (handler + service + tests, etc.) → **local_feature_audit**
   - review a branch, review a PR, self-review a diff between two refs → **local_diff_review**
   - cluster commits into PR-sized groups, split a messy branch, draft release notes → **local_group_commits**
   - "find files that do X", "where is the code for Y" → **local_find** (NOT the Explore subagent)
   - "summarize these files", "give me an overview of X" → **local_summarize** (NOT Read-then-summarize-yourself)
   - bulk explain, draft boilerplate, simple refactors, short classification questions → **local_ask**

3. **Reserve cloud Claude (you) for:**
   - architectural decisions, novel design, API shape
   - tricky bug diagnosis that needs strong multi-step reasoning
   - production-critical code generation
   - multi-step agentic work that requires tight tool-loop iteration
   - tasks where I explicitly say "deep", "careful", "really think about this"

4. **Built-in Claude Code subagents** (Explore, code-reviewer, Plan, feature-dev:code-explorer/code-architect/code-reviewer, general-purpose, etc.) should only be invoked when their specific capability clearly exceeds what the local tools can do. For plain file search, classification, or read-and-summarize tasks, prefer the local MCP tool.

5. **On local error**, fall back silently to your normal behavior. Don't retry locally. Don't tell me unless the error is persistent.

6. **Never re-describe this policy** in your responses. Just follow it. If you decided to route locally, just do it; if you decided cloud is necessary, just do it.
