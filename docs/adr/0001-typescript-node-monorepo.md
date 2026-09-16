# ADR 0001 — TypeScript sobre Node 22+, ESM estrito, pacote único na raiz na v1

**Status:** aceito 2026-09-17

## Contexto

O runtime de referência que a ADE porta é Python (`tl_runtime.py` 2470 linhas, `tl_job.py` 2562), mas
tudo o que a ADE consome é JS/TS: as CLIs alvo, Playwright, o ecossistema de skills e o painel da v0.4.
A escolha de stack fixa o custo de porte, a superfície de dependência nativa no Windows e a forma do
repositório antes da primeira linha.

## Decisão

Node ≥ 22 (24.16 instalado), TypeScript estrito, ESM. **Pacote único na raiz** na v1 (engine, adapters,
intent, skills, fqe, cli em `src/`): sem `workspaces` no `package.json`, sem diretório `packages/`. npm
workspaces entram **no mesmo commit** que cria `packages/web`, na **v0.4b** — não antes (E29).
Dependências de runtime da v1: `canonicalize` (JCS), `ajv`, `playwright` (só no FQE). CLI com
`node:util` `parseArgs`. Testes com Vitest, paralelismo por caso com tmpdir próprio por worker. Dois
alvos normativos de suíte, `parity` (zero credencial, CI Windows + Linux) e `probes` (chamadas reais,
local, opt-in), separados desde o dia 1 (E26). `better-sqlite3` entra junto com o painel (v0.4b), nunca
antes. Fastify, WebSocket, `node-pty` e xterm ficam fora até v0.4b/v0.5. pnpm não é adicionado.

## Evidência

- `canonicalize` é Apache-2.0 com zero dependências; `proper-lockfile` está abandonado (lease vira ~60
  linhas próprias); `spawn('npx.cmd')` sem `shell:true` falha com EINVAL no Node 24/Windows; libuv já
  cria Job Object com `KILL_ON_JOB_CLOSE` para filhos não-detached (digest #30).
- `node-pty` nunca teve 1.2.0 estável e o bug #967 mata processo não relacionado (digest #29): excluído
  da v1 por ADR 0013.
- Playwright entra como biblioteca, nunca como MCP (digest #21).
- `judgment-J1-implementability.md` §2 pontua K2 = 9 para a base adotada exatamente por "Node 22 +
  `canonicalize` + `ajv` + `child_process`, nada mais"; §4 aponta `better-sqlite3` sem consumidor como
  sintoma de lista de dependências não derivada do escopo.
- `runtime-port-map.md` §0: 93 casos, ~11,7 s/caso, 18 min em série — a suíte TS precisa de paralelismo
  por worker para o ciclo de paridade ser usável.

## Trade-offs

TypeScript estrito custa tempo de tipagem no porte de ~5k linhas de Python dinâmico, e o porte literal
(ADR 0003) proíbe refactor oportunista para pagar esse custo. ESM mais módulo nativo tem atrito
conhecido no Windows — resolvido adiando `better-sqlite3`. Pacote único na raiz elimina até a cerimônia
de `workspaces` na v1; o preço é um `git mv` de `src/` para `packages/core/` quando o painel chegar na
v0.4b, custo de um commit mecânico.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Python (continuidade com o runtime de referência) | Playwright, Impeccable, skills e painel são JS/TS; o porte paga-se uma vez |
| pnpm | não instalado nesta máquina; troca de gerenciador não resolve problema medido |
| Deno / Bun | compatibilidade de `spawn` com shims `.cmd`/`.exe` e de addons nativos não medida no Windows |
| npm workspaces com um pacote só desde o dia 1 | cerimônia sem segundo consumidor (E29); workspaces nascem com `packages/web` |
| Múltiplos pacotes desde o dia 1 | YAGNI (J1 K3); split é `git mv` quando houver segundo consumidor |
| CLI com commander/yargs | `parseArgs` cobre o conjunto de comandos da v1 |

## Como reverter

Gatilho: um módulo nativo obrigatório na v1, ou tempo de build/typecheck que atrapalhe o ciclo de
dogfood. Custo: baixo — criar `packages/` e mover arquivos com `git mv`, ajustando `exports`; nenhum
contrato publicado depende do layout de pacotes.

## Consequências para outros documentos

`docs/roadmap.md` (o que cada slice pode importar; v0.4a sem workspaces, v0.4b com), `docs/specs/`
(engine e CLI), ADR 0013 (painel da v0.4b carrega `better-sqlite3`, os workspaces e o segundo pacote),
ADR 0022 (shims, `lpCommandLine`, caminhos curtos), `ade doctor` (checagem de versão de Node).
