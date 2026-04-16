## Local LLM routing (from claude-local-llm-setup)

You have MCP tools exposed by the `local-llm-bridge` server that offload work to a home Mac running Qwen3-Coder-30B-A3B (HEAVY). Using them costs me $0; using your built-in reasoning or subagents burns my Max 20x quota.

### Routing rules — follow unless I explicitly override

1. **Session bootstrap.** On your first turn in any session that isn't pure chitchat, call `local_capabilities` exactly once before doing anything else. Cache the result for the rest of the session.
   - If the tool errors or times out: the local server is down. Silently skip this entire policy for the rest of the session — behave as if these tools don't exist. Don't retry. Don't mention it unless I ask.
   - If it succeeds: local is available. Apply the rest of these rules.

2. **Local-first routing.** If the user's task matches any of the patterns below, you MUST call the local tool first. Do not use Read-then-reason-yourself, do not spawn a cloud subagent, do not call built-in `Explore` / `code-reviewer` / `feature-dev:*` agents for these:

   | Task pattern | Tool |
   |---|---|
   | audit / security-check / find-vulns on ONE file | `local_audit` |
   | review ONE file against stated rules/criteria | `local_review` |
   | audit a feature spanning MULTIPLE files vs a spec | `local_feature_audit` |
   | review a branch / PR / diff between two refs | `local_diff_review` |
   | cluster commits into PR-sized groups, draft release notes | `local_group_commits` |
   | "find files that do X" / "where is the code for Y" | `local_find` |
   | summarize or overview-describe a set of files | `local_summarize` |
   | bulk explain, draft boilerplate, simple refactor, yes/no classification | `local_ask` |

3. **Reserve cloud Claude (you) for:**
   - architectural decisions, novel design, API shape
   - tricky multi-step bug diagnosis
   - production-critical code generation
   - tool-heavy agentic work that requires tight iteration across many file edits
   - tasks where I explicitly say "deep", "careful", "really think about this", or name you directly

4. **Escalation — when to abandon a local result and redo on cloud.** After getting a local tool's reply, sanity-check it. Escalate to cloud (do the task yourself) if ANY of these hold:
   - The reply is empty, truncated mid-sentence, or obviously incoherent.
   - It says it can't do the task, refuses, or returns only a restatement of the prompt.
   - It references files, functions, line numbers, or symbols that don't exist when you spot-check them.
   - Its findings contradict each other or contradict facts you can verify from the code in one Read.
   - I reply with pushback like "that's wrong", "you missed X", "try again" — then redo on cloud, not locally.

   When escalating, do the work yourself once and briefly tell me you escalated and why (one line, e.g. "local result referenced a nonexistent function — redoing on cloud"). Do not loop back to local for the same task.

5. **Built-in Claude Code subagents** (`Explore`, `code-reviewer`, `Plan`, `feature-dev:code-explorer` / `code-architect` / `code-reviewer`, `general-purpose`, etc.) are expensive. Only spawn one when its specific capability clearly exceeds what a local tool can provide. For plain file search, read-and-summarize, single-file audit, diff review, or commit grouping — always the local tool.

6. **Don't narrate the policy.** Just route. If you picked local, call the tool; if you picked cloud, do the work. Only mention this policy when escalating (rule 4) or when I explicitly ask why you routed somewhere.
