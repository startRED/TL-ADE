# ADR 0014 — Concorrência N=1 na v1, Git por worktree desde o dia 1

**Status:** aceito 2026-09-17

## Contexto

A spec v2 fixava concorrência 1 com `Git` singleton e worktrees "no futuro". O runtime de referência
prova que essa combinação é uma armadilha: `tl_supervisor.py` (pool de worktrees, `claim_scope`, fila de
merge, sweep de órfãs) está escrito, testado e **nunca é chamado** pelo runtime (digest #33). Separar as
duas decisões — quantas stories correm ao mesmo tempo (N) e quem é dono do índice git (singleton vs
worktree) — é o que torna N>1 reversível.

## Decisão

**N=1 na v1. Git por worktree desde o primeiro commit.**

- `GitPort` é instanciado por worktree (`git -C <wt>`, `GIT_INDEX_FILE` próprio em `worktree_tree`),
  nunca singleton (C4).
- `step_intent` e `unit_state` carregam o campo `worktree` desde a v1, mesmo com N=1.
- O `Scheduler` (C14) tem `next_ready` devolvendo **conjunto**, com `depends_on` opcional; a v1 consome
  o primeiro elemento. **Nenhuma classe de complexidade libera N na v1**: N>1 é opt-in por config e
  pós-v1, e mesmo lá só nas classes `subsystem` e `project` (`architecture.md` §5).
- Um único escritor por árvore; paralelismo só em trabalho somente-leitura (pesquisa, ADR 0016).
- A guarda de árvore suja (I29) passa a ser por worktree, e deixa de ser bloqueio global.

## Evidência

- Digest #33: `grep tl_supervisor scripts/tl_runtime.py` = 0 ocorrências; o pool existe e não é usado.
  `runtime-port-map.md` §5.1 e a linha 175 da tabela de herança: sobrevive como projeto, não como código.
- `runtime-port-map.md` I60 (`test_linked_worktree_is_supported`, linha 349): `Git.git_path` já resolve
  worktree linkado — pré-requisito do N>1 já portado de graça.
- I21 (`test_worktree_tree_sees_a_same_size_rewrite_within_one_second`): a identidade da árvore depende
  de `GIT_INDEX_FILE` por chamada e do truque do índice racy (`utimes(idx,1,1)`); com singleton isso
  colide silenciosamente entre stories.
- `runtime-port-map.md` §5.2: os aditivos de evento (`worktree`) e a instanciação por worktree são
  baratos antes do primeiro commit e caros depois.
- Digest #21 e `landscape-harnesses.md` §269–270: Anthropic mede +90,2 % em pesquisa com ~15× tokens e
  pouca paralelização real em coding; Cognition nomeia escritores paralelos na mesma árvore como o modo
  de falha. Paralelize leitura, serialize escrita.
- `judgment-J3` §6, item 4: N=2 na v1 materializa duas worktrees e **nenhuma proposta custeia
  `node_modules` por worktree** num repo JS — ou compartilha e quebra o isolamento, ou instala duas
  vezes. Buraco 8 da lista de J3.

## Trade-offs

N=1 deixa a máquina ociosa enquanto uma story espera uma chamada de modelo, e uma missão de 20 stories
leva o tempo da soma. Em troca, a v1 não paga fila de merge, `claim_scope`, sweep de órfãs, nem o custo
de `node_modules` duplicado — e não tem a classe de bug de dois escritores na mesma árvore. O campo
`worktree` no evento custa um campo aditivo e compra a migração inteira.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| `Git` singleton com worktrees depois | é exatamente o estado do runtime de referência: o supervisor pronto que nunca foi ligado (#33); o custo do retrofit de `GIT_INDEX_FILE` e do campo de evento é maior depois |
| N=2 na v1 (proposta B) | superfície comprada antes de existir v1; `node_modules` por worktree sem custeio (J3 §6 e §9) |
| Frota de 20–30 agentes (Gas Town) | 22,7 % de CI verde medido no dashboard do próprio org (ADR 0019, `landscape-dev-workflows.md` b5) |
| DAG completo desde a v1 | o harness de longa duração da Anthropic usa lista plana com um campo gravável (`passes`, digest #22 — na ADE esse campo é do backlog de desenvolvimento, não do Task Contract: §11 E1 tirou `passes` do contrato e o veredito vive no `unit_state` e no `unit-result`); o DAG é contribuição da ADE e só se paga por classe (`architecture.md` §5) |

## Como reverter

**Gatilho:** o dogfood mostrar tempo de parede como gargalo real de uma missão `subsystem`/`project`
(jornada 6), com stories de `scope_paths` disjuntos. **Custo:** porte do `tl_supervisor.py` (pool,
`claim_scope`/`_paths_overlap`, `enqueue_merge`/`advance_merge_queue`, `sweep_orphan_worktrees` com
heartbeat), reserva de orçamento por slot no Scheduler, e a decisão sobre `node_modules` por worktree.
Nenhuma migração de journal: `worktree` já está no evento e `next_ready` já devolve conjunto.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (`worktree` em `step_intent` e `unit_state`),
`schemas/plan.schema.json` e `schemas/task-contract.schema.json` (`depends_on` declarativo desde a v1,
mesmo com execução serial), `docs/specs/` (Scheduler com `next_ready` devolvendo conjunto, estado
`blocked`, `git worktree prune` e varredura de órfãs no `ade doctor` mesmo com N=1), `docs/roadmap.md`
(N>1 inteiramente pós-v1; opt-in só em `subsystem`/`project` quando vier), ADR 0012, ADR 0019, ADR 0022.
