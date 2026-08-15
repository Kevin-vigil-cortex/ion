---
name: code-review
description: Run CodeRabbit on the current workspace diff and act on real findings.
---

# Code review (CodeRabbit)

Use the `code_review` tool. Do not shell out to `coderabbit`.

1. Call `code_review` (default = uncommitted). Use `type: "all"` or `base: "main"` if they asked for the whole branch.
2. Treat each finding as a hypothesis. Read the cited file. Fix real bugs / security / broken contracts. Skip style nits and false positives.
3. After fixes, `get_diagnostics` on touched files. Re-run `code_review` only if they asked to verify.
4. Summarize: what you fixed, what you skipped and why. Do not commit unless they asked.
