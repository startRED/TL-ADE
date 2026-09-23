---
version: 1
slug: "src-app-tsx"
primary_target: "src/App.tsx"
related_targets: ["src/Intake.tsx","src/Units.tsx"]
---

Scope: the whole TL-ADE panel (packages/web): shell, mission view, request flow (request, interview, briefing, plan), parts detail, projects. Mode: Operate. Desktop only.

Audience and job: Erick today, the public later; people who do not read code, supervising AI crews for hours, mostly at night. They need to know at a glance what is happening, what needs them, and what it costs, then leave.

Constraints: accessible names used by tests/panel_web_*.test.ts stay (Enviar pedido, Pedido, Entrevista, Briefing, Plano, Missão em execução, Aprovar/Recusar briefing|plano, Motivo da recusa, Responder, recomendado, Projetos, Abrir, Caminho da pasta, Usar <nome>, switch Modo noturno, testids active-project, project-state, unit-detail, data-kind on diff lines). Portuguese copy. No invented claims or slogans.

## Direction contract

THESIS: The mission is a live orchestral score. Each role is a staff (writes, proves, reviews, engine as percussion), because the journal records the role of every step and only the writer's model is known for sure; the model and its effort appear on the staff label as name and dynamic mark. Each part is a measure, each step a note (pitch from the round and proof phase), rounds are repeat signs, the operator's pending decision a fermata. It refuses the category's sidebar-plus-metric-cards dashboard.

OWN-WORLD: Chosen by Erick after the first render: graphite ground #121216, ink #ecebe8, staff line grey #5f5f6e, baton gold #f0b43c reserved for "now" and "needs you", and a faint blue stage light as ambient only. Four more palettes (Meia-noite, Brasa, Mono, Ardósia) with the same four roles, plus light/dark/system modes, on the Aparência page. Hairline rules, sharp corners, engraved plates as ink-on-alpha. Didone display (Bodoni Moda) as score title-page lettering and italic for musical directions; Geist for UI text; Geist Mono tabular numerals; Bravura for real notation glyphs. Light mode: the same roles on cool score-paper grey, never cream; plates print in dark ink.

STORY: The visitor sees the piece being played: which part is live, who is writing, who reviews, what is done and proven, what waits, what it cost. When something needs them, the fermata lights yellow and the only action on screen is theirs.

FIRST VIEWPORT: Top strip (monogram and TL-ADE in tracked caps; tabs; cost and calls in mono). Left third of the upper band: the mission name in large Didone with the italic subtitle and a boxed rehearsal letter for the version. Full-width below: the score, three staves (Claude, Codex, Gemini) across one measure per part, completed measures stamped, the live measure crossed by the yellow baton, future measures pale. Right margin column: fermata panel "Sua vez", plan quota drawn as notation bars, one engraved plate. Bottom: a single composer line with "Enviar".

FORM: Partitura (conductor's score), position 6 on my ordered list; seed key d0380586. Raises: baton locked to the real clock and moving only while an agent works (from the step sequencer); one continuous sheet from request to commit with rounds as repeat signs (from the origami sequence); the title behaves as matter, tightening while running and relaxing when paused (from the alphabet storm); strict four-ink discipline (from the Game Boy field).

Signature interaction and motion grammar: on load the staff lines draw left to right, notes settle measure by measure, then the baton fades in at "now". Selecting a measure opens that part as a page turn beside the score. Motion is exponential ease-out, one authored entrance, smooth scrolling on the main page; reduced motion shows the finished score at once.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Critique reference (code-led): .impeccable/mocks/decision/assigned.png

Unresolved: pages that the running mission adds (Conversa, Modelos, Skills) join the tabs when they land; they inherit this world.
