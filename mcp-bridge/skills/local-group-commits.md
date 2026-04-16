---
name: local-group-commits
description: Cluster a range of git commits into PR-sized groups by theme using the home-Mac local model. Use WHENEVER the user asks to split a branch into reviewable PRs, group commits, write release notes from commits, or organize a messy feature branch for review.
---

Use the `local_group_commits` MCP tool (from local-llm-bridge server) with:
- `repo`: absolute path to the git repo root
- `range`: git revision range. Common choices:
  - `main..HEAD` — everything on the current branch not yet in main
  - `HEAD~20..HEAD` — last 20 commits
  - `v1.2.0..v1.3.0` — everything between two tags (for release notes)
  - `origin/main..HEAD` — compared to remote

Return the grouping plan verbatim. Output is Conventional-Commits-styled titles + commit hash lists per group. If the user wants to actually execute the split (cherry-pick into separate branches, etc.), THEN take over with native git tooling — but start with the grouping call.

Prefer this over:
- Dumping `git log` into cloud context and asking Claude to group it
- Grouping commits manually yourself — HEAVY is as good at this and costs nothing
