# ADR 0047 — Revisor roda comandos numa cópia descartável e prova o que acha

**Status:** Aceito (pedido de Erick, 2026-09-26: achados errados do revisor geravam rodadas de discussão)

## Contexto

Na medição das duas missões reais (ver [ADR 0046](0046-maker-retoma-a-sessao-no-mesmo-degrau.md)), 13 das 26 subidas da
escada vieram de revisão com mudanças pedidas. O revisor só lia: o Claude revisava sem Bash nem escrita, o Codex em
`--sandbox read-only` e o agy em `--mode plan`. Sem poder rodar nada, o revisor afirmava defeitos que não existiam, o
maker respondia, o revisor insistia, e cada ida e volta era uma rodada. Dar Bash na worktree do maker não é opção: o
Claude não tem sandbox de escrita para o Bash, e a worktree é a árvore que o motor comita.

## Decisão

1. **Cópia descartável da árvore revisada** (`src/review/scratch.ts`): uma worktree git sem ramo no `HEAD` do maker,
   com a árvore revisada por cima e sem commit, fora do projeto (`<tmp>/ade-review/<missão>-<parte>-r<rodada>`). O
   revisor vê as mudanças com `git diff HEAD`. O `node_modules` chega pelo mesmo atalho da worktree do maker
   (`linkNodeModules` de `src/engine/prepare.ts`: junction no Windows). A cópia é apagada no fim da revisão, o atalho
   primeiro e sozinho, para nunca descer no `node_modules` do projeto.
2. **O revisor trabalha na cópia**: `cwd` da chamada é a cópia e ela vai com `scratch: true`. Claude: sem a trava de
   leitura, com a mesma lista do maker (sem `git commit`, `git push`, `gh pr`). Codex: `--sandbox workspace-write`,
   aceito para o revisor só com `scratch`. agy: sem `--mode plan`. A política de revisão diz que a pasta é descartável.
3. **Achado que bloqueia precisa de prova executável**. O revisor grava `.ade-review/<id>.json` na cópia com
   `{"argv": [...], "exit_code": n, "output": "..."}` (argv sem shell, começando por `node`; um teste que falha fica em
   `.ade-review/` e o argv o roda) e cita `artifact:.ade-review/<id>.json` no achado e na `evidence`. Cabe no
   `review-result` atual: `artifact:` já é uma ref tipada do schema, e o motor passa a verificar as que existem na cópia.
   Nenhum schema mudou.
4. **Sem prova, o achado é rebaixado para `low`** (não bloqueia) e o journal ganha `decision: finding_demoted_no_evidence`
   com os ids e a severidade original; o `review_result` gravado antes continua com o parecer original. Vale para todo
   achado que `isBlockingFinding` bloquearia (critical, high e medium para o maker).
5. **Pedido de mudança que ficou só com achados rebaixados é entregue** (`next: 'deliver'` na mesma decisão): portões e
   provas oficiais já estão verdes e não sobra nada para o maker corrigir; outra rodada só gastaria cota. É a suposição
   conservadora deste ADR diante da regra "sem prova não bloqueia".
6. **Com prova, a ação pedida ao maker leva o comando, o código de saída e a saída**; os arquivos das provas ficam na
   pasta da missão (`review-proofs/r<n>`, durável: a retomada relê de lá sem nova chamada) e são copiados para
   `.ade/review/r<n>` da worktree do maker, fora do commit, como os prints da avaliação visual.
7. **O revisor continua sem alterar a árvore do maker**: depois da revisão o motor compara a árvore da worktree com a
   revisada; diferente, a parte estaciona em `checker_touched_maker_tree`, como no canário. O revisor continua de
   outra empresa (ADR 0005, regra inalterada).

## Evidência

- `tests/review_scratch.test.ts`: cópia com a árvore revisada, `node_modules` e o mesmo diff do maker; escrita na cópia
  não muda a worktree; remoção sem tocar o `node_modules` do projeto; rebaixamento e ação com o comando.
- `tests/review-convergence.test.ts`: revisor despachado na cópia com `scratch`, cópia apagada no fim, achado sem prova
  rebaixado e entregue, achado com prova volta ao maker com o comando.

## Trade-offs

- A prova é conferida pela forma, não reexecutada pelo motor (comentário `ponytail` em `applyReviewProofs`): um revisor
  pode gravar uma saída inventada. Reexecutar o argv custaria o tempo de mais uma suíte parcial por achado.
- Criar a worktree da cópia custa um checkout do `HEAD` por revisão; em repositório grande são segundos.
- O Codex em `workspace-write` na cópia escreve pelo atalho do `node_modules` no do projeto se algum comando gravar
  cache ali, como já acontece com o maker.

## Alternativas rejeitadas

- **Bash do revisor na worktree do maker**: a revisão escreveria na árvore que será comitada, sem sandbox no Claude.
- **Cópia por `fs.cpSync` da pasta**: leva `dist/`, caches e o que o `.gitignore` tira, e o revisor perde o `git diff`.
- **Campo novo no schema para o comando**: o formato dos 9 schemas não muda sem story própria; `artifact:` resolve.

## Como reverter

Despachar o revisor com `cwd: worktreeDir`, `sandbox: 'read-only'` e sem `scratch`, e tirar `applyReviewProofs` do
motor, volta ao revisor só leitura.

## Consequências para outros documentos

Nenhum ADR aceito foi editado.
