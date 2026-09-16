# ADR 0013 — Painel como projeção, takeover por comando, PTY depois

**Status:** Aceito (confirmado por Erick em 2026-09-17) — substitui decisão prévia do `PROMPT.md`
(painel com terminal embutido na v1); `architecture.md` §9.1.

## Contexto

O `PROMPT.md` pede painel com Chat · Missão · Log e terminal embutido para assumir a sessão no meio da
story. Isso arrasta `node-pty`, `@xterm/xterm`, Fastify e WebSocket para a v1 — quatro dependências e
~40 % do código antes de a primeira story rodar sozinha. A pesquisa mostra que a biblioteca de PTY não
está pronta e que o valor do painel só aparece depois que o engine existe.

## Decisão

Três camadas, nesta ordem:

| Versão | Entrega |
| :--- | :--- |
| v1 | `ade report`, `ade status`, `ade journal`, `ade show <ref> --open`, `ade decide <unit> --option retry\|skip\|discard\|pick`, `ade steer <missão> "<nota>"`, `ade plan <pedido> --from <missão>` (§11 E32); `ade takeover <story>` **imprime o comando exato** (`claude --resume <uuid>` + `--add-dir`/`--settings`), grava `human_takeover` e escreve `.ade/missions/<id>/takeover-<story>.cmd` e `.ps1`; `ade release <story>` grava checkpoint e `human_release`, e o ciclo retoma |
| v0.4b | painel web **somente-leitura** como projeção do journal via índice SQLite reconstruível (`better-sqlite3`) + WebSocket, no mesmo commit que cria `packages/web` e liga npm workspaces (§11 E29, E37); toda ação do operador vira `step` antes de virar efeito; `ade serve` imprime no terminal um token aleatório por sessão e checa `Origin` (§11 E34) |
| v0.5+ | PTY embutido (`node-pty` pinado, kill por `taskkill /T /F`), se e só se o item vencer o backlog |

Invariante que atravessa as três: **o painel nunca é fonte de verdade**. O índice é derivado e pode ser
apagado e reconstruído do `journal.jsonl`; navegador fechado não perde nada (C20).

## Evidência

- Digest #29 e `landscape-routing-skills-terminal.md` §4.1: `node-pty` nunca teve 1.2.0 estável
  (beta.15), 62 issues abertas, ≥8 bugs de ConPTY em 2026 — #967 (`kill()` mata PID alheio até 5 s
  depois), #965 (vaza `conhost.exe`), #960 (erro não tratado derruba o host), #894 (~3,5 s de atraso com
  `useConptyDll` + PowerShell 7). Quem abre e fecha PTYs o dia inteiro — o caso da ADE — bate em quatro
  deles.
- Mesmo documento: `@lydell/node-pty` é fork de empacotamento e herda os mesmos bugs; `tmux` exige WSL
  ou MSYS2 no Windows.
- `judgment-J2-journeys.md` linhas 78–86, 111–112, 130: sem painel na v1 o operador lê JSONL de manhã e
  recompõe flags à mão — daí `ade report` e o comando impresso; a proposta que descrevia takeover com
  CLI interativa **e** adiava o PTY não dizia onde o operador digitaria. J2 recomenda explicitamente o
  takeover por linha de comando como fallback da v1.
- `judgment-J3` §2(d): painel como projeção com índice reconstruível é a única forma testável ("browser
  fechado" deixa de ser categoria de falha).
- Digest #25: a sessão que `ade takeover` reabre é a mesma do `--session-id` pré-cunhado pelo engine
  (#11), então o comando impresso não é um atalho — é a sessão real.
- `landscape-routing-skills-terminal.md` §4.4: saída ANSI de modelo é vetor de ataque; `--raw-output`
  nunca, e o `xterm.js` do painel só renderiza o que o PTY entregou com sanitização padrão.

## Trade-offs

A v1 exige que o operador dispare o `.cmd`/`.ps1` gravado (ou copie a linha impressa) para assumir o
terminal, e a leitura da missão é por comando, não por tela. Em troca: zero dependências de terminal e de servidor antes da v1, superfície de ataque menor
(J3 §3) e nenhuma classe de crash nova. `ade takeover` continua sendo o mesmo evento de journal nas três
camadas — a UI muda, o contrato não.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| PTY embutido na v1 | `node-pty` beta com #967/#965/#960 e nenhum substituto (#29); ~40 % do código da v1 |
| Painel como fonte de verdade (SQLite autoritativo) | crash do painel passaria a perder estado; contraria C1 e a matriz de crash (`architecture.md` §6) |
| Painel com escrita direta (botão → efeito) | ação sem `step` não reconcilia; toda ação do painel vira step (C20) |
| `tmux` como backend de terminal | WSL/MSYS2 no Windows (ADR 0022) |
| Vibe Kanban / Conductor como painel pronto | ADR 0019 |

## Como reverter

**Gatilho:** `node-pty` publicar 1.2.0 estável com #967 e #965 fechados, **ou** o dogfood mostrar que o
takeover por comando gravado é o atrito dominante da jornada 4. **Custo:** `node-pty` + `@xterm/xterm`
pinados, canal de bytes no WebSocket já existente, encerramento por `taskkill /T /F` (nunca
`pty.kill()`) e a regra de posse do worktree do ADR 0012 — o evento `human_takeover`/`human_release` e
o checkpoint não mudam, então não há migração de journal.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (`human_takeover`, `human_release`), `docs/specs/operator-surface.md`
(`ade report`, `ade takeover`, `ade release`, os verbos de §11 E32, painel como projeção),
`docs/roadmap.md` (`better-sqlite3`, `ade serve` e npm workspaces só na v0.4b — nunca no slice 1,
defeito apontado em J3 §6), `docs/security/README.md` (token de sessão e `Origin` do `ade serve`),
`docs/journeys.md` (jornadas 4 e 6), ADR 0012, ADR 0015 (durante o takeover só sobra o `contain`),
ADR 0019.

## Emendas (2026-09-17)

Fonte: `architecture.md` §12 (revisão adversarial) e §9 (decisões de Erick). Prevalecem sobre o texto
acima onde houver conflito.

- **§9.1** Confirmado por Erick: o painel ao vivo entra na v1, no navegador, aberto por 2 cliques (o
  lançador `ade.bat`/`ade.cmd` na raiz do repositório ou o atalho gerado por `ade init` sobe `ade serve`
  e abre o navegador já pronto para uso). A interface deve ter aparência de IDE — painel de
  missões/stories à esquerda, diff e evidências no centro, relatório e decisões à direita —, critério de
  aceite de UX medido no dogfood D4. Continua somente-leitura + ações que viram `step` no journal; o
  terminal embutido (PTY) confirma-se para a v0.5. Esta decisão amplia o escopo da v0.4b em relação a
  "projeção mínima": o roadmap registra o acréscimo como [hipótese] de esforço até a medição. O status
  deste ADR deixa de estar pendente.
- **E62** REJ Cancelar story `running` (`operator_cancel`) não entra na v1: Ctrl-C para o lote inteiro
  (lease + reconciliação) e `ade discard` trata a story depois; sem transição nova.
