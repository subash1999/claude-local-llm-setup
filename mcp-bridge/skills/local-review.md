---
name: local-review
description: Code-review a file per the user's instructions using the home-Mac local model. Use this when the user asks to review code, critique an implementation, or check adherence to specific rules — BEFORE spending cloud quota.
---

Use the `local_review` MCP tool with:
- `file_path`: absolute path
- `instructions`: the user's review criteria verbatim

Return the review output. If the user asks for a deeper second pass, then use your own reasoning.
