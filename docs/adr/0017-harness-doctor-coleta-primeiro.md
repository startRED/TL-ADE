# ADR 0017 — Harness doctor: coletar primeiro, ablação depois

**Status:** aceito 2026-09-17

## Contexto

A spec v2 colocava "poda medida do harness (A/B estilo Caliper)" na v1. Cada skill injetada, cada
invariante de repo e cada seção do pack custa tokens em toda chamada; sem medição, a poda é opinião. Mas
ablação pareada exige rodar o mesmo lote duas vezes, e a ADE ainda não tem lote para rodar. A pergunta é
o que é barato agora e o que espera.

## Decisão

**v1 coleta; não executa ablação.**

Um evento `kind: 'telemetry'` por `model_call` no journal, com o que a poda vai precisar depois:
`pack_bytes`, `pack_sections[{section, bytes, digest}]`, `skills_injected[{name, bytes, cited}]`,
`tokens_in/out`, `cache_read`, `cache_write`, `cost_usd` + `cost_source`, `tool_output_raw_bytes` vs
`tool_output_model_bytes`, e correlação com `eval_pass`/`rework` pelo `step_id`.

`ade doctor` v1 **só relata**: taxa de injeção, taxa de citação, custo por item, e os dois candidatos
estáticos de poda (redundância entre itens, obsolescência). Não decide, não remove.

A **ablação pareada** entra pós-v1, adotando o protocolo do Caliper (`run` → `run --ablate <item>` →
`compare`) e `claude plugin eval` (que já tem braço baseline), com o ponto cego declarado: o braço Codex
nunca reporta USD e `claude plugin eval` só roda no braço Claude.

## Evidência

- `landscape-context-observability.md` §5.1 e linha 478: **taxa de citação** (o resultado da chamada
  referenciou o digest do item em `sources`) é o critério de "seção usada"; os três candidatos
  automáticos à poda são skill com injeção > 0 e citação = 0 em ≥ N stories, regra redundante e item
  obsoleto.
- Mesmo documento §5.2 e linha 515: recomendação explícita **contra a spec v2** — coleta sem execução é
  barata (é um campo no journal); a execução do A/B não é, e não paga antes de existir lote.
- `landscape-context-observability.md` §5.2: o Caliper instala a skill onde o agente a procura e deixa o
  agente decidir, então a corrida mede descrição (dispara?) e corpo (funciona?) juntos — não
  reimplementar. O exemplo publicado (33,3 % → 100 % de sucesso, −38 % tokens) é do README do
  fornecedor, **não estudo revisado** — não vira meta.
- Digest #83 (Confirmações): ADOPT o protocolo (ablação pareada + `activates`/`expect`/`assert`), não a
  ferramenta como dependência.
- `judgment-J3` §7: só uma proposta do painel carregava `cited` em contrato; a que prometia a métrica de
  citação **não tinha o campo** — metade da coleta da v1 não coletaria. E o cego das três: o braço Codex
  é sempre `cost_usd: unknown`, o que torna o A/B estruturalmente cego em metade do harness.
- Digest #28: Codex não reporta USD (só tokens, inclusive `cache_write_input_tokens` não documentado);
  daí `cost_source: 'estimated'` via `~/.ade/prices.json`. OTel `gen_ai.*` está em status Development e
  não tem tipo de token de cache — export fica pós-v1.
- Digest #26: `claude -p --model haiku` faturou como `claude-sonnet-5` (US$ 0,37 para ecoar 200 bytes) —
  custo declarado não é custo medido; a telemetria é o que fecha essa lacuna.
- Digest #39: Codex omite skills silenciosamente acima de 2 % da janela ou 8.000 chars de listagem —
  "injetado" e "visto pelo modelo" são coisas diferentes, e só `cited` distingue.

## Trade-offs

A v1 acumula dados e não age sobre eles: tetos de pack, número de skills e conteúdo dos invariantes
seguem sendo **[hipótese]** até o dogfood (`architecture.md` §5, tabela de hipóteses). Em troca, o custo
da instrumentação é um campo por evento e zero chamada extra, e quando o A/B rodar ele terá histórico
real em vez de começar do zero.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Ablação pareada na v1 | exige lote e baseline que não existem antes da v1 (`landscape-context-observability.md` §5.2) |
| Reimplementar o Caliper | a ferramenta já faz instalação + ablação + compare; reescrever mede outra coisa (a colagem no prompt, não o disparo) |
| Poda por julgamento do operador, sem métrica | é a spec v2; sem `cited` não há como distinguir item inútil de item silenciosamente truncado (#39) |
| OTel export na v1 | `gen_ai.*` em Development, sem tipo de token de cache (#28) |
| Confiar no custo reportado pela CLI | `--model haiku` faturado como sonnet (#26); Codex não reporta USD (#28) |

## Como reverter

**Gatilho:** telemetria acumulada de ≥ N missões com p90 estável por seção de pack, ou suspeita
concreta de item caro e nunca citado. **Custo:** escrever os specs do Caliper (`activates`/`expect`/
`assert`) e rodar o par `run`/`run --ablate`; a coleta já existe. Se a decisão for o contrário — cortar
a telemetria — o custo é perder a base do harness doctor inteiro e voltar à poda por opinião.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (kind `telemetry`), `schemas/unit-result.schema.json` e
`review-result` (campo `sources`, sem o qual `cited` não existe), `~/.ade/prices.json` (custo
`estimated` do braço Codex), `docs/specs/` (`ade doctor` relata e não decide), `docs/roadmap.md`
(ablação pareada pós-v1), ADR 0009 (`cited` por skill), ADR 0011, ADR 0021 (toda série de custo é
filtrada por `runtime_stamp`).
