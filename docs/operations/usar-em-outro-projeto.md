# Usar a ADE em outro projeto

O slice 1 executa **uma story escrita à mão** com Maker `claude`, eval vermelho→verde, `contain` e commit
local numa branch própria. Não planeja, não revisa, não empurra.

## Passos

1. `node <caminho-da-ADE>/bin/ade.js doctor` — sonda real da CLI `claude`; grava `~/.ade/capabilities.json`.
   Sem isso, `ade run` sai com `capabilities_missing` (exit 4).
2. Escreva `plan.json` e `stories/<ID>.json` no formato de `plans/dogfood/` (schemas em `schemas/`):
   `scope_paths`, `do_not_touch`, `autonomy: safe`, um eval com `cmd` começando por `node`,
   `strictness.mode: must_fail_before`.
3. Confirme que o eval está vermelho antes de rodar (`must_fail_before` recusa eval que nasce verde).
4. `node <caminho-da-ADE>/bin/ade.js run --plan plan.json --repo <pasta>`
5. Resultado na branch `ade/<mission_id>/<ID>`; journal em `<pasta>/.ade/missions/<mission_id>/journal.jsonl`;
   `ade status`, `ade journal`, `ade report`, `ade show <ref>` leem o que aconteceu. Merge é manual.

`<pasta>` precisa ser um repositório git limpo. A ADE grava `/.ade/` em `.git/info/exclude`.

## Códigos de saída

0 ok · 2 recusa ou parada final · 3 concluído com paradas · 4 entrada inválida · 5 lease.

## Motivos de parada

| motivo | onde | o que significa |
| :-- | :-- | :-- |
| `budget_calls_exhausted` | engine | `budget.max_model_calls` da story esgotado antes de fechar |
| `story_started_in_journal` | engine | journal já tem a story iniciada: retomada, não início novo |
| `eval_red_not_red` | engine | eval `must_fail_before` passou antes da implementação; story recusada |
| `canary_escaped` | engine | o canário de isolamento da família detectou escrita fora do worktree |
| `budget_usd_exceeded` | budget | custo observado passou de `mission_budget.max_usd` |
| `gate_failed` | engine | um gate do projeto (tsc/lint/test) falhou depois da implementação |
| `eval_green_failed` | engine | eval continuou vermelho depois da implementação |
| `secret` | contain | segredo no diff; blob em `refs/ade/quarantine/`, lote parado antes de qualquer commit |
| `sensitive_path` | contain | diff toca caminho da deny-list (`~/.ssh/**`, `~/.aws/**`, `**/.env*`) |
| `scope` | contain | diff fora de `scope_paths` ou dentro de `do_not_touch`; árvore restaurada, repete → parked |
| `no_changes` | contain | o Maker terminou sem alterar arquivo algum |

Medições da primeira execução real: [`dogfood-d1.md`](dogfood-d1.md).
