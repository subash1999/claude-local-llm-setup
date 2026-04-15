---
name: local-summarize
description: Summarize one or more files using the home-Mac local model. Use INSTEAD of reading files into your context when the user just wants a high-level overview — saves huge amounts of cloud tokens.
---

Use the `local_summarize` MCP tool with:
- `file_paths`: absolute paths
- `focus`: optional topic the user cares about

Return the summary. Only Read files into your own context if the user explicitly needs detailed work on them afterward.
