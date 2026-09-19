# TL-ADE — Carta do Projeto

## O que a ADE é

A ADE é um scheduler durável, um compilador de contexto e um compilador de intenção. Ela recebe uma
intenção do operador, produz um plano de Task Contracts com aprovação única, e despacha esse plano
para assistentes de IA reais (Claude Code, Codex e, opcionalmente, Antigravity) através de um engine
que escreve tudo em um journal encadeado por hash, com lease, worktree por story, contenção pós-fato
e reconciliação por classe de efeito. Cada story roda um ciclo eval-first: a prova nasce vermelha,
o Maker implementa, a prova fica verde, e o resultado termina em um commit local. A ADE existe para
que uma story rode sozinha do começo ao commit, de forma auditável e recuperável de qualquer crash.
Ela é dona do worktree e do processo, dona do journal, quem roda `git`/`gh` e quem prova 'pronto' por eval executado.

## O que a ADE não é

A ADE não é um IDE, não é um chat de propósito geral e não é um substituto para o julgamento do
operador: o portão substitui a revisão linha a linha, não o humano. A ADE não é um orquestrador que
aposta em janela de contexto maior — o gargalo de missões longas é seguir instrução, não tamanho de
contexto, e o investimento vai para o contrato, não para o modelo. A ADE não reimplementa o que os
binários instalados já fazem nativamente (`claude`, `codex`); ela só escreve o que é insubstituível:
o journal, o Task Contract com eval provado, e o Context Pack. A ADE não é um CI, não é um issue tracker,
não é uma IDE, não é um provedor de modelo (nunca chama API HTTP de modelo; só CLI com assinatura), não é um framework de agentes.

## Escopo do Slice 1 (o que entra em `src/` nesta fatia)

`ade run --plan plan.json` executa uma story `trivial` de plano escrito à mão, família `claude`, `local_commit` local, zero rede além da CLI; código em JS ESM com JSDoc, ADR 0023.

- `src/journal`: `canonical.js` (wrapper `canonicalize` + `digest16`), `journal.js` (append/read/fold, `prev`, fd aberto + `fsyncSync`).
- `src/step`: `step.js` (write-ahead, `input_digest`, `intent_context`, fila serializada), `reconcile.js` (tabela por `effect_class`).
- `src/lease`: `lease.js` (`mkdir` + heartbeat 2 s + TTL 15 s, fingerprint pid/start-time; exit 5).
- `src/git`: `gitport.js` (instância por worktree, `worktree_tree` com índice racy, `dirty_paths -z`, checkpoint/restore em `refs/ade/`).
- `src/runner`: `spawn.js` (env explícito, recibo durável, `taskkill /T /F`), `receipt.js`, `resolve-binary.js`.
- `src/contain`: `contain.js` (precedência segurança > sensíveis > escopo, `maxBuffer` explícito), `secrets.js`, `canary.js`.
- `src/gates`: `gates.js` (cache `gate:<id>:<tree>`, restauração de sobras).
- `src/evals`: `eval-runner.js` (`phase: red|green`, `strictness`, evidência).
- `src/pack`: `pack.js` (5 seções do slice, teto por seção com ponteiro, redação pós-montagem), `firewall.js`.
- `src/adapters/claude`: argv, `--session-id`, `--json-schema`, parser tolerante, `parse_usage`.
- `src/adapters/fake`: CLI falsa para testes determinísticos sem rede.
- `src/cli`: `node:util parseArgs`; `ade run --plan`, `ade doctor`, `ade show`.
- `src/engine.js`: ciclo da story, orçamento, `runtime_stamp`.
- `src/schema`: carregador ajv compartilhado dos 8 schemas publicados.
- `schemas/`: 8 arquivos `.schema.json` publicados (`journal-event`, `ade-config`, `plan`, `task-contract`, `eval`, `unit-result`, `review-result`, `capability-set`).
- `fixtures/`: transcripts gravados, cenários da CLI falsa, vetores JCS.
- `tests/`: Vitest, um arquivo por módulo + `parity/` + `probes/`.

**Fora do slice 1, sem exceção — nenhum destes entra em `src/`:** Intent Compiler, entrevista, classificação, Checker como componente da ADE (adapter `codex`, ingestão de `review-result` pelo engine, rework automático), Skill Fabric, FQE, pesquisa, painel, PTY, push/PR/merge/CI, N>1, `agy`, SQLite, Playwright, Fastify, WebSocket. `proto/` é a demo e fica intocada.

**Checker como passo do método.** O operador roda `codex exec` sobre o diff, fora do engine; o Codex é ferramenta de desenvolvimento, nunca importada pelo engine.

**Regra de ampliação.** Item da lista "fora" que apareça em `src/` é motivo de rejeição, não de discussão; o caminho é uma linha em `docs/roadmap.md`.

## Estado e autorização

- Slice 1: fechamento pendente ([docs/plans/slice-1-fechamento.md](docs/plans/slice-1-fechamento.md)).
- Recorte local v0.2: não autorizado ([docs/plans/v02-local-proposta.md](docs/plans/v02-local-proposta.md), [docs/plans/v02-local-aprovacao.md](docs/plans/v02-local-aprovacao.md)).
- Restante da v0.2: fora desta rodada.
Implementação dependente: bloqueada. Esta nota não altera exclusões nem ativa a emenda.
O registro comum de [docs/plans/v02-local-proposta.md](docs/plans/v02-local-proposta.md) exige saída 0 antes de qualquer commit para node node_modules/vitest/vitest.mjs run, node node_modules/typescript/bin/tsc --noEmit e npm run lint, sem npx nem git push.

**Regra de cerimônia proporcional.** Se o diff cabe numa frase, pula plano e brainstorming.
