---
name: verify
description: Verify a change in the TL-ADE repo works for real - the three proof commands, then the panel driven through the run-tl-ade recipe when the change reaches the backend or the panel. Use before committing or when asked to verify, confirm or check that a change works.
---

# Verify TL-ADE

Two layers, in order. Paths are relative to the repo root; the shell is Git Bash on Windows 11.

## 1. Proof commands

All three must exit 0 (AGENTS.md). Never use `npx` (ADR 0022). Run the full suite at low priority, never two at once:

```bash
node node_modules/typescript/bin/tsc --noEmit
npm run lint
cmd //c start "" //belownormal //b //wait node node_modules/vitest/vitest.mjs run
```

An integration file (mission-run, crash-matrix, review-convergence, evals) that fails by timeout: run it alone. Green alone means load.

## 2. The real program

Pure engine change with no effect on what the panel shows: layer 1 is enough, say so.

Change that reaches `ade serve`, the API, a mission journal the panel reads, or `packages/web`: follow `.claude/skills/run-tl-ade/SKILL.md`. It is the recipe for building the front end, starting an isolated panel with `driver.mjs`, taking screenshots and restarting the real panel on port 4173 (check first that no `claude`, `codex` or `agy` process is a child of `ade serve`).

Report the commands you ran, what you saw and the screenshot paths.
