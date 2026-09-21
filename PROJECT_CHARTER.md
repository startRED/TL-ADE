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

## Recorte ativo de governança da v0.4a (o que entra em `src/` nesta fatia e épico)

`ade run --plan plan.json` executa uma story sob controle prévio de governança e preflight, família `claude`, `local_commit` local, zero rede além da CLI; código em JS ESM com JSDoc, ADR 0023.

- `src/journal`: `canonical.js` (wrapper `canonicalize` + `digest16`), `journal.js` (append/read/fold, `prev`, fd aberto + `fsyncSync`).
- `src/step`: `step.js` (write-ahead, `input_digest`, `intent_context`, fila serializada), `reconcile.js` (tabela por `effect_class`).
- `src/lease`: `lease.js` (`mkdir` + heartbeat 2 s + TTL 15 s, fingerprint pid/start-time; exit 5).
- `src/git`: `gitport.js` (instância por worktree, `worktree_tree` com índice racy, `dirty_paths -z`, checkpoint/restore em `refs/ade/`).
- `src/runner`: `spawn.js` (env explícito, recibo durável, `taskkill /T /F`), `receipt.js`, `resolve-binary.js`.
- `src/contain`: `contain.js` (precedência segurança > sensíveis > escopo, `maxBuffer` explícito), `secrets.js`, `canary.js`.
- `src/gates`: `gates.js` (cache `gate:<id>:<tree>`, restauração de sobras).
- `src/evals`: `eval-runner.js` (`phase: red|green`, `strictness`, evidência).
- `src/pack`: `pack.js` (seções contract, policy, story e skills, teto por seção com ponteiro, redação pós-montagem), `firewall.js`.
- `src/skills`: `catalog.js` (sync, list, inspect, lock atômico), `skillguard.js` (NFKC, 12 controles estáticos, quarentena), `bm25.js` (ranking ponderado sem dependências), `select.js` (filtro duro, BM25 top-8, seletor de até 3 skills com tetos de 7,5k/20k tokens).
- `src/adapters/claude`: argv, `--session-id`, `--json-schema`, parser tolerante, `parse_usage`.
- `src/adapters/codex`: argv, supressão de personalizações nativas (`--ephemeral`, `--ignore-rules`).
- `src/adapters/fake`: CLI falsa para testes determinísticos sem rede.
- `src/cli`: `node:util parseArgs`; `ade run --plan`, `ade doctor` (com suporte a `--skills`), `ade show`, `ade catalog` (`sync`, `list`, `inspect`).
- `src/engine.js`: ciclo da story, `runtime_stamp`; `src/engine`: `preflight.js` (verificações determinísticas puras de preflight na ordem fixa, cálculo de chamadas pagas evitadas), `budget.js` (controles prévios, reservas e tetos), `loop.js`, `schedule.js`, `plan-load.js`.
- `src/schema`: carregador ajv compartilhado dos 8 schemas publicados.
- `schemas/`: 8 arquivos `.schema.json` publicados (`journal-event`, `ade-config`, `plan`, `task-contract`, `eval`, `unit-result`, `review-result`, `capability-set`).
- `fixtures/`: transcripts gravados, cenários da CLI falsa, vetores JCS, corpus do catálogo e SkillGuard (`fixtures/catalog/index-2026-09.json`, `fixtures/skillguard/`).
- `tests/`: Vitest, um arquivo por módulo + `parity/` + `probes/` + `tests/skill-fabric.test.ts`.

Padrões provisórios de execução e custos fixados para o recorte ativo de governança da v0.2 ([docs/adr/0026-governanca-execucao-custos.md](docs/adr/0026-governanca-execucao-custos.md)):
- Teto absoluto de US$ 300 (reserva >= 300 recusada antes do despacho);
- Cota semanal de 50% por assinatura consultada por família via recibo oficial;
- Tempo de parede máximo de 8 horas;
- Limite de até 3 unidades estacionadas;
- Turnos provisórios por classe: `proof: 14`, `implementation: 30`, `correction: 20` e `review: 10`;
- Limites de contexto: contrato de 32000 bytes e pack de 120000 bytes;
- Espaço em disco mínimo de 1 GiB e validade de capacidade de 24 horas.

**Fora do slice 1 e fora do recorte ativo da v0.2, sem exceção — nenhum destes entra em `src/`:** Intent Compiler, entrevista, classificação, Checker como componente da ADE (adapter `codex`, ingestão de `review-result` pelo engine, rework automático), Skill Fabric, FQE, pesquisa, painel, PTY, push/PR/merge/CI, entrega remota, N>1, `agy`, SQLite, Playwright, Fastify, WebSocket. `proto/` é a demo e fica intocada.

**Checker como passo do método.** O operador roda `codex exec` sobre o diff, fora do engine; o Codex é ferramenta de desenvolvimento, nunca importada pelo engine.

**Regra de ampliação.** Item da lista "fora" que apareça em `src/` é motivo de rejeição, não de discussão; o caminho é uma linha em `docs/roadmap.md`.

## Estado e autorização

- Autorização até a v1: concedida por Erick em 2026-09-19 ([docs/adr/0024-autorizacao-roadmap-ate-v1.md](docs/adr/0024-autorizacao-roadmap-ate-v1.md)) e confirmada para governança e custos em 2026-09-20 ([docs/adr/0026-governanca-execucao-custos.md](docs/adr/0026-governanca-execucao-custos.md)).
- Sequência obrigatória dos marcos: v0.2 (durabilidade e paridade 93) -> v0.3 -> v0.4a -> v0.4b -> v0.5 -> v1.
- Recorte ativo deste épico: v0.4a — Skill Fabric (catálogo curado, 12 controles de segurança da cadeia de suprimento, BM25 top-8, seletor de até 3 skills sob tetos de 7,5k/20k tokens, aprovação congelada e injeção sanitizada no Context Pack) e Frontend Quality Engine conforme autorização até a v1 concedida no [ADR 0024](docs/adr/0024-autorizacao-roadmap-ate-v1.md).
- Recorte ativo de governança da v0.4a: catálogo sincronizado sob commit pinado e lock exclusivo, índice de seleção derivado, SkillGuard estático com quarentena, aprovação congelada de skills elegíveis, supressão de personalizações nativas em despacho e monitoramento de drift de memória via doctor ([docs/adr/0024-autorizacao-roadmap-ate-v1.md](docs/adr/0024-autorizacao-roadmap-ate-v1.md), [docs/adr/0026-governanca-execucao-custos.md](docs/adr/0026-governanca-execucao-custos.md)).
- Slice 1: fechamento pendente ([docs/plans/slice-1-fechamento.md](docs/plans/slice-1-fechamento.md)).
- Recorte local v0.2: autorizado sequencialmente ([docs/plans/v02-local-proposta.md](docs/plans/v02-local-proposta.md), [docs/plans/v02-local-aprovacao.md](docs/plans/v02-local-aprovacao.md)).
- Restante da v0.2: segue a ordem do roadmap.
Implementação dependente: autorizada sequencialmente até a v1 conforme o épico ativo. Esta nota não altera exclusões nem ativa a emenda antes do seu marco.
O registro comum de [docs/plans/v02-local-proposta.md](docs/plans/v02-local-proposta.md) exige saída 0 antes de qualquer commit para node node_modules/vitest/vitest.mjs run, node node_modules/typescript/bin/tsc --noEmit e npm run lint, sem npx nem git push.

**Regra de cerimônia proporcional.** Se o diff cabe numa frase, pula plano e brainstorming.
