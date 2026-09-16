# ADR 0012 — O engine é dono do worktree e do processo

**Status:** aceito 2026-09-17

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
| Sobrevivência | worker **não-detached** na v1: morre com o engine, a chamada vira `ambiguous`, a árvore suja vira checkpoint |
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
fica dormente). Ganha-se contenção da árvore de processos de graça, um único modo de falha e nenhuma
dependência de ciclo de vida por família. Custo do porte: `BinaryResolver` ~40–60 linhas, recibo
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
