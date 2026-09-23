# Suíte de dogfood da v1

A suíte roda como suíte Vitest do repositório: `tests/dogfood-suite.test.ts`. Não existe comando
`ade dogfood`. Tudo roda sem rede, com CLI falsa e com entrega num repositório git bare temporário;
nunca contra o GitHub real.

```bash
node node_modules/vitest/vitest.mjs run tests/dogfood-suite.test.ts
```

## O que ela contém

- Catálogo: `fixtures/dogfood/catalog.json`, de 20 a 50 tarefas, cada uma declarando o grupo.
- Os cinco grupos (`DOGFOOD_GROUPS` em `src/evals/eval-runner.ts`): tradutor, jornadas, visual,
  estritez e durabilidade. Cada grupo tem sua checagem em `fixtures/dogfood/checks/`
  (por exemplo `fixtures/dogfood/checks/durabilidade.mjs`).
- Tarefa instável de controle: `fixtures/dogfood/flaky-task.json`.

## Três execuções e aprovação tripla

Cada tarefa roda em três execuções independentes (`runDogfoodSuite`, `runDogfoodTask`). Uma tarefa
só é aprovada quando as três execuções são verdes. Basta uma divergente para reprovar, e a
reprovação traz o grupo e a execução que divergiu.

## Como interpretar

| resultado | leitura |
| --- | --- |
| três verdes | comportamento determinístico; conta como aprovado |
| verde e vermelho misturados | instabilidade; corrija a causa, não rode de novo até passar |
| três vermelhos | regressão real no grupo nomeado |

O `ade eval` roda só os evals do contrato da story e recusa tarefa da suíte de dogfood: a suíte é
prova do motor, não da story. A entrega remota é conferida com `assertTempRemote`, que recusa
remoto fora da pasta temporária.

A calibração dos cortes lê a telemetria destas execuções; veja `docs/operations/unattended-night.md`.
