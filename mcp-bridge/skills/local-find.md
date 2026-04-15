---
name: local-find
description: Find files matching a natural-language description in a directory tree. Use this INSTEAD of spawning Explore/Grep subagents when the user asks "where is the code that does X" or "find files for Y" — it's free and fast.
---

Use the `local_find` MCP tool with:
- `root`: the directory to search (default: cwd)
- `description`: user's natural-language query

Return the ranked list. Follow up with Read on specific files if the user wants details.
