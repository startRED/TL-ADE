# ADR 0008 — Intent Compiler, Task Contract, classes de complexidade e faixa rápida

**Status:** aceito 2026-09-17

## Contexto

O usuário alvo digita "corrija o botão de login" e não deve precisar de conhecimento operacional. O
gargalo medido em missões longas não é janela de contexto: é instruction following. Logo, o
investimento vai para o contrato que descreve a tarefa, não para o orquestrador que a despacha.

## Decisão

O Intent Compiler faz **context discovery determinístico** (git, `rg`, manifestos, `DESIGN.md`, rotas,
CI, missões anteriores) **antes** de qualquer chamada de modelo, classifica a complexidade em cinco
classes (`trivial`, `bounded`, `feature`, `subsystem`, `project`), expande em camadas
(intenção → resultados observáveis → restrições → EARS → cenários → evals → DesignBrief quando há UI),
entrevista **≤5 perguntas** e emite um plano de **Task Contracts** validado por ajv. O contrato é
**imutável após aprovação** (coberto por `immutable_digest`) e **não tem campo `passes`**: o estado da
story vive no journal (`unit_state`) e na projeção `status.json`, e o veredito no `unit-result` (E1). A
única exceção de mutabilidade é `trivial` com `evals: []` na aprovação, em que o Maker preenche `evals`
uma vez, gravado como step `local_write` com `eval_authored_by` (E2). Aprovação é **única**, no plano, e
congela o conjunto elegível de skills da missão (união do top-8 por story, E33). `plan.mission_budget`
(`max_wall_clock_seconds`, `max_parked_units`, `max_usd`) é gravado no `batch_open`, e
`permitted_effects` lista só efeitos externos (E3). Orçamento default por story e classe **[hipótese]**:
trivial 3 chamadas/1 rework; bounded 6/2; feature 10/3; subsystem e project 12/3 (E4). `trivial` tem
**faixa rápida** com requisito próprio e eval próprio: ≤30 s até a primeira edição de arquivo-fonte, 0
perguntas, ≤2 chamadas — o teste `fast_lane_trivial_starts_within_30s_zero_questions` é critério de
saída da **v0.3**, e o slice 1 só grava `first_source_edit_ms` como baseline (E40). `depends_on` é
opcional: há DAG só quando o plano o declara. O classificador é **determinístico primeiro**: candidato a
`trivial` decidido por regra (1 arquivo tocado no discovery + verbo de correção), com chamada de modelo
só quando a confiança fica < 0,6 ou a classe é ≥ `feature` (E18); quando roda, ela conta dentro das ≤2
chamadas da faixa rápida, e seu custo é medido. A pesquisa dispara por **incógnita declarada do tipo
`external_fact`**, não por classe; o teto é por classe (bounded ≤1 consulta sem time, feature+ até 3,
time paralelo opt-in) (E19). O teto de pack por story tem duas verificações: estimativa no plano
(dividida por cenário) e medição no `prepare`, que poda o contexto recuperado, nunca o contrato, e
reabre a divisão se o contrato sozinho estourar (E20).

## Evidência

- SWE-EVO (`README.md`, Confirmações): instruction following responde por **>60 %** das falhas de
  horizonte longo — o investimento vai para Intent Compiler e Task Contract.
- Digest #22: o harness de longa duração da Anthropic **não usa DAG**: lista plana de features com um
  único campo gravável (`passes`). O DAG é contribuição da ADE e precisa se pagar por classe; o campo
  gravável, não — na ADE o estado fica no journal, fora do contrato (E1).
- Digest #26: `claude -p --model haiku` **faturou como claude-sonnet-5** (US$ 0,37 para ecoar 200
  bytes). "Classificador barato" é hipótese de custo, não fato — daí a regra determinística vir
  primeiro (E18).
- `README.md` (Confirmações): template oficial de contrato = tarefa + guardrails + critérios de
  aceitação + verificação própria; EARS ("WHEN … THE SYSTEM SHALL …") 1:1 com nome de teste.
