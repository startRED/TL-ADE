# ADR 0038 — Pasta de parte parada é liberada e a contenção mede contra a árvore de largada (emenda o ADR 0014)

**Status:** Aceito (pedido de Erick, 2026-09-23: a TL-ADE real precisa entregar sozinha um pedido feito no painel)

## Contexto

Duas regras do Slice 1 travaram a primeira entrega real pelo painel:

1. A worktree de uma parte fica em `.ade/wt/<id>`, e os ids se repetem entre missões (S1, S2…). Uma parte parada de uma
   missão antiga ocupava a pasta e a missão nova caía com `UnexpectedTreeStateError`.
2. A contenção media as mudanças contra o `HEAD`. O Claude commitou sozinho na worktree; a contenção viu "sem
   mudanças", estacionou a parte, e o commit dele ficou fora da varredura de segredos.

## Decisão

1. **Pasta ocupada por outra missão é liberada.** Se a worktree da parte está num ramo `ade/<outra missão>/…`, o
   preparo guarda a árvore dela em `refs/ade/checkpoints/kept/<missão>/<parte>` e remove a worktree; o ramo continua no
   git. Worktree da mesma missão segue as guardas de antes (sujeira, ramo em uso, takeover).
2. **Contenção mede contra a árvore de largada.** Arquivos mudados e o diff da varredura de segredos passam a comparar com
   `treeBefore` da parte (a árvore depois da etapa de prova), não com o `HEAD`. Sem `treeBefore` válido, vale o `HEAD`.

## Consequências

- Retomar a missão antiga recria a worktree pelo ramo dela; o que não estava commitado fica no checkpoint.
- Commit de quem escreve no meio da rodada conta como mudança e passa pela varredura de segredos.

## Como reverter

Remover o bloco "Ids de parte se repetem entre missões" de `src/engine/prepare.ts` e voltar `dirtyPaths()` e `'HEAD'` em
`src/contain/contain.ts`.
