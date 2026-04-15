---
name: local-compress
description: Compress a long blob of text caveman-style using the TINY local model. Use BEFORE feeding long input into local_ask/local_summarize, or when you need to return a large chunk of text to the user without blowing up context. Preserves code, paths, URLs, numbers, identifiers verbatim; strips articles/filler/hedging. Typical 40-60% reduction.
---

Use the `local_compress` MCP tool with:
- `text`: the blob to compress
- `preserve`: optional extra rules about what must survive

Return the compressed text. If the result looks lossy on critical content, retry once with an explicit `preserve` clause (e.g. "keep every stack frame").