- `judgment-J1-implementability.md` §6: a faixa rápida de `trivial` é **requisito com eval próprio**, não
  propriedade emergente; e as regras de recusa (pergunta respondível pelo discovery; eval verde de
  nascença volta ao Intent Compiler) são validação, não convenção.

## Trade-offs

A expansão em camadas custa uma chamada forte por plano; classe errada custa processo demais (fila e
perguntas onde bastaria editar) ou de menos (story grande sem revisão de portão) — a classe fica
visível no resumo de aprovação e é corrigível ali. EARS genérico passa na validação de forma
(**[hipótese]** até haver fixtures de recusa semântica). O teto de pack limita o tamanho de story: o
validador recusa e pede divisão, o que às vezes contraria o desenho natural do trabalho — e a segunda
verificação no `prepare` pode reabrir a divisão depois da aprovação, custo aceito para não podar o
contrato. Os orçamentos por classe são chutes calibráveis: baixos demais produzem `awaiting_operator` em
trabalho legítimo.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| DAG obrigatório para toda missão | digest #22; complexidade sem demanda por classe |
| Entrevista aberta / conversacional | conhecimento operacional exigido do usuário; ≤5 perguntas com recomendação primeiro cobre o caso |
| Aprovação por story | quebra a jornada desatendida; a aprovação única já lista efeitos externos e custo |
| Classificador barato assumido sem medição | digest #26; regra determinística cobre o candidato a `trivial` a custo zero (E18) |
| Contrato mutável durante a execução | o veredito seria negociável e a evidência perderia sentido; estado vive no journal (E1) |
| `passes` gravável no contrato | mistura contrato com estado; `unit-result` + `unit_state` já carregam o veredito (E1) |
| Pesquisa disparada por classe de complexidade | classe alta sem incógnita externa gasta chamada à toa (E19) |

## Como reverter

Gatilho: intervenções por classe acima do esperado, ou custo de planejamento dominando a missão. Custo:
a tabela classe → processo é config; mudar o número de perguntas ou o limiar da faixa rápida é uma
linha. Remover o Task Contract, não — é fundação de ADR 0007 e ADR 0010.

## Consequências para outros documentos

`schemas/plan.schema.json` e `schemas/task-contract.schema.json`, `docs/specs/` (Intent Compiler,
entrevista, aprovação), `docs/journeys.md`, ADR 0007, ADR 0009 (skills decididas no `prepare`),
ADR 0015 (`autonomy` e `ask_operator` no contrato), ADR 0016.

## Emendas (2026-09-17)

- E44: `deploy` e `dependency_install` são valores exclusivos do enum de `ask_operator` (E5); não entram em `effect_class` nem em `permitted_effects` — são vocabulário de aprovação, não de efeito.
- E48: `TaskContract.unknowns?[]` entra no contrato e no `task-contract.schema.json` (`id`, `question`, `kind ∈ {product_choice, external_fact, repo_fact}`, `resolved_by?`); a incógnita é do contrato, não do plano.
- E54: a métrica U1 da faixa rápida (`first_source_edit_ms`) ganha definição operacional única — tempo do `ade run` até o primeiro `local_write` em arquivo fora de `.ade/` que não seja arquivo de eval, medido pelo journal.
- E61: rejeitados `max_tokens_in`/`max_tokens_out` em `plan.mission_budget`; `max_usd` + `prices.json` cobrem as famílias com custo reportado, e nas demais o teto é `max_model_calls`.
- E63: a validação de `eval.cmd[0]` contra `scripts` migra do plano para o `prepare` de cada story (re-discovery no worktree); no plano valida-se só a forma. `story.provides_runner` é rejeitado.
- E65: emenda a E4 — `max_model_calls = 2 + 2·visual_rounds + 2·(max_rework_rounds + 1)` [hipótese]; `bounded` com UI passa a 8 chamadas/3 rework (sem UI mantém 6/2); `feature` com UI passa a 12/3.
