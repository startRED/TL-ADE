# ADR 0013 — Painel como projeção, takeover por comando, PTY depois

**Status:** aceito 2026-09-17, pendente de confirmação do Erick — contraria decisão prévia do
`PROMPT.md` (painel com terminal embutido na v1); é o item 1 de `architecture.md` §9.

## Contexto

O `PROMPT.md` pede painel com Chat · Missão · Log e terminal embutido para assumir a sessão no meio da
story. Isso arrasta `node-pty`, `@xterm/xterm`, Fastify e WebSocket para a v1 — quatro dependências e
~40 % do código antes de a primeira story rodar sozinha. A pesquisa mostra que a biblioteca de PTY não
está pronta e que o valor do painel só aparece depois que o engine existe.

## Decisão

Três camadas, nesta ordem:

| Versão | Entrega |
| :--- | :--- |
| v1 | `ade report`, `ade status`, `ade journal`, `ade show <ref>`; `ade takeover <story>` **imprime o comando exato** (`claude --resume <uuid>` + `--add-dir`/`--settings`) e grava `human_takeover`; `ade release <story>` grava checkpoint e `human_release`, e o ciclo retoma |
| v0.4 | painel web **somente-leitura** como projeção do journal via índice SQLite reconstruível (`better-sqlite3`) + WebSocket; toda ação do operador vira `step` antes de virar efeito |
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

A v1 exige um copiar-colar do operador para assumir o terminal, e a leitura da missão é por comando, não
por tela. Em troca: zero dependências de terminal e de servidor antes da v1, superfície de ataque menor
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
copiar-colar do takeover é o atrito dominante da jornada 4. **Custo:** `node-pty` + `@xterm/xterm`
pinados, canal de bytes no WebSocket já existente, encerramento por `taskkill /T /F` (nunca
`pty.kill()`) e a regra de posse do worktree do ADR 0012 — o evento `human_takeover`/`human_release` e
o checkpoint não mudam, então não há migração de journal.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (`human_takeover`, `human_release`), `docs/specs/operator-surface.md`
(`ade report`, `ade takeover`, `ade release`, painel como projeção), `docs/roadmap.md` (`better-sqlite3`
e `ade serve` só na v0.4 — nunca no slice 1, defeito apontado em J3 §6), `docs/journeys.md` (jornadas 4
e 6), ADR 0012, ADR 0015 (durante o takeover só sobra o `contain`), ADR 0019.
