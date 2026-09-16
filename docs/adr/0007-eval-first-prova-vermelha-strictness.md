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
contra `tree_after` e tem de passar. O vermelho só vale quando `EvalRecord.red_reason = 'assertion'`;
`missing_target`, `compile_error` e `environment` rebaixam o eval para `additive` com aviso, e em classe
≥ `feature` levam a `awaiting_operator` (E12). `additive` dispensa o vermelho, grava **aviso
registrado** (mudança puramente aditiva) e exige no mesmo cenário um eval `negative` ou um spot-check
`mutate` — condição validada por ajv. Eval que nasce verde devolve a story ao **Intent Compiler**, não
ao Maker. `eval` é o 8º schema publicado, e o `strictness` é validado na ingestão do plano. O veredito
da story vive no `unit-result` (que ganha `sources: string[]` obrigatório, E8) e no `unit_state` do
journal, nunca num campo do contrato: `passes` **não existe** no Task Contract (E1). `ade eval <story>`
roda os evals do contrato sob o mesmo runner. O relato textual do agente nunca conta como evidência.

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
que não depende do modelo. `additive` é escapatória e pode ser abusada: a exigência de `negative` ou `mutate` no mesmo cenário
fecha a saída mais barata, o `ade report` mostra a contagem por missão, e a fração aceitável de
`additive` é **[hipótese]** até o dogfood dar um p90. Classificar `red_reason` custa parsing frágil de
saída de runner por linguagem; errar para `environment` é o lado seguro (rebaixa, não aprova).
Eval escrito por modelo pode ser não-discriminativo; as fixtures de recusa cobrem a forma, não a
semântica — vigilância continua necessária.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Checker atesta o rigor do eval (spec v2) | atestação por LLM é mais cara e menos confiável que uma execução gravada |
| `must_fail: true` literal no tipo | bloqueia story aditiva (J1, falha fatal 3 de A/B) |
| Prova de rigor por inspeção estática do teste | não distingue teste que falha por motivo errado |
| Eval opcional em `trivial` | a faixa rápida delega a autoria ao Maker (única exceção de mutabilidade do contrato, E2: `evals: []` na aprovação, preenchido uma vez como `local_write` com `eval_authored_by`), mas mantém o portão `tree_before` como vermelho diferido |
| Vermelho por qualquer motivo de falha | falha de compilação ou de ambiente não prova discriminação (E12) |

## Como reverter

Gatilho: fração de `additive` alta o bastante para tornar o vermelho ritual, ou custo de execução
inaceitável. Custo: é um campo do contrato — mudar o default é uma linha em `.ade/config.json`;
remover a fase vermelha exige ADR novo, porque destrói a evidência central.

## Consequências para outros documentos

`schemas/eval.schema.json`, `schemas/task-contract.schema.json` (sem `passes`),
`schemas/unit-result.schema.json` (`sources[]`), `schemas/journal-event.schema.json` (classe
`eval_run`), `docs/specs/` (eval runner, ciclo por story, `ade eval`), ADR 0008 (quem escreve o eval por
classe), ADR 0010 (evals visuais), ADR 0017 (correlação eval/rework na telemetria).

## Emendas (2026-09-17)

- E51: emenda a E12 para `trivial` — `red_reason != 'assertion'` não rebaixa a story para `additive` (que exige eval `negative`/`mutate`, inexistentes em `trivial`); a story para em `awaiting_operator{reason:'red_unproven'}` com o diff pronto, e `ade decide --option accept_unproven` fecha a story como `complete` com a decisão gravada. Caminho feliz da jornada 1 continua com 0 interações.
- E58: o eval runner (C9) passa a exigir reporter estruturado (`--reporter=json` no Vitest/Jest, equivalente por runner) e `numTotalTests ≥ 1`; zero testes executados é `red_reason: 'missing_target'`, nunca verde.
