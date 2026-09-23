# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (desktop only; the panel is designed for a computer screen, no phone layout is required)

## Users

Today: Erick, the owner, who does not program. He writes a request in plain Portuguese, answers a few questions, approves a plan, and then watches AI agents (Claude Code, Codex, Gemini) build it on his own machine, often for hours or overnight. He checks in to see what is happening, what it costs, and whether anything needs his decision.

Tomorrow: a public, universal product. The same job for anyone who wants software built by AI agents without reading code: creators, founders, and developers who want a supervised, auditable agent crew.

## Product Purpose

TL-ADE turns a plain request into a finished, proven change. It interviews the person, writes a briefing and a plan, splits the plan into parts, dispatches each part to real AI coding CLIs under their own subscriptions, proves every part with tests written before the code, has a different company's model review it, and commits the result locally. Success is the person trusting the result without reading the code, and knowing at a glance what is happening, what is waiting on them, and what it costs.

## Positioning

A durable, auditable conductor for the AI tools the person already pays for. It does not call model APIs; it drives the installed `claude`, `codex` and `gemini` CLIs under the person's own plans, picks the model per task and per remaining quota, never lets the writer review its own work, and records everything in a hash-chained journal that survives crashes. The panel is the place where a non-programmer supervises an overnight crew of agents.

## Operating Context

- Runs locally: `ade serve` serves the panel on 127.0.0.1 with a session token; several project folders can be open at once, and each has its own missions.
- The flow: request, then interview, then briefing, then plan and one approval, then parts (steps, diff, proofs, review verdict), then commit.
- A chat that writes into a copy of the project and asks permission before applying changes.
- Model pages: queues per role, plan quota per company (Claude, Codex, Gemini) with renewal times, usage, and equivalent API cost.
- Skills, plugins, and mission options.
- Long unattended sessions: the person checks in, reads the state, decides pending items, and leaves.

## Capabilities and Constraints

- Stack is fixed by ADR 0030: React 19, TypeScript, and Vite in `packages/web`. That is the only place with a build step, and `packages/web` stays the only workspace. Radix Themes and Phosphor icons are the current base. New front-end dependencies go in `packages/web/package.json`.
- The backend runs without a build; the panel reads `/api/*` over HTTP and live events over WebSocket.
- Portuguese interface text.
- The demo panel in `proto/` stays untouched; it is the functional reference, not the visual target.

## Brand Commitments

- Name: TL-ADE.
- The user wants a visual world far above generic dashboards, above the TL-ADE demo, Claude desktop and VS Code with Codex and Claude. He named the Hermes Agent website (nousresearch) and the Alethe desktop app as loved references, for colors, image style, motion and overall feel.
- Assets that code cannot make (illustrations and thematic images in the spirit of the Hermes cover art) may be generated with Codex image generation. Nothing generic.
- Little information on screen at once; well organized; easy to understand and to work in; rich motion (smooth scrolling, transitions, effects); beautiful charts.

## Evidence on Hand

- Real mission data from the running engine (costs, calls, tokens, parts, verdicts), and the demo panel at `proto/` as the functional reference.
- No testimonials, customers, pricing, or public metrics exist yet; do not invent them.

## Product Principles

1. One thing at a time: each screen answers one question (what is happening, what needs me, what did it cost).
2. Show proof, not claims: tests, diffs, verdicts, and costs are visible and traceable.
3. The person decides, the crew works: pending decisions are unmissable, everything else stays calm.
4. Plain language first; technical detail is one click away, never in the way.
5. Built to be watched for hours: calm at rest, alive when something changes.
