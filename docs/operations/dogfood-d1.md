# Dogfood D1 — `ade run` real sobre a própria ADE

Registro da primeira execução real do motor durável (slice 1) numa story da própria ADE: `ADE-D1`,
"Campo attempt opcional no journal-event" (`plans/dogfood/journal-event-field.plan.json`). Linhas
`- chave: valor` são lidas por `tests/docs_operations.test.ts`; não mude o formato sem mudar a prova.

## Execução

- commit_base: 9a37c9832ce92b085f4eb9aabd6ffb64589ef01a
- branch: ade/ade-dogfood-d1/ADE-D1
- commit_story: e733575395575c9098ab3a2d195d485ac15ef16f
- tree_before: ea4e4ba95273d5e623aa0d0310b2c4b53f9e72e9
- maker: claude / claude-sonnet-5, 1 chamada, `--safe-mode`, `--max-budget-usd 3`
- eval: E1 `node plans/dogfood/check-attempt.mjs` — vermelho (exit 1, `red_reason: assertion`) antes, verde depois
- contain: ok, 1 arquivo (`schemas/journal-event.schema.json`), sem violação
- gates: nenhum declarado no plano D1 (`gates_done` vazio); tsc/lint/vitest rodaram fora do motor
- comando: `node bin/ade.js run --plan plans/dogfood/journal-event-field.plan.json --repo .`

## Custo e tempo

- inicio_utc: 2026-09-18T15:41:58Z
- fim_utc: 2026-09-18T15:42:25Z
- duracao_s: 27
- custo_observado_usd: 0.28
- maker_wall_ms: 20871
- tokens: input 10, cache_write 20546, cache_read 77346, output 1472 (`source: reported`)
- probe_usd: 0.005
- first_source_edit_ms: não disponível (substituída por maker_wall_ms)

`probe_usd` é a sonda do `ade doctor` (Haiku 4.5, `bootstrap_cost_tokens: 4643`, a US$ 1/M de entrada);
a CLI não reporta o custo da sonda, o número é derivado.

## Paradas

- Nesta execução: nenhuma (20 eventos no journal, `story_done` com `status: committed`).
- Tentativas anteriores (2026-09-18 12:16–12:47 UTC, motor em `2f11a10`): 6 retomadas com
  `step_result released / receipt_no_dispatch`. O recibo do maker ficava em `state: starting` sem
  `process_fingerprint` porque `withRunning` lançava `TypeError: fingerprint inválido` — o `start_time`
  do processo no Windows vem com 7 casas decimais e o validador só aceitava 3. Cada retomada adotava o
  lease (`heartbeat_expired`, ~245 s) e liberava o passo de novo. Corrigido em `3db0cd8`.
- Ao repetir depois da correção: `prepare` abortou com `worktree já associado à branch main, esperada
  ade/ade-dogfood-d1/ADE-D1` — `git worktree remove --force` deixou `.ade/wt/ADE-D1` com `node_modules`,
  e a pasta sem `.git` resolve o HEAD para o repositório pai. Limpeza manual: `rm -rf .ade/wt/ADE-D1`
  e `git worktree prune`. Dívida: `prepare` deve tratar pasta sem `.git` como lixo e recriar.

## Falhas e correções

- `src/runner/receipt.js`: formato de `start_time` do fingerprint (Windows `.fffffff`, Linux
  `bootId:ticks`) — `3db0cd8`.
- `src/gates/command.js`, `src/evals/eval-runner.js`: `cmd[0]` recusava `process.execPath` sem extensão
  (`/…/bin/node` no CI Linux; 2 testes vermelhos no Ubuntu, verdes no Windows) — `9a37c98`.
- Lição de contrato: a story de dogfood pedia ao maker "medições reais de operador"; um modelo não tem
  esse dado e girou 6 rodadas em `receipt.js`. Registro de operação é tarefa do operador (este arquivo),
  não critério de aceite de story.
