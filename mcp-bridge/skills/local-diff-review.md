---
name: local-diff-review
description: Review a git diff between two refs using the home-Mac local model. Use WHENEVER the user asks to review a branch, review a PR, self-review before pushing, or sanity-check a range of commits. Much cheaper than pulling each changed file into cloud context.
---

Use the `local_diff_review` MCP tool (from local-llm-bridge server) with:
- `repo`: absolute path to the git repo root
- `ref_a`: base ref (usually `main`, `origin/main`, or the merge base)
- `ref_b`: head ref (usually `HEAD`, the branch name, or a commit hash)
- `instructions`: what to focus on. If the user didn't say, default to "correctness, error handling, security, test coverage, and style".

Return the review output verbatim. It's pre-structured as `VERDICT: APPROVE | REQUEST CHANGES` followed by `[SEVERITY] path:line — finding`. If the user wants a deeper pass on a specific finding, THEN escalate to your own reasoning.

Prefer this over:
- Reading each changed file individually and reasoning in cloud
- Running `local_review` on each file (no cross-file diff awareness)
