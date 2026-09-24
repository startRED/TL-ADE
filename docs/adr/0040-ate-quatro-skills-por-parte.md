# ADR 0040 — Até quatro skills por parte, escolhidas conforme a parte (emenda os ADRs 0009 e 0039)

**Status:** Aceito (pedido de Erick, 2026-09-24: "no máximo 4 skills em vez de 3, mas ser flexível")

## Decisão

O teto de skills por parte sobe de 3 para 4 no plano (`llm-intent`), na montagem do pacote (`context/story.ts`) e no
seletor (`skills/select.ts`). O prompt de planejamento pede de 0 a 4, só as que ajudam de verdade: parte simples leva
menos, e nenhuma quando nada serve. Os tetos de tokens (≤ 7,5k por skill, ≤ 20k no total) continuam os mesmos e cortam
a quarta skill se ela não couber.

## Como reverter

Voltar `slice(0, 4)` e `maxSkills ?? 4` para 3 e o texto "de 0 a 4" do prompt.
