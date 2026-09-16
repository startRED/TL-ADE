# ADR 0010 — Frontend Quality Engine: portões determinísticos, Impeccable, juiz de outra família, 2 rodadas

**Status:** aceito 2026-09-17

## Contexto

Interface gerada por modelo converge para o mesmo genérico, e "está bonito?" não é portão. A entrevista
pedia 4 rodadas visuais com corte 8/10 e um avaliador em modelo barato; as três premissas contrariam a
fonte normativa e a estrutura de custo real do loop.

## Decisão

`DesignBrief` em 4 camadas é **obrigatório** quando há UI. Pipeline: build verde → serve → Playwright
como biblioteca captura a11y snapshot, console, rede e estilos computados → portões determinísticos
**D1** console limpo, **D2** sem 4xx/5xx, **D3** contraste AA, **D4** estados presentes, **D5**
`impeccable detect --json` contra a **URL renderizada**, **D6** lint anti-slop (Oxlint vendorizado),
**D7** responsivo em 2 larguras → screenshot (2 larguras × claro/escuro) **só** para o juiz → juiz = o
melhor multimodal de **família diferente** do Maker, rubrica de 6 critérios (especificidade 3,0;
hierarquia 2,0; tipografia 2,0; cor 1,5; estados 1,0; movimento 0,5), corte **7,5** com especificidade
≥7, julgando **antes** de ver o diff e os achados do detector (anti-ancoragem) → **≤2 rodadas** →
`awaiting_operator` com screenshots lado a lado. Guardrail estético é default penalizado, nunca veto: o
brief vence. Impeccable é `pbakaus/impeccable` pinado por `ENGINE_VERSION`. `$imagegen` só como asset
final. v1 entrega D1–D5 + juiz.

## Evidência

- Vercel `design.md` (`README.md`, Confirmações): **−57 % de falhas** com o brief carregado, >200 runs,
  baseline sem skill, rubrica cega — a alavanca visual com a única medição causal.
- Digest #16: Impeccable 4.3.1 é normativo — "Verify in bounded passes, not a loop" (1 inspeção + 1
  confirmação): teto correto é **2**. O corte 8/10 é o **teto da banda calibrada** (32/40): trabalho bom
  cairia em `awaiting_operator`.
- Digest #17: avaliador barato economiza centavos num orçamento dominado pelo rework (10–50×); o teto
  vale para o rework, não para o juiz.
- Digest #18: lista de fontes banidas contraria Impeccable e frontend-design — "o brief vence".
- Digest #19: plugin instalado; detector Rust Apache-2.0 com 30+ regras; o modo de **arquivo** capta só
  um subconjunto (2 de 6 anti-patterns numa fixture) — o modo URL é o completo; `npx impeccable@4.3.1`
  não existe no npm público (só 4.1.0), daí pinar por `ENGINE_VERSION`.
- Digest #20: `$imagegen` funciona em `codex exec` headless (imagem real, sem chave), exige stdin
  fechado e `--skip-git-repo-check` fora de repo git.
- Digest #21: Playwright/Chrome DevTools MCP trazem 58–70 ferramentas — nunca no caminho automático;
  a11y snapshot custa 200–400 tokens contra milhares por screenshot.
- `judgment-J3-durability-security-cost.md` §6: juiz ≈6,1k in / 1,2k out (US$ 0,04–0,18 por rodada);
  D1–D7 são determinísticos e custam **zero** tokens.

## Trade-offs

Corte 7,5 e teto de 2 rodadas são **[hipótese]** até a calibração do dogfood: um teto baixo manda
trabalho quase-bom para a fila do operador, que é o modo de falha preferido (barato de resolver, visível
no `ade report`). MLLM como juiz de UI alinha só parcialmente com humano; a rubrica com peso alto em
especificidade mitiga, não elimina. "Claude projeta / Codex estrutura" fica como flag medida, não
default.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| 4 rodadas, corte 8 | contraria a fonte normativa e derruba trabalho bom (#16) |
| Avaliador em modelo barato | economiza centavos contra rework 10–50× (#17) |
| Lista de fontes banidas | guardrail é default penalizado; o brief vence (#18) |
| Pixel-diff / Lost Pixel | arquivado 2026-04-22 (#24); frágil contra mudança legítima |
| Playwright MCP no caminho automático | 58–70 ferramentas no contexto (#21) |
| `impeccable` por versão npm | 4.3.1 não existe no npm público (#19) |
| Impeccable em modo de arquivo apenas | captura subconjunto das regras (#19) |

## Como reverter

Gatilho: taxa de `awaiting_operator` visual alta com notas concentradas em 7,0–7,5, ou defeito escapando
em nota alta. Custo: corte e teto de rodadas são config; trocar o juiz é linha de roteamento. D6/D7
entram por flag sem mudar o schema `visual-eval`.

## Consequências para outros documentos

`docs/specs/` (FQE, DesignBrief), `visual-eval` (schema inline), `schemas/task-contract.schema.json`
(`design_brief`), ADR 0005 (juiz de outra família), ADR 0007, ADR 0017, ADR 0019.
