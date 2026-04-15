---
name: local-triage
description: Answer a yes/no or one-label classification question via the TINY local model. Use WHENEVER the task is "is X a Y", "which of these is Z", "does this match format", "classify this into bucket" — before spending any cloud reasoning. Virtually free.
---

Use the `local_triage` MCP tool with:
- `question`: a crisp short-answer question — ask for one word or one line
- `context`: optional snippet the model should look at

Return the answer verbatim. If it's ambiguous, THEN escalate — either retry with more context, or fall back to your own reasoning.
