# ADR 0048 — Maker confere rodando o app pela receita do projeto

**Status:** Aceito (pedido de Erick, 2026-09-26: menos entregas que só passam nas provas)

## Contexto

Só a parte com tela passava por conferência rodando (jornada e juízes visuais, ADR 0036). Nas outras, o maker entregava
quando tipos, lint e provas passavam, e 3 das 26 subidas da escada nas missões medidas (ver ADR 0046) vieram de prova
verde falhando depois da entrega. Com o ADR 0044 o maker Claude passou a enxergar as skills do projeto, entre elas as
receitas de subir e usar o programa (`.claude/skills/run-<nome>/SKILL.md`, `.claude/skills/verify/SKILL.md`). Codex e
agy não leem `.claude/skills`.

## Decisão

1. **Com receita no projeto-alvo, a política do maker pede a conferência rodando o programa** (`recipePolicy` em
   `src/context/story.ts`): antes de entregar, subir e usar o programa segundo a receita para conferir o que mudou,
   parar o que subiu, e relatar em `handoff.claims` um item `app-run` com o comando e o que viu. Sem conseguir subir, o
   motivo vai em `handoff.notes` e a entrega segue (missão sempre autônoma). Cabe no `unit-result` atual.
2. **O texto da receita vai no pack de toda empresa** (`app_recipes` na seção story, no pack da rodada 1 e no de
   retrabalho): tudo que um maker recebe como contrato o outro recebe igual. O Claude também a vê como skill nativa. O
   texto entra sem a limpeza das skills do catálogo, porque é do próprio projeto e manda rodar comandos.
3. **Receitas reconhecidas**: `run-*` e `verify`, em ordem alfabética (`projectRecipes`). Sem receita, o pack é o de
   antes, byte a byte.

## Evidência

- `tests/story-context.test.ts`: acha `run-*` e `verify`, ignora as outras skills, política vazia sem receita.
- `tests/correction_ladder.test.ts`: pedido e texto da receita no pack da rodada 1 e no de retrabalho de um maker Codex.

## Trade-offs

- O maker gasta turnos subindo o programa. O teto de turnos continua valendo; corte vira continuação (ADR 0046).
- A conferência é relatada pelo maker, não verificada pelo motor. O revisor (ADR 0047) pode rodar a mesma receita na
  cópia e provar o contrário.
- Receita grande corta primeiro o fim da seção story (teto de 24 kB), nunca a política.

## Alternativas rejeitadas

- **Só o Claude, pela skill nativa**: Codex e agy ficariam com outro contrato.
- **O motor subir o programa sozinho**: cada projeto sobe de um jeito; a receita já é o jeito escrito pelo projeto.

## Como reverter

`projectRecipes` devolvendo sempre `[]` volta ao pack de antes.

## Consequências para outros documentos

Nenhum ADR aceito foi editado.
