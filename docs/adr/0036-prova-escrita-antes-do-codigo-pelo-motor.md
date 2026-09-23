# ADR 0036 — Prova escrita antes do código pelo próprio motor (emenda o ADR 0007)

**Status:** Aceito (pedido de Erick, 2026-09-23: a TL-ADE real precisa entregar sozinha um pedido feito no painel)

## Contexto

O eval vermelho exige uma prova que falhe antes do código. No Slice 1 quem escrevia a prova era o operador, no
contrato. O pedido feito no painel vira critérios (dado/quando/então) pela IA de intenção, mas nenhum teste escrito:
o comando de provas do projeto passa na base, o vermelho nasce verde e toda parte estacionava com `eval_red_not_red`.
Além disso, a classificação do vermelho só lia o reporter JSON do Vitest; `node --test`, Vitest sem reporter e Jest
caíam sempre em "ambiente".

## Decisão

1. **Etapa de prova.** Quando o vermelho não vale numa parte que começa agora (não em retomada) e o escopo tem arquivo de
   prova nomeado (pasta `tests/`, `__tests__/`, `spec/` ou sufixo `.test`/`.spec`), o motor despacha um modelo só para
   escrever os testes dos critérios nesses arquivos (`src/engine/proof.ts`) e roda o vermelho de novo.
2. **Quem escreve a prova.** A primeira empresa com despachante, binário e recibo oficial de cota válido sob o teto da
   missão, com preferência por empresa diferente de quem escreve o código (fila de revisão, depois a de correção; sem
   planos, o revisor e depois o maker do contrato).
3. **Mesmas travas da chamada paga.** Reserva própria (`<parte>:proof`, fase `proof`), `authorizedStep`, telemetria com
   papel `prova`. Mudança fora dos arquivos de prova desfaz a árvore e estaciona com `proof_out_of_scope`; nada escrito
   estaciona com `proof_not_written`.
4. **Resumo do executor.** Sem reporter JSON, a contagem vem do resumo impresso por `node --test` (spec e TAP), Vitest e
   Jest (`parseRunnerSummary`). Erro de importação continua `compile_error`: a prova precisa falhar por asserção.

## Consequências

- Uma chamada paga a mais por parte que chega sem prova; parte com prova do operador não muda.
- A prova e o código podem sair da mesma empresa quando só ela tem cota; a revisão de outra empresa continua obrigatória.

## Como reverter

Remover a chamada a `writeProof` em `src/engine.ts`; o vermelho volta a estacionar a parte sem prova.
