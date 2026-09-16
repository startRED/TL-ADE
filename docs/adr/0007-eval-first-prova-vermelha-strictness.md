# ADR 0007 — Eval-first: prova vermelha executada, com `strictness` por classe

**Status:** aceito 2026-09-17

## Contexto

A pergunta "a story está pronta?" precisa de uma resposta que não dependa do relato do agente. A spec v2
pedia que o Checker atestasse o rigor do eval; medição mostrou que um agente pode relatar sucesso mesmo
depois de ter uma ferramenta bloqueada. Ao mesmo tempo, exigir vermelho de **toda** story bloqueia
mudança puramente aditiva.

## Decisão

O eval nasce no Task Contract com `author` (`intent_compiler` | `maker` | `operator`) e é obrigatório:
≥1 por cenário. `eval_run` é classe de efeito no journal, com `phase: 'red' | 'green' | 'strictness'`.
O modo padrão é `must_fail_before`: o eval roda contra `tree_before` e **tem de falhar**; depois roda
contra `tree_after` e tem de passar. `additive` dispensa o vermelho e grava **aviso registrado**
(mudança puramente aditiva); `mutate` fica reservado. Eval que nasce verde devolve a story ao **Intent
Compiler**, não ao Maker. `eval` é o 8º schema publicado, e o `strictness` é validado na ingestão do
plano. O relato textual do agente nunca conta como evidência.

## Evidência

- Digest #37: um `claude -p` pode **reportar sucesso depois de ferramenta bloqueada** (medido). Prova
  por eval, nunca por relato.
- `README.md` (Confirmações): "eval estrito provado por execução vermelha antes da mudança, gravada no
  journal; eval que nasce verde é recusado. Substitui a atestação por LLM."
- `judgment-J1-implementability.md` §2, falha fatal 3: `strictness: { must_fail: true }` como literal no
  tipo bloqueia story aditiva sem escapatória; o enxerto obrigatório de C é `strictness` **por classe**.
- `judgment-J1-implementability.md` §6: `eval` como 8º schema publicado e `eval_run{phase}` como classe
  de efeito com registro no journal são enxertos obrigatórios.
- `judgment-J1-implementability.md` §4, falha fatal 3: nada prova ainda que um modelo escrevendo EARS +
  evals produz eval **discriminativo** ("THE SYSTEM SHALL work correctly" passa na validação de forma).
  Mitigação adotada: fixtures com eval frouxo que **precisa** reprovar.

## Trade-offs

Uma execução extra por eval por story (barata e determinística, sem token) em troca da única evidência
que não depende do modelo. `additive` é escapatória e pode ser abusada: o `ade report` mostra a
contagem por missão, e a fração aceitável de `additive` é **[hipótese]** até o dogfood dar um p90.
Eval escrito por modelo pode ser não-discriminativo; as fixtures de recusa cobrem a forma, não a
semântica — vigilância continua necessária.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Checker atesta o rigor do eval (spec v2) | atestação por LLM é mais cara e menos confiável que uma execução gravada |
| `must_fail: true` literal no tipo | bloqueia story aditiva (J1, falha fatal 3 de A/B) |
| Prova de rigor por inspeção estática do teste | não distingue teste que falha por motivo errado |
| Eval opcional em `trivial` | a faixa rápida delega a autoria ao Maker, mas mantém o portão `tree_before` |

## Como reverter

Gatilho: fração de `additive` alta o bastante para tornar o vermelho ritual, ou custo de execução
inaceitável. Custo: é um campo do contrato — mudar o default é uma linha em `.ade/config.json`;
remover a fase vermelha exige ADR novo, porque destrói a evidência central.

## Consequências para outros documentos

`schemas/eval.schema.json`, `schemas/task-contract.schema.json`, `schemas/journal-event.schema.json`
(classe `eval_run`), `docs/specs/` (eval runner, ciclo por story), ADR 0008 (quem escreve o eval por
classe), ADR 0010 (evals visuais), ADR 0017 (correlação eval/rework na telemetria).
