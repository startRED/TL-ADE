# ADR 0031 — Trilhos paralelos em cópias isoladas (emenda o ADR 0014)

**Status:** Aceito (decisão do plano da v2 aprovado por Erick, 2026-09-23)

## Contexto

O [ADR 0014](0014-concorrencia-1-git-por-worktree.md) fixou concorrência N=1 na v1 e já pôs cada story na própria worktree e
branch. A demo (`proto/lanes.mjs`) mostrou que partes independentes podem rodar juntas sem perder qualidade, desde que cada
uma tenha cópia git própria, nada use estado global do git (o `git stash` é um só para o repositório inteiro) e as cópias não
fiquem dentro de pasta servida pelo dev server, que recarrega ao ver arquivo novo.

ADR aceito não se edita (`AGENTS.md`); este ADR emenda o 0014 sem alterar o arquivo dele.

## Decisão

1. **Limite configurável, padrão 1.** `ADE_MAX_LANES` fixa quantos trilhos rodam ao mesmo tempo; ausente vale 1, que é o
   comportamento do ADR 0014. Valor que não é inteiro positivo é erro (`invalid_lane_limit`), não padrão calado.
2. **Quem pode rodar junto.** `laneCandidates` (`src/engine/lanes.ts`) escolhe, em ordem de id, partes prontas (dependências
   concluídas) cujo `scope_paths` não sobrepõe o dos trilhos em andamento nem o das outras escolhidas. Sobreposição compara o
   prefixo fixo do glob (antes do primeiro curinga) sem distinguir maiúsculas, porque no Windows e no macOS `src/Foo.ts`
   e `src/foo.ts` são o mesmo arquivo: glob que começa com curinga conflita com tudo. O arquivo de prova fica
   dentro de `scope_paths` (o carregador do plano recusa o contrário), então mesmo arquivo de prova é sobreposição. Parte sem
   escopo declarado nunca divide trilho.
3. **Onde.** Os trilhos rodam no lote `--unattended`, em que cada unidade para no próprio commit revisado (`deliver: false`) e
   a base do operador não anda. No `ade run` assistido a entrega é fast-forward: um segundo trilho acharia a base divergida,
   então ali o escalonador segue em série.
4. **Cópias isoladas.** Cada trilho é uma worktree com branch própria (`ade/<missão>/<story>`) em
   `<ADE_HOME ou ~>/.ade/lanes/<digest da raiz>/<story>`, fora da raiz do projeto e portanto de qualquer pasta servida;
   `lanesDir` recusa pasta que caia dentro do projeto, comparando o caminho textual e o real (links simbólicos e junctions
   de `ADE_HOME` ou dos ancestrais já existentes resolvidos). Descartar e restaurar árvore usa só refs e índice da própria worktree
   (`refs/ade/discarded/<rótulo>/<n>`, invariante I20). O motor não invoca `git stash`.

## Evidência

- `tests/parallel_lanes.test.ts`: escolha até o limite com escopos disjuntos; série com escopo ou arquivo de prova em comum;
  dois trilhos num repositório real em que o descarte de um não muda a worktree do outro; varredura de `src/` sem `git stash`;
  pasta de trilhos fora da raiz; lote desatendido com pico de 2 trilhos e a parte sobreposta esperando.
- As provas de `engine` e `mission-run` seguem verdes com o limite 1.

## Trade-offs

- A comparação de escopo é conservadora: `src/a` contra `src/ab.ts` conta como conflito e serializa sem necessidade, e
  no Linux `src/Foo.ts` contra `src/foo.ts` também, embora lá sejam arquivos distintos.
- As chamadas pagas dos trilhos saem da mesma reserva da missão; com N>1 o teto de chamadas é atingido mais cedo no relógio.
- A pasta de trilhos fica fora do projeto: o operador acha a worktree de uma parte estacionada pelo `evidence_path` do
  `unit_parked`, não em `.ade/wt`.

## Alternativas rejeitadas

- **`git stash` para alternar trabalho no mesmo checkout:** estado global do git; um trilho perderia o trabalho do outro.
- **Worktrees dos trilhos em `.ade/wt` dentro do projeto:** ficam sob a pasta servida pelo dev server.
- **Trilhos no `ade run` assistido:** a entrega fast-forward estacionaria o segundo trilho com `base_diverged`.

## Como reverter

`ADE_MAX_LANES` ausente ou 1 volta ao N=1 do ADR 0014 sem mudança de código. Remover os trilhos por inteiro é um ADR novo que
emende este.

## Consequências para outros documentos

- `docs/adr/README.md`: índice e mapa de durabilidade citam o 0031.
- O painel de trilhos fica para a v5.
