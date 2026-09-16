# ADR 0022 — Restrições do Windows como requisito de primeira classe

**Status:** aceito 2026-09-17

## Contexto

Windows 11 é a máquina alvo do operador; Linux é só CI. A maioria das ferramentas do ecossistema assume
POSIX, e as diferenças não aparecem em code review — aparecem como `ENOENT`, `EINVAL`, comando truncado
ou processo órfão em produção. Cada restrição abaixo foi medida nesta máquina (Windows 11 Pro 26200,
Node v24.16.0), não inferida da documentação.

## Decisão

| # | Restrição | Regra da ADE |
| :-- | :--- | :--- |
| W1 | `lpCommandLine` tem teto de **32.767 chars** | O pack vai **sempre** por `{pack_path}`, nunca `{pack_text}` |
| W2 | `spawn('claude')` dá `ENOENT`; `spawn('claude.cmd')` dá `EINVAL` | `BinaryResolver` (C6) lê o shim `.cmd` do npm, extrai e valida o `.exe` real, e usa esse caminho; fallback `cmd.exe /c` só com aviso no `doctor` |
| W3 | `{shell:true}` com `args` é depreciação de **runtime** no Node 24 (DEP0190) | `spawn(..., {shell:false})` sempre |
| W4 | `MAX_PATH` = 260 e dependências nativas quebram em raiz longa | worktrees em caminho curto (`.ade/wt/<id>`); `core.longpaths=true` e `LongPathsEnabled` verificados pelo `ade doctor` |
| W5 | Sandbox de SO do Claude Code **não existe** em Windows nativo e falha aberta | `contain` pós-fato é a fronteira (ADR 0015) |
| W6 | `node-pty` `kill()` pode matar PID alheio (#967) | encerramento por `taskkill /T /F /PID`, nunca `pty.kill()` |
| W7 | libuv cria Job Object com `KILL_ON_JOB_CLOSE` para filho **não-detached** | worker não-detached na v1; contenção da árvore vem de graça; a branch de attach de I09 fica dormente e o teste é v0.5+ (ADR 0012, §11 E21) |
| W8 | `fs` do Node não expõe `flock`/`LockFileEx` | lease próprio: `mkdir` + heartbeat em `worker_thread` a cada 2 s + TTL **15 s [hipótese, medir no slice 1]** + fingerprint (pid, start time), exit 5 em conflito; nenhuma chamada externa síncrona no engine |
| W9 | PID é reciclado em minutos numa máquina de desenvolvimento | todo recibo e todo lease carregam fingerprint; `isAlive(pid)` sozinho nunca adota processo |
| W10 | `tmux` exige WSL ou MSYS2 | fora da v1; o terminal, quando vier, é ConPTY (ADR 0013) |

Paridade: os 93 testes do runtime de referência passam **93/93 nos dois SOs**, com a tabela de
mapeamento de nomes onde o schema mudou (`parity-name-map.json`, artefato de entrada da v0.2) — 44 casos
no slice 1, 93/93 como critério da v0.2 (ADR 0003, §11 E26). O alvo `parity` roda sem credencial no CI
Windows + Linux; as chamadas reais ficam no alvo `probes`, local e opt-in. Testes Windows-específicos do
porte estão nomeados em
`addendum-durable-receipt-process-containment-windows.md` §6.

## Evidência

Tudo em `addendum-durable-receipt-process-containment-windows.md`, salvo onde indicado:

- §1.2 (tabela de spawn executada): nome nu `ENOENT`; shim sh absoluto `ENOENT`; `.cmd` absoluto **lança
  `EINVAL` de forma síncrona**; `cmd.exe /c` funciona em 2.173 ms; o `.exe` real, em **1.877 ms**.
  `codex`, `gh`, `git` e `agy` são `.exe` nativos e funcionam direto — o problema é geral a toda CLI
  instalada via `npm -g` (digest #30).
- §1.3: DEP0190, runtime deprecation desde Node v24 — motivo é injeção de shell, e o pack passa por
  `argv`.
- §2.1–2.2: código do libuv lido e prova empírica com `tasklist` — o neto morre em <300 ms sem rodar o
  próprio handler; `detached:true` escapa do job e sobrevive ao criador. §2.4: zero ocorrências de
  `CreateJobObjectW` em `microsoft/node-pty`, que mata por enumeração de PID (#29, issue #967).
- §3.2: **reuso de PID observado na própria sessão de pesquisa**, minutos depois. §4: `fs` do Node sem
  `flock`; `proper-lockfile` sem publicação desde 2021-01 — abandonado para um requisito inegociável.
- Digest #8 e `addendum-autonomia-permissoes-por-repositorio.md` §1: doc oficial do Claude Code —
  "runs on macOS, Linux, and WSL2. Native Windows is not supported"; sem sandbox ativo, **falha aberta**.
- `ref-graft.md` §1: `install_failed` em raiz longa por dependência nativa compilada — origem de W4.
- Digest #1 e #31: a paridade passa 93/93 no Windows (1 skip); `{pack_text}` com 60k estoura
  `lpCommandLine`.

## Trade-offs

Dez regras explícitas custam código e testes dedicados que não existiriam num projeto POSIX-only
(`BinaryResolver`, lease próprio, fingerprint, `taskkill`). Em troca, nenhuma delas é descoberta em
produção, e Linux em CI ganha o mesmo comportamento sem caminho alternativo — a ADE não tem código
condicional por SO fora do Runner e do GitPort. W7 custa uma chamada paga por crash do engine (ADR 0012).

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Exigir WSL2 | mata o princípio "roda na máquina do operador como está"; e o `agy`/`claude` do operador estão autenticados no Windows nativo |
| `{shell:true}` para resolver o shim | DEP0190 em runtime + injeção de shell no `argv` do pack |
| `cmd.exe /c` como rota padrão | ~300 ms a mais por chamada e risco de reinterpretação de `& \| ^ % "` pelo `cmd.exe` |
| `proper-lockfile` | abandonado; o lease é ~60 linhas próprias (#30) |
| `tree-kill` / `@vscode/windows-process-tree` | última publicação 2019; `taskkill /T /F` já é nativo |
| Addon nativo (napi-rs) na v1 | Rust/MSVC não instalados nesta máquina; o job do libuv já cobre o caso comum (ADR 0012) |

## Como reverter

Cada linha tem gatilho próprio: W2 cai se o npm parar de gerar shims; W6/W10 caem com `node-pty` estável
(ADR 0013); W7 cai com o addon nativo. **Custo:** todas são locais ao `Runner`, ao `BinaryResolver` ou ao
`Lease` — nenhuma está em contrato, schema ou journal, então reverter não migra nada.

## Consequências para outros documentos

`docs/specs/` (Runner, BinaryResolver, Lease, Pack compiler com `{pack_path}`; `ade doctor` verifica
W2, W4 e W5 por execução real e cacheia a resolução de binário por família),
`schemas/capability-set.schema.json` (`launch.cmd` já resolvido para o `.exe` real),
`docs/roadmap.md` (matriz de crash × fase do slice 1 inclui reboot com lease morto-vivo e PID
reciclado; todo teste de contenção verifica por `tasklist`, fonte independente do processo Node),
`docs/operations/autonomy-and-permissions.md` (W5), ADR 0001, ADR 0011 (`{pack_path}`), ADR 0012,
ADR 0013, ADR 0015, ADR 0018.

## Emendas (2026-09-17)

Fonte: `architecture.md` §12 (revisão adversarial). Prevalece sobre o texto acima onde houver conflito.

- **E49** `node_modules` por worktree no Windows é resolvido por **junction** (não symlink, que exige
  privilégio elevado no Windows por padrão) apontando para o checkout base, criada pelo `prepare` quando
  o hash do lockfile do worktree é igual ao do base; se diverge, classe ≥ `bounded` roda o instalador do
  discovery como step `prepare`. A jornada 1 mantém ≤30 s com junction (ver também ADR 0012).
