# ADR 0021 — Versionamento do journal e `runtime_stamp` do engine

**Status:** aceito 2026-09-17

## Contexto

A ADE constrói a ADE (ADR 0020): o engine muda várias vezes por dia enquanto missões ficam abertas em
disco. Um journal reconciliado por um engine diferente do que o escreveu é a forma mais silenciosa de
corromper estado durável — a cadeia de hash continua válida, os campos continuam presentes, e a regra de
reconciliação mudou embaixo. O runtime de referência já resolveu isso e o porte tem de ser literal.

## Decisão

Dois carimbos independentes, com semânticas separadas:

| Campo | Semântica | Quando muda | O que faz |
| :--- | :--- | :--- | :--- |
| `format_version` | forma do envelope do evento | **só com migração explícita escrita** | leitor recusa journal de versão desconhecida |
| `runtime_stamp` | `<core_version>:<config_digest>:<capabilities_digest>` (§11 E7) | `core_version` a cada build do núcleo durável (C1–C5, C7); `config_digest` a cada mudança de `.ade/config.json`; `capabilities_digest` a cada mudança do registry de capacidades, o que cobre upgrade silencioso de CLI (`agy` 1.2.3 → 1.2.4 sem ação) | **só `core_version` bloqueia**: intenção aberta com `core_version` divergente para a missão = `stale_workflow_version`, para até `ade run --accept-stale-version`, aceite gravado como `decision`. Divergência apenas de `config_digest` ou `capabilities_digest` é registrada, não bloqueia |

**Extensão do journal é aditiva, nunca substitutiva.** O envelope (`format_version`, `seq`, `at`,
`kind`, `prev`) e os enums fechados de `status` (`ok`/`failed`/`released`/`ambiguous`), `unit_state`,
`attempt.class` e `batch_state` são o contrato de durabilidade e não mudam. A lista de `kind` permanece
como está; `effect_class` **ganha** valores (`eval_run`, `visual_eval`, `research`, `human_takeover`,
`human_release`, `catalog_sync`, mais `gate` e `prepare`, estes dois já antes do slice 1 — §11 E6) e
`step_intent` ganha campos (`worktree`, `receipt_path`, `session_ref`, este último `null` quando o
transporte não pré-cunha id). Todo valor novo de `effect_class` nasce com regra de reconciliação
declarada.

Parser dos adapters é tolerante a campo desconhecido; parser do **journal** não é: campo desconhecido no
envelope é erro, porque significa que um engine mais novo escreveu ali.

## Evidência

- `runtime-port-map.md` I48 (`Runtime.__init__` 1206, `reconcile` 2056-2060, `_version_accepted`
  2095-2096; teste `test_stale_runtime_version_stops_until_accepted` linha 1179): o mecanismo é portado
  **igual**, risco baixo. Já existe e já é testado no runtime v0.17.0.
- `runtime-port-map.md` §186 (tabela de schemas): `step-journal.schema.json` é porte **literal com
  extensão aditiva**; a lista de `kind` fica, `effect_class` ganha os valores novos da spec.
- `architecture.md` §6: "a ADE em dogfood nunca muda o engine embaixo de uma missão sem passar por
  isso" — é o motivo direto de o `runtime_stamp` existir na v1 e não no backlog.
- `addendum-durable-receipt-process-containment-windows.md` §5.2, armadilha nº 2: `1` (int Python) e
  `1.0` (float Python) serializam diferente de JCS, que emite `"1"` para ambos — **fonte real de
  divergência de hash entre journal escrito pelo runtime Python e pelo TS**. Irrelevante porque a ADE
  porta, não migra in-place; mas exige o teste
  `canonicalize_output_byte_identical_to_python_reference_fixture` (§6 do mesmo documento).
- Digest #30: JCS vem do pacote `canonicalize` (Apache-2.0, 0 deps), não de implementação caseira — um
  canonicalizador errado quebra a cadeia **em silêncio** (risco Alto no mapa de porte, I02).
- `judgment-J3` §2(c): eventos sem `input_digest` e sem `intent_context` tornam I05, I11, I14 e I17
  inexequíveis — os campos do envelope não são decorativos, e é por isso que o envelope é fechado.

## Trade-offs

`core_version` divergente para uma missão aberta interrompe o trabalho e exige uma flag explícita do
operador — no dogfood, isso acontece com frequência, e é o custo aceito; separar o stamp em três partes
é justamente o que evita parar a missão por uma mudança de config ou por um upgrade de CLI que não toca
a reconciliação. A alternativa (reconciliar de
qualquer jeito) troca uma parada barata por um estado ambíguo caro. Envelope fechado significa que
qualquer campo novo de primeira classe exige pensar em migração; extensão aditiva dentro dos campos
existentes é a válvula que evita migrações na prática.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Um único campo de versão | versão de forma e versão de comportamento mudam em cadências diferentes: o engine muda diariamente, o envelope quase nunca |
| `runtime_stamp` em duas partes (engine + config) | não detecta upgrade silencioso de CLI, que muda o comportamento sem tocar build nem config; daí `capabilities_digest` (§11 E7) |
| Bloquear a missão por qualquer das três partes | pararia o dogfood a cada `ade doctor` que remedisse uma capacidade; só `core_version` bloqueia |
| Aceitar stamp divergente com aviso | é exatamente o modo de falha silencioso que I48 existe para impedir |
| Migração automática de `format_version` | migração implícita sobre journal com cadeia de hash reescreve evidência; migração é escrita e revisada |
| Canonicalizador próprio | reintroduz as três armadilhas (ordem de chave, `Number::toString`, surrogate isolado) sem os testes que o pacote tem (#30) |
| Continuar a cadeia de um journal Python existente | divergência de `1` vs `1.0`; a ADE porta, não migra |

## Como reverter

Não há reversão — há migração. **Gatilho:** necessidade de mudar a forma do envelope. **Custo:**
escrever o migrador, subir `format_version`, e rodar
`canonicalize_output_byte_identical_to_python_reference_fixture` mais os testes de cadeia. Missões
abertas na versão antiga terminam na versão antiga ou são descartadas para `refs/ade/discarded/`.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (`format_version` fechado, `runtime_stamp`, enums de `status`,
`unit_state`, `attempt.class`, `batch_state`; `effect_class` aditivo com `gate` e `prepare`),
`schemas/capability-set.schema.json` (o `capabilities_digest` cobre `probe_ok`/`probe_mode`/`models[]`),
`docs/specs/` (`stale_workflow_version`, `ade run --accept-stale-version` registrado como `decision`,
`ade doctor` reportando as três partes do stamp corrente e o de cada missão aberta),
`docs/roadmap.md` (o teste de paridade byte a byte do JCS
entra no slice 1), ADR 0002, ADR 0003, ADR 0017 (toda série de telemetria é filtrada por stamp),
ADR 0020 (o dogfood é o que torna o stamp necessário na v1).
