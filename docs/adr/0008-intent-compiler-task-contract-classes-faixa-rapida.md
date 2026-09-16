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
imutável após aprovação e `passes` é o **único** campo gravável pelo agente, sempre por evidência.
Aprovação é **única**, no plano. `trivial` tem **faixa rápida** com requisito próprio e eval próprio:
≤30 s até a primeira edição de arquivo-fonte, 0 perguntas, ≤2 chamadas. `depends_on` é opcional: há DAG
só quando o plano o declara. O classificador barato tem custo **medido** por chamada e fallback
determinístico por tamanho de diff estimado.

## Evidência

- SWE-EVO (`README.md`, Confirmações): instruction following responde por **>60 %** das falhas de
  horizonte longo — o investimento vai para Intent Compiler e Task Contract.
- Digest #22: o harness de longa duração da Anthropic **não usa DAG**: lista plana de features com um
  único campo gravável (`passes`). O DAG é contribuição da ADE e precisa se pagar por classe.
- Digest #26: `claude -p --model haiku` **faturou como claude-sonnet-5** (US$ 0,37 para ecoar 200
  bytes). "Classificador barato" é hipótese de custo, não fato.
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
validador recusa e pede divisão, o que às vezes contraria o desenho natural do trabalho.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| DAG obrigatório para toda missão | digest #22; complexidade sem demanda por classe |
| Entrevista aberta / conversacional | conhecimento operacional exigido do usuário; ≤5 perguntas com recomendação primeiro cobre o caso |
| Aprovação por story | quebra a jornada desatendida; a aprovação única já lista efeitos externos e custo |
| Classificador barato assumido sem medição | digest #26 |
| Contrato mutável durante a execução | `passes` seria negociável e a evidência perderia sentido |

## Como reverter

Gatilho: intervenções por classe acima do esperado, ou custo de planejamento dominando a missão. Custo:
a tabela classe → processo é config; mudar o número de perguntas ou o limiar da faixa rápida é uma
linha. Remover o Task Contract, não — é fundação de ADR 0007 e ADR 0010.

## Consequências para outros documentos

`schemas/plan.schema.json` e `schemas/task-contract.schema.json`, `docs/specs/` (Intent Compiler,
entrevista, aprovação), `docs/journeys.md`, ADR 0007, ADR 0009 (skills decididas no `prepare`),
ADR 0015 (`autonomy` e `ask_operator` no contrato), ADR 0016.
