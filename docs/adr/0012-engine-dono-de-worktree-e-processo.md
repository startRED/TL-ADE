# ADR 0012 — O engine é dono do worktree e do processo

**Status:** Aceito (confirmado por Erick em 2026-09-17) — worker não-detached: uma chamada paga perdida
por crash do engine em troca de contenção de graça (`architecture.md` §9.4).

## Contexto

O Claude Code 2.1.271 já entrega `--worktree`, `--bg`, `--tmux`, `--fork-session` e
`claude agents --json|attach|logs|stop|respawn` (digest #25), e o `agy` tem gestão própria de sessão.
Aceitar qualquer um desses como dono do ciclo de vida coloca o estado que o journal precisa
(write-ahead, recibo, reconciliação) dentro de um binário de terceiro, por família. A pesquisa marca
essa decisão como obrigatória e com ADR (#25). `architecture.md` §3 (C4, C5, C6, C12) e §6 fixam a
resposta; este ADR registra o porquê.

## Decisão

O engine é dono **exclusivo** de worktree e de processo, nas três famílias.

| Recurso | Regra |
| :--- | :--- |
| Worktree | criado e destruído pelo engine em `<repo>/.ade/wt/<story>`; `GitPort` é uma instância por worktree, nunca singleton (C4) |
| Spawn | `spawn(..., {shell:false})` no `.exe` real resolvido pelo `BinaryResolver` (C6), `cwd` no worktree, `env` explícito filtrado (I49) |
| Sobrevivência | worker **não-detached** na v1: morre com o engine, a chamada vira `ambiguous`, a árvore suja vira checkpoint. A branch "anexa e espera" de I09 fica **dormente** e o teste de attach é v0.5+ (§11 E21) |
| Vigilância | heartbeat do worker + dead-man switch: sem heartbeat por N s o engine mata o grupo de processos e põe a unidade em `awaiting_operator` com o log em quarentena (§10 A3) |
| Encerramento | `taskkill /T /F /PID`, nunca `pty.kill()` |
| Rastro | recibo durável em `.ade/missions/<id>/jobs/<step>.json` com fingerprint (unit, authorization, cwd, argv, timeout, result_file, pid, start_time) |
| Efeito externo | git/gh só do engine; o worker nunca os roda (C22) |

Flags de worktree/background/agents das CLIs ficam proibidas no adapter: a casca é fina sobre chamada
headless única (C12).

## Evidência

- `addendum-durable-receipt-process-containment-windows.md` §2.1–2.2: libuv cria Job Object com
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` e atribui todo filho não-detached; medido — o neto morre em
  <300 ms sem nunca rodar o próprio handler de saída (digest #30).
- Mesmo documento §3.1: recibo escrito com `fsync`+`rename` é lido por processo frio nas três fases
  (`starting`→`running`→`timeout`); §3.2: **reuso de PID observado na própria sessão** — daí o
  fingerprint.
- §1.2: `spawn('claude')` dá `ENOENT` e `spawn('claude.cmd')` dá `EINVAL`; o `.exe` real funciona e é
  ~300 ms mais rápido que `cmd.exe /c` (digest #30, ADR 0022).
- Digest #29 e `landscape-routing-skills-terminal.md` §4.1: `node-pty` #967, `kill()` acerta PID alheio
  até 5 s depois; §2.4 do addendum: zero ocorrências de Job Object no código do `node-pty`.
- Digest #38: `agy` escreveu fora do `--add-dir` sem avisar — nenhuma CLI é confiável como dona de
  fronteira.
- `judgment-J3` §2: `detached` e Job Object grátis são mutuamente exclusivos; a v1 escolhe.

## Trade-offs

Perde-se uma chamada paga a cada crash do engine no meio de um `model_call` (a branch "anexa" de I09
fica dormente; o recibo com fingerprint serve para decidir `ambiguous` com honestidade e para o
`taskkill` seguro, não para reanexar — §11 E21). Ganha-se contenção da árvore de processos de graça, um
único modo de falha e nenhuma dependência de ciclo de vida por família. Custo do porte: `BinaryResolver` ~40–60 linhas, recibo
~100–150, fingerprint ~30–50 — zero dependência nova.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| `claude --worktree` / `claude agents` como dono | ciclo de vida fora do journal, sem id pré-cunhado no nosso controle, existe em uma família só — paridade entre famílias fica impossível (#25) |
| Worker `detached` + attach na reconciliação | escapa do Job Object do libuv; a contenção deixa de ser grátis e exige o addon nativo antes da v1 (J3 §2) |
| `node-pty` como mecanismo de contenção | não tem Job Object; mata por enumeração de PID (#29) |
| `tmux`/Claude Squad | exige WSL ou MSYS2 no Windows (ADR 0019) |

## Como reverter

**Gatilho:** `doctor_containment_selftest_per_adapter` mostrar que alguma CLI real escapa da cascata do
job, **ou** a taxa medida de chamadas perdidas por crash do engine passar do aceitável no dogfood.
**Custo:** addon napi-rs com `CREATE_SUSPENDED` + `AssignProcessToJobObject` + `TerminateJobObject`
(~150–200 linhas Rust, mais o stdio, porte 1:1 de `tl_job.py` 1083-1180), toolchain Rust (não instalado
nesta máquina) e CI multiplataforma para prebuilds. `receipt_path`, `fingerprint` e a classe
`ambiguous` já estão em contrato: a troca é local ao Runner, sem migração de journal.

## Consequências para outros documentos

`schemas/journal-event.schema.json` (`worktree`, `receipt_path`, `session_ref`),
`schemas/capability-set.schema.json` (`probe_ok` do canário de contenção), `docs/specs/` (Runner,
BinaryResolver, GitPort, `ade doctor`), `docs/roadmap.md` (matriz de crash como aceite do slice 1),
ADR 0013 (takeover é transferência de posse do worktree), ADR 0014, ADR 0015, ADR 0022.

## Emendas (2026-09-17)

Fonte: `architecture.md` §12 (revisão adversarial) e §9 (decisões de Erick). Prevalecem sobre o texto
acima onde houver conflito.

- **§9.4** Confirmado por Erick: o worker morre com o engine (fechar o terminal ou Ctrl-C encerra o
  trabalho; nada roda escondido em segundo plano). O status deste ADR deixa de estar pendente.
- **E42** `prepare` recusa despacho em worktree com `takeover.json` presente: a story para em
  `awaiting_operator{reason:'takeover_open'}`; `ade decide --option retry` sobre essa story devolve a
  mesma parada; sem exit code novo (exit 3).
- **E49** `node_modules` por worktree: o `prepare` cria junction (Windows) ou symlink apontando para o
  checkout base quando o hash do lockfile do worktree é igual ao do base; se diverge, classe ≥ `bounded`
  roda o instalador do discovery como step `prepare`; `trivial` com lockfile divergente para em
  `awaiting_operator{reason:'environment'}`.
- **E64** `local_merge` fast-forward da branch da story para a base entra em `safe` quando a base não
  mudou desde o `prepare` (ff-only, ref de origem preservada em `refs/ade/`); se a base mudou, o commit
  fica na branch da story e o `report.md` imprime o comando de merge.
