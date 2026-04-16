---
name: local-feature-audit
description: Audit a feature that spans multiple files against a spec using the home-Mac local model. Use WHENEVER the user asks to audit/review a feature across more than one file — handler + service, endpoint + tests, migration + model + queries, etc. Saves subscription quota vs. pulling all files into cloud context.
---

Use the `local_feature_audit` MCP tool (from local-llm-bridge server) with:
- `file_paths`: array of absolute paths of every file that together implements the feature. Cast wide — include tests, types, config, DB migrations when they're part of the feature surface.
- `spec`: the user's description of what the feature should do, verbatim. If they didn't write a spec, use the ticket body, commit message, or a one-paragraph summary of what you understand the feature is for.

Return the audit report verbatim. It's pre-structured as `[SEVERITY] path:line — finding`. If the user wants a deeper pass on a specific BLOCKER or MAJOR item, THEN escalate to your own reasoning — but start local.

Prefer this over:
- Calling `local_audit` multiple times (no cross-file reasoning)
- Reading files yourself and reasoning in cloud (burns quota for work HEAVY can do)
