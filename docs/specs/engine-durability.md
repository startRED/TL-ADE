# Spec — Engine durável (journal, step, reconciliação, processo)

Data: 2026-09-17. Fonte canônica: `docs/architecture.md` §6 (Durabilidade), §3 (C1–C14), §4 (contratos).
Este documento detalha; não redecide. Fontes de evidência: `docs/research/runtime-port-map.md` §1
(I01–I66), `docs/research/addendum-durable-receipt-process-containment-windows.md` (recibo, Job Object,
lease, JCS, shims), `docs/research/design-panel/judgment-J3-durability-security-cost.md` (buracos),
digest `docs/research/README.md` #N. Runtime de referência: `tl-orchestrator-release` v0.17.0
(`docs/RUNTIME.md`, `scripts/tl_runtime.py`, `scripts/tl_job.py`).

Alvo de porte: `src/` do **pacote único na raiz** (layout em `docs/plans/slice-1.md` §2) (TypeScript estrito ESM, Node ≥ 22); npm workspaces
(e um eventual `packages/core`) só no commit que cria `packages/web`, na v0.4b (architecture.md §11 E29).
Dependências que este
subsistema pode usar: `canonicalize` (JCS), `ajv`. Nada mais — sem `proper-lockfile` (abandonado, digest
#30), sem `tree-kill`, sem addon nativo na v1.

---

## 1. Journal

### 1.1 Formato

Um arquivo por missão: `<repo>/.ade/missions/<id>/journal.jsonl`. Uma linha = um `JournalEvent`
(`schemas/journal-event.schema.json`, envelope em architecture.md §4), serializado por **JCS** e terminado
em `\n`. Append-only; nenhuma linha é reescrita, nunca.

| Campo | Regra |
| :--- | :--- |
| `format_version` | `1`. Só sobe com migração explícita (§16) |
| `seq` | monotônico por missão, começa em 1, sem buracos. Buraco = recusa (exit 2) |
| `at` | `YYYY-MM-DDTHH:MM:SSZ` — **segundos, UTC, sem milissegundos**. `new Date().toISOString().replace(/\.\d{3}Z$/,'Z')` (port-map §1.2; ms quebram o parser de orçamento) |
| `prev` | 16 primeiros hex do SHA-256 da **linha anterior inteira, como bytes gravados**. Primeira linha: 16 zeros |
| `kind` | enum fechado de architecture.md §4 |
| `effect_class` | enum fechado; obrigatório em `step_intent`/`step_result` |
| `runtime_stamp` | três partes: `<core_version>:<config_digest>:<capabilities_digest>` (§16, architecture.md §11 E7) |
| `worktree` | caminho relativo do worktree da story; presente em todo step mutante desde o dia 1 (I60, digest #33) |
| `receipt_path` | presente em `step_intent` de `model_call`; aponta para `jobs/<step_id>.json` |
| `session_ref` | id pré-cunhado (`--session-id`) ou `null` quando o transporte não pré-cunha (architecture.md §7) |

### 1.2 Canonicalização (JCS, RFC 8785)

`canonicalize@5` (Apache-2.0, 0 deps, 2,5 M downloads/semana — addendum §5.1). Nunca `JSON.stringify` cru:
não ordena chaves, e serializa surrogate isolado sem erro. As três armadilhas e o que o pacote faz estão
em addendum §5.2. Consequência de porte registrada: um journal escrito pelo runtime Python pode divergir em
campo numérico `float` de valor inteiro (`"1.0"` vs `"1"`); irrelevante porque a ADE **inicia cadeia nova**,
mas o teste de paridade cross-linguagem fica na suíte (addendum §6).

JCS é usado em três lugares e só três: linha do journal, `input_digest` do step (§2), `immutable_digest`
do escopo congelado / `approval.digest` do plano (I53).

### 1.3 Cadeia de hash e leitura

`read()` valida `prev` de cada linha contra o SHA-256 da anterior e `seq` contra o contador. Linha
adulterada, removida, inserida ou JSON inválido → **recusa, exit 2, nunca ignorada em silêncio** (I02, I61).
A cadeia é a ordem total de eventos da missão; não há journal por story (§17).

**Cauda torn é caso separado de adulteração.** O append é `writeSync` + `fsyncSync` (§1.4): uma queda
entre os dois — exatamente o que o slice 1 injeta com `process.abort()` — deixa a **última** linha
parcial ou com bytes zerados. Só esse caso é tolerado: última linha sem `\n` terminal ou com JSON
parcial, **e nenhuma inconsistência antes dela** → trunca o arquivo até a última linha completa e
válida e grava `recovery{reason: 'torn_tail', bytes_dropped}` como **primeira escrita da retomada**
(a linha truncada não existiu para a dobra, então nada de efeito é adotado a partir dela). Qualquer
inconsistência em linha não-final, `prev` quebrado ou buraco de `seq` continua sendo exit 2. Testes:
`torn_last_line_is_truncated_and_recovered`, `tampered_middle_line_is_refused`.

### 1.4 fsync por linha

`fs.openSync(path, 'a')` mantido aberto durante a vida do engine + `fs.writeSync(fd, line)` +
`fs.fsyncSync(fd)`. **`fs.appendFileSync` não garante flush** (a opção `flush` só existe na variante
assíncrona, Node ≥ 20.10/21.1 — port-map I03). Custo: um fsync por evento, centenas a poucos milhares por
missão. [hipótese] p99 de append < 5 ms em NVMe; medir no slice 1 e, se não, agrupar por lote de
`step_intent`+`step_result` **nunca** (write-ahead exige fsync entre os dois).

### 1.5 Escritor serializado

Um único `Journal` por missão, com fila assíncrona (mutex de ~15 linhas: `tail = tail.then(task)`). Todo
`append` passa por ela. Dois `step()` concorrentes **na mesma story** são proibidos por construção (I01, o
risco médio do porte: em Node o `await` entre intent e efeito abre janela de reentrância). Em N>1 (§17) N
stories são N tarefas assíncronas no mesmo processo e a fila continua sendo uma só — o formato não muda,
a disciplina de escrita é que carrega a garantia (port-map §5.2).

### 1.6 Dobra (replay) e índice derivado

`fold(events) → MissionState` é **puro e total**: sem I/O, sem relógio, sem rede. Reconstrói orçamento
consumido, estado por story, rodada corrente, tentativas, checkpoints, intenções abertas. `status.json` e
`report.md` são projeção da dobra, escritos com tmp + `fsync` + `rename` (atômico; libuv usa `MoveFileEx`
com `REPLACE_EXISTING` no Windows — port-map §1.2); se a escrita falhar, a missão continua (projeção nunca
para o engine).

O índice SQLite do painel (v0.4b, `better-sqlite3`) é **derivado e descartável**: `ade index --rebuild`
reconstrói do journal. Nenhuma consulta de decisão do engine lê o índice. JSONL e não SQLite pelo mesmo
motivo do runtime de referência (RUNTIME.md "Por que JSONL e não SQLite"): um escritor por vez, poucos
milhares de linhas, fatos derivados de uma sequência ordenada única, e o arquivo é legível com `grep` e
sobrevive à ferramenta.

---

## 2. Step e write-ahead

```ts
async function step<T>(u: StepSpec, fn: () => Promise<T>): Promise<StepOutcome<T>> {
  const prior = fold.stepResult(u.id)
  if (prior?.status === 'ok' && prior.input_digest === u.input_digest) return prior   // I05
  if (prior?.status === 'ok' && u.effect_class === 'model_call') return prior          // I06: já foi paga
  await journal.append({ kind: 'step_intent', step_id: u.id, effect_class: u.effect_class,
                         input_digest: u.input_digest, intent_context: u.context,
                         tree_before: u.treeBefore, worktree: u.worktree,
                         receipt_path: u.receiptPath, runtime_stamp: STAMP })
  const r = await fn()
  await journal.append({ kind: 'step_result', step_id: u.id, status: r.status, tree_after: ..., ... })
  return r
}
```

| Conceito | Regra |
| :--- | :--- |
| `step_id` | estável e derivado, nunca aleatório: `T042:r1:maker`, `gate:test:<tree>`, `T042:commit:<tree>`, `T042:push:<commit>`, `T042:eval:red:<tree>`, `T042:visual:r1:<tree>`, `catalog:sync:<source>@<commit>` |
| `input_digest` | SHA-256 do intent canônico **sem** `intent_context`. É a chave de idempotência (I05) |
| `intent_context` | observações pré-efeito (`remote_before`, `base_before`, `head_before`, `tree_before`) gravadas **fora** do `input_digest` (I17). É o que permite reconciliar sem invalidar cache |
| `tree_before`/`tree_after` | árvore Git do worktree (`git add -A` em índice temporário + `write-tree`), obrigatórias em classe mutante |
| Guarda de `HEAD` | `HEAD` e branch comparados antes/depois de toda `model_call`; worker que move `HEAD` → `state_integrity` → para a missão (I27) |

`model_call` com resultado `ok` gravado é reusada **mesmo com pack recompilado diferente** — o pack entra no
`_evidence`, não no `input_digest` (I06). Essa é a diferença entre "retomar" e "pagar de novo".

---

## 3. Reconciliação por `effect_class` (tabela completa)

Toda intenção aberta (`step_intent` sem `step_result`) é reconciliada **antes de qualquer escalonamento**
(I08). Vereditos: `ok` (o efeito aconteceu, adota), `released` (provado que nada aconteceu, roda de novo,
não cobra), `ambiguous` (não é possível provar; nunca repete o efeito; árvore suja vira checkpoint e a story
vai para `awaiting_operator` ou recebe "continue do checkpoint").

Mapeamento do enum: `prepare` e `gate` são **valores próprios** do enum de `effect_class`, acrescentados
antes do slice 1 (architecture.md §11 E6); `restore` e `checkpoint` do runtime de referência continuam
`local_write`. Assim `gate` e `prepare` são filtráveis no journal e no painel sem inspecionar o `step_id`.

| `effect_class` | Evidência consultada | `ok` | `released` | `ambiguous` |
| :--- | :--- | :--- | :--- | :--- |
| `none` | nenhuma | — | sempre (leitura pura) | — |
| `local_write` (restore, checkpoint, e o `evals` preenchido pelo Maker em `trivial` com `eval_authored_by`, E2) | nenhuma; a árvore volta à `tree_before` do step antes de repetir | — | sempre | — |
| `prepare` | nenhuma; a árvore volta à `tree_before` | — | sempre. Recusa branch `ade/<missao>/<story>` preexistente fora da base (`stale_branch` → `awaiting_operator`) | — |
| `gate` | nenhuma; cache por árvore (§9) | — | sempre **quando o gate é declarado idempotente** (§9); sobras restauradas | gate com `idempotent: false` → `ambiguous` → `awaiting_operator` |
| `model_call` | recibo em `jobs/<step_id>.json` (§5) + resultado em `artifacts/` | resultado gravado para o mesmo `step_id` | recibo ausente, `starting` sem pid, ou `start_failed`/`invalid_input`/`conflict` (`NO_DISPATCH_STATES`, I07) | recibo em estado terminal (`exited`/`timeout`/`crashed`) sem result file, ou `running` com processo morto → cobrada; árvore suja vira checkpoint |
| `local_commit` | `HEAD`, `HEAD^{tree}`, pai gravado no `intent_context` | árvore da intenção sobre o pai gravado | `HEAD` ainda no pai | `HEAD` avançou além do pai sem ser o commit esperado → nunca adota commit alheio. "Nada a commitar" nunca adota `HEAD` (`commit_ambiguous`, I34) |
| `push` | `git ls-remote` contra `remote_before` do `intent_context` | remoto no commit esperado | remoto **exatamente** como antes da intenção | movido, apagado, divergente ou inacessível. **Rede indisponível = `ambiguous` → `awaiting_operator`, nunca retry** (architecture.md §6; J3 buraco #10) |
| `pull_request` | `gh pr list --head --json state,baseRefName,headRefOid` | `OPEN` ou `MERGED` com `baseRefName` **e** `headRefOid` exatos (`MERGED` completa a story) | não existe PR para a head | `CLOSED`, base/head diferentes, head ausente, `gh` falhou |
| `pull_request_merge` | `gh pr view --json state,mergedAt,headRefOid,baseRefName` | `MERGED` com base e head iguais aos revisados | — (nunca) | `OPEN` (merge queue devolve sucesso ao enfileirar: aberto **não** prova que a chamada não aconteceu), mesclado em outra base/head, `gh` falhou |
| `local_merge` | `merge-base --is-ancestor`, `MERGE_HEAD`, ponta da base vs `base_before` | commit revisado alcançável da base | base exatamente como antes da intenção | `MERGE_HEAD` presente (merge em curso **nunca** é abortado), base movida |
| `ci_query` | nenhuma | — | sempre (step id carrega timestamp, nunca reusado) | — |
| `ci_rerun` | nenhuma | — | — | **sempre**: contado como reexecução e nunca repetido (I15). Portado **desligado** na v1 (`ci.enabled: false` default), com teste do caminho inerte (E25) |
| `eval_run` | `EvalRecord` em `artifacts/evals/<step_id>.json` + `tree_before` do step | record gravado para o mesmo `step_id` e mesma árvore | record ausente **e** a árvore pode voltar a `tree_before` (restauração, I19/I20) | árvore não restaurável para `tree_before` (fase `red` perdeu a prova vermelha) → devolve a story ao `prepare` |
| `visual_eval` | artefatos da rodada em `artifacts/visual/<tree>/` (a11y snapshot, console, rede, saída de `impeccable detect --json`, screenshots) | conjunto completo da rodada presente para a mesma árvore (cache por árvore, como gate) | conjunto ausente ou parcial: build/serve/captura rodam de novo, são idempotentes | — (a nota do juiz é `model_call` própria e segue a linha de `model_call`) |
| `research` | `research-finding` em `artifacts/research/<step_id>.json` | achado gravado | achado ausente **e** recibo da chamada `released` | recibo terminal sem achado → segue a regra de `model_call` (a chamada foi cobrada) |
| `human_takeover` | registro `lease/takeover.json` + `tree_before` | registro presente → a story fica em `awaiting_operator: takeover_open` até `ade release` | registro ausente: reimprimir o comando é idempotente e gratuito | — |
| `human_release` | ref `refs/ade/checkpoints/<missao>/<story>/<n>` | ref presente (checkpoint é endereçado por conteúdo; regravar dá o mesmo hash) | ref ausente | — |
| `catalog_sync` | `~/.ade/catalog/sources/<nome>@<commit>/` + sha256 por arquivo vs `index.json` | diretório completo e hashes conferem | diretório ausente (fetch + checkout do commit pinado roda de novo) | presente mas parcial ou com hash divergente → move para `~/.ade/catalog/quarantine/` e `awaiting_operator` |

Regra geral que fecha o enum: **classe cujo efeito é local, idempotente e endereçado por conteúdo é
`released`; classe cujo efeito é externo, pago ou irreversível exige evidência de terceiro e admite
`ambiguous`.** Nenhuma classe nova é `ok` por presunção.

A premissa de idempotência de `gate` e `prepare` é **declarada, não presumida**: o `argv` de gate vem
do operador (`.ade/config.json`) e pode subir contêiner, tocar banco local ou consumir cota. Cada gate
declara `idempotent: true | false` (default `true`, validado por ajv em `ade-config.schema.json`); com
`false` o gate não é `released` na reconciliação. `prepare` é `released` porque a árvore volta a
`tree_before` e o worktree é endereçado por nome — e por isso `prepare` **não instala dependências**:
instalação é step `local_write` próprio, recusado dentro de `prepare`.

---

## 4. Lease com fingerprint

`<repo>/.ade/missions/<id>/lease/` criado com `fs.mkdirSync` sem `recursive` — `EEXIST` é o conflito
(atômico). Dentro: `owner.json` com `{pid, start_time, host, engine_version, acquired_at}` e `heartbeat`
reescrito a cada 2 s **a partir de um `worker_thread`** (imune a bloqueio do loop principal). TTL 15 s
[hipótese, medir no slice 1] (architecture.md §3 C3). Conflito → **exit 5 `coordinator_conflict`**, backoff
de 250 ms com jitter até 5 s (I04). Regra dura que acompanha o TTL: **nenhuma chamada externa do engine é
síncrona** — todo `execFile` de git e toda leitura de arquivo grande em `async`; síncronos só os writes do
journal e do recibo.

`proper-lockfile` descartado: última publicação 2021-01-25, último push 2023-10-25, mecanismo idêntico ao
nosso (mkdir + mtime) — dependência sem ganho para um requisito inegociável (addendum §4).

**Fingerprint contra lease morto-vivo após reboot**: TTL vencido não basta. A posse só é adotada quando
`process.kill(pid, 0)` lança `ESRCH` **ou** o processo existe mas com `start_time` diferente do gravado
(PID reciclado — observado de verdade nesta máquina, addendum §3.2). PID vivo com o mesmo `start_time` e
TTL vencido → `awaiting_operator`, nunca roubo de lease.

`LockFileEx`/`flock` no addon nativo (garantia do kernel, sem TTL) fica em backlog junto com o Job Object
próprio (§5.4).

**Dead-man switch** (architecture.md §10 A3): sem heartbeat do worker por N s o engine mata o
grupo de processos, põe a unidade em `awaiting_operator` e deixa o log em quarentena.

---

## 5. Runner e recibo durável

### 5.1 Estados do recibo

`<mission>/jobs/<step_id>.json`, escrito com tmp + `fsync` + `rename` (porte 1:1 de `tl_job.write_atomic`).
Provado nesta rodada: um processo Node frio, sem IPC, lê o estado correto em cada fase (addendum §3.1).

| Estado | Quando | Reconciliação |
| :--- | :--- | :--- |
| `starting` | escrito **antes** do spawn, sem pid | `released` — nada rodou |
| `running` | logo após o spawn, com `process_fingerprint` (§5.2) | processo morto **ou PID reciclado** → `ambiguous` (v1, §5.3) |
| `exited` | saída natural, com `exitCode` | resultado presente → `ok`; ausente → `ambiguous` |
| `timeout` | teto de `timeout_s` atingido; `taskkill /T /F` antes de gravar | `ambiguous` |
| `crashed` | saída ≠ 0 sem sinal nosso | `ambiguous` |
| `start_failed` | evento `error` do `spawn` antes de existir pid (`ENOENT`, `EINVAL`, `EACCES`) | `released` — **não cobrada** (I07) |

### 5.2 Dois campos distintos: `request_digest` e `process_fingerprint`

Conteúdo do pedido e identidade do processo são coisas diferentes e o recibo carrega as duas com nomes
diferentes (um hash do pedido é idêntico entre execuções do mesmo step e não detecta PID reciclado):

| Campo | Valor | Para quê |
| :--- | :--- | :--- |
| `request_digest` | `sha256(JCS({story, authorization_digest, cwd, argv, timeout_s, result_file}))` (porte de `tl_job.manifest_fingerprint`) | correlacionar recibo com a intenção e provar que o recibo encontrado é **deste** step; nunca serve de identidade de processo |
| `process_fingerprint` | `{pid, start_time, host}`, gravado no `running` | **tornar o `taskkill` seguro** (nunca matamos um PID sem conferir que `start_time` ainda bate) e rejeitar PID reciclado: pid vivo com `start_time` diferente → o worker morreu → `ambiguous`, nunca "ainda rodando" |

É a mesma forma do lease (§4), de propósito. `reconcile_rejects_pid_reuse_via_fingerprint_mismatch`
amarra-se a `process_fingerprint`; a idempotência de `step` continua governada por `input_digest` (§2),
com `request_digest` como correlação do recibo. O `process_fingerprint` habilita a branch "anexa" quando
o worker virar `detached`, na v0.5+ (§5.3, E21).

### 5.3 Worker não-detached na v1 — e o que isso implica

Decisão fixa (architecture.md §6, decisão 5 de §9). libuv cria um Job Object por processo Node com
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` e atribui todo filho **não-detached** a ele; o kernel mata os membros
quando o dono morre, por qualquer causa (digest #30, `deps/uv/src/win/process.c` lido em addendum §2.1;
comprovado com `tasklist` em §2.2: neto morre em <300 ms sem rodar o próprio handler de `exit`).

Implicações que a spec assume, e que fecham o buraco #1 do J3 (`detached` e Job Object são mutuamente
exclusivos — a arquitetura escolheu, esta spec não reabre):

1. Crash do engine mata o worker. O recibo nunca será encontrado em `running` **com processo vivo**.
2. Portanto **a branch "anexa e espera" de I09 fica dormente na v1**: não se implementa, não se testa; o
   teste `reconcile_attaches_to_still_running_detached_worker_after_engine_restart` é da v0.5+, junto com o
   upgrade para `detached` (architecture.md §11 E21). Não escrever código morto.
3. Uma `model_call` em voo custa uma chamada paga por crash de engine. Em troca: contenção da árvore de
   processos de graça e um único modo de falha (`ambiguous` + checkpoint + "continue do checkpoint").
4. O recibo continua indispensável: é o que separa `released` de `ambiguous` (I07/I65). Sem ele, todo
   crash de engine no Maker seria ambíguo e re-pago.
5. `human_takeover` é a exceção deliberada: o binário interativo é lançado pelo **operador**, no terminal
   dele, fora do job do engine — por isso sobrevive ao engine e por isso a árvore, não a sessão, é a verdade.

Janela residual aceita: o intervalo de poucos ms entre `CreateProcess` e `AssignProcessToJobObject` em que
um neto pode escapar (addendum §2.3). O `tl_job.py` fecha essa janela com `CREATE_SUSPENDED`; o Node não
expõe isso. Aceite: era 100 % sem contenção, passa a ser "contido exceto por uma janela de poucos ms".

### 5.4 Encerramento

`taskkill /T /F /PID <pid do recibo>` no Windows; `kill(-pgid)` após `setsid` no POSIX. **Nunca
`pty.kill()`**: `node-pty` não tem uma linha de Job Object (0 ocorrências de `AssignProcessToJobObject`,
`CreateJobObjectW`, `CREATE_SUSPENDED` — addendum §2.4), mata PID a PID por enumeração de console e pode
matar processo alheio até 5 s depois (bug #967, digest #29). `node-pty` é I/O de terminal e nada mais, e
só entra na v0.5.

Addon napi-rs com Job Object próprio (`CreateJobObjectW` sem `BREAKAWAY_OK` + `CREATE_SUSPENDED` +
`TerminateJobObject`, ~150–200 linhas Rust + toolchain que esta máquina não tem) é **backlog condicional**:
só promovido se `doctor_containment_selftest_per_adapter` mostrar que alguma CLI real escapa da cascata.

### 5.5 Ambiente do worker

`spawn(exe, argv, { env, cwd: worktree, shell: false, stdio: ['ignore','pipe','pipe'] })` com `env`
**explícito e construído do zero**: allowlist base + `env_allowlist` da config + `DO_NOT_TRACK=1` +
`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (digest #9). Herdar `process.env` por omissão é o bug fácil em Node
(I49). O `env` filtrado carrega também a **deny-list** de caminhos fora do worktree (`~/.ssh/**`,
`~/.aws/**`, `**/.env*`) e nunca propaga `ANTHROPIC_BASE_URL` nem equivalentes; a deny-list vive aqui, no
canário (§8) e no doctor — **não no `contain`**, que só vê o diff (architecture.md §11 E23).

**O mesmo `env` filtrado vale para todo subprocesso que não seja `git`/`gh` do engine** — em especial
`eval_run` (§10) e `gate` (§9), que o engine executa mas cujo `argv` não é do engine. Eles rodam com o
`env` construído do zero (sem `GH_TOKEN`/PAT, sem `ANTHROPIC_*`), `cwd` no worktree, `shell: false` e
`maxBuffer` explícito. Só os `execFile` de `git`/`gh` da entrega (§14) recebem o `env` com credencial, e
o `argv` deles é do engine, nunca de contrato. Sem isso o `evals` que o Maker autora em `trivial` (E2,
`author: 'maker'`) seria um `argv` escolhido por modelo executado com o ambiente privilegiado —
contornando a cerca inteira por dentro.

**Allowlist de `argv` para eval autorado pelo Maker**: binário resolvido tem de estar na allowlist do
repo (`node` e o runner de teste resolvido pelo doctor); `git`, `gh`, `curl`, `powershell`, `cmd`, `npx`
e qualquer caminho fora do worktree são recusa (`authorization` → `awaiting_operator`, nunca despacho).
Testes: `maker_authored_eval_cannot_reach_engine_credentials`,
`gate_and_eval_env_is_scrubbed_like_worker_env`.

A cerca real contra `git`/`gh` no worker é este `env` e o engine ser o único a executá-los — não o
`--disallowedTools`, que é glob de string, vai em **argumento único separado por vírgula**
(`--disallowedTools "Bash(git push*),Bash(gh pr*)"`, forma medida — E24) e é contornável por `git -C`,
alias ou script de repo (J3 §5, buraco #7).

---

## 6. BinaryResolver

Problema real, medido: `spawn('claude')` dá `ENOENT`; o shim `sh` absoluto dá `ENOENT`; o `.cmd` absoluto
lança `EINVAL` síncrono. `git`, `gh`, `codex` e `agy` são `.exe` nativos e funcionam direto (addendum §1.2).
A distinção não é `.cmd` vs shim sh — é **`.exe` nativo no PATH vs shim de `npm`**.

Algoritmo (roda no `ade doctor`, resultado cacheado em `~/.ade/capabilities.json`, nunca re-resolvido por
spawn):

1. Localizar candidatos no PATH.
2. `.exe` direto → usar, sem embrulho.
3. Só shim `npm` → ler o `.cmd`, extrair por regex o caminho após `%dp0%\`, resolver `%dp0%` para o
   diretório do shim, **verificar que o `.exe` existe em disco**, usar esse caminho (mais rápido: 1877 ms
   vs 2173 ms medidos, e sem reinterpretação de `& | ^ % "` pelo `cmd.exe`).
4. Formato de shim desconhecido → fallback `spawn('cmd.exe', ['/c', <caminho .cmd>, ...args])` e marcar o
   adapter como "rota de fallback" no relatório do doctor.

`{shell: true}` é proibido: DEP0190 é depreciação de **runtime** no Node 24 (instalado: 24.16.0) e os args
não são escapados — é injeção de shell no mesmo caminho por onde passa o pack.

---

## 7. GitPort por worktree

Uma instância por worktree, **nunca singleton** (I60 + digest #33: barato antes do primeiro commit, caro
depois). Todo comando é `git -C <worktree>` com `env` próprio.

| Operação | Regra |
| :--- | :--- |
| `worktreeTree()` | `GIT_INDEX_FILE` temporário próprio + copiar o índice + `fs.utimesSync(idx, 1, 1)` (truque do índice "racy") + `git add -A` + `write-tree`. Sem o `utimes`, reescrita de mesmo tamanho no mesmo segundo é invisível e o cache de gate e o `contain` ficam cegos (I21) |
| `dirtyPaths()` | `git status --porcelain -z`, split por `\0`, **os dois lados do rename** (`secrets/x -> pkg/x` é toque em `secrets/`). Nunca `--porcelain=v2`, nunca saída citada (I22) |
| `checkpoint()` | `commit-tree` + `update-ref refs/ade/checkpoints/<missao>/<story>/<n>` (I18) |
| `discard()` | grava `refs/ade/discarded/<missao>/<n>` **antes** de qualquer restauração. Nada é apagado sem cópia (I19). `ade discard <missao>` é isso em lote. `refs/ade/discarded/` **acumula**: o `ade doctor` reporta o volume e a purga é comando manual pós-v1 (E36) |
| `discard()` por **segredo** | caso separado do descarte por escopo: a árvore vai para `refs/ade/quarantine/<missao>/<n>`, não para `discarded/`, e o blob do arquivo ofensor entra **redigido** (mesma redação do pack, §19 I59), com ponteiro para o caminho original. Consequência escrita: `refs/ade/**` **nunca é empurrado** (nem por `push` do engine, nem por refspec do operador na receita de entrega) e o `ade doctor` **alerta** — não só conta — enquanto existir ref em `quarantine/` |
| `restoreTree()` | `clean -fd` **antes** do `read-tree`, sob as regras de ignore vigentes. Inverter a ordem apaga arquivo do operador (I20) |
| hooks | `GIT_CONFIG_COUNT=1 / GIT_CONFIG_KEY_0=core.hooksPath / GIT_CONFIG_VALUE_0=<dir vazio>` no `env` de **cada** `execFile`, nunca mutando `process.env` global (I50, melhoria sobre o Python) |
| `maxBuffer` | explícito em todo `execFile` de git (§8) |

---

## 8. Contain

Roda depois de cada Maker, sobre a árvore, em ordem fixa (I23): **segurança > caminhos sensíveis >
escopo**. Segredo ou `sensitive_paths` param a missão antes de qualquer commit; violação de `scope_paths`/
`do_not_touch` restaura a árvore uma vez e estaciona na repetição (I25). "Maker não mudou nada" é falha
semântica, nunca sucesso (I26).

**`maxBuffer` é invariante de segurança, não detalhe.** O default de 1 MiB do `execFile` termina o filho e
**trunca a saída em silêncio**: com o default, um diff grande passaria pela varredura de segredo truncado.
O diff do `contain` é pedido com limite `1<<31` de propósito (o teto `max_diff_bytes` vale só para o pack do
Checker). Truncagem detectada = `unexpected_tree_state`, não aviso (port-map §1.2, I24; J3 §3). A varredura
cobre o diff integral **e os bytes de cada arquivo alterado, binário incluso** (`readFileSync(p).toString('latin1')`).

**Canário de isolamento por família** (enxerto de C no painel, architecture.md §3 C7) em **duas formas
distintas**, porque as variantes que circulavam eram incompatíveis e a cara (chamada paga a cada chamada)
não cabe no orçamento (§13) nem na telemetria:

1. **Sonda** — `model_call` dedicada do `ade doctor`, **por família e por versão de binário**, com TTL
   explícito ([hipótese] 7 dias), gravada como `model_call` própria no journal e **fora** do orçamento da
   story; opt-in (`--probe-real`), nunca em CI. O prompt da sonda é do engine, não do pack de nenhuma
   story: a sonda pede a escrita fora do worktree, e a escrita **tem de falhar** e o arquivo **tem de não
   existir** depois. Resultado vira `probe_ok` por papel de escrita no `CapabilitySet` (E10). Família sem
   sonda válida → `unisolated_adapter_needs_explicit_acceptance` (I52): `ade run` recusa.
2. **Verificação por chamada** — barata e determinística, **sem instruir o modelo a nada**: hash antes/
   depois de um conjunto fixo de alvos (raiz do repo fora do worktree, `~/.claude`, `$CODEX_HOME`,
   `~/.gemini/antigravity-cli/`, `<repo>/.ade/**`) mais a deny-list de §5.5 (`~/.ssh/**`, `~/.aws/**`,
   `**/.env*`). Diferença detectada → `security` → para a missão.

`agy` escreveu em `~/.gemini/antigravity-cli/scratch/` em vez do `--add-dir` pedido, sem aviso
(digest #38), e um `claude -p` pode relatar sucesso depois de ferramenta bloqueada (digest #37): nada
prova que claude/codex não escrevem fora — por isso a verificação (2) roda sempre, mesmo com sonda verde.
O teste com a CLI falsa (§19) prova **o detector**, não a família; só a sonda (1) fala sobre a família.

`contain`/isolamento é uma das três superfícies de segurança com **revisão humana obrigatória**, exceção
escrita à meta "zero revisão humana" (architecture.md §11 E30).

---

## 9. Gate runner

Gates `always` + `by_flag` sobre **a árvore do Maker**, com `effect_class: 'gate'` (E6) e
`step_id = gate:<id>:<tree>` — cache por árvore,
invalidado por mudança de `argv` porque o `argv` entra no `input_digest` (I32). Artefato de gate é
restaurado e **nunca entra na entrega** (I31). `gates.canonical` no CLOSE, sobre a árvore de `HEAD`: 18
linhas que pegam quebra de integração entre stories que passaram isoladas — **não cortar** (port-map §4).
O **lint anti-slop** (Oxlint vendorizado) é gate por flag aqui, não portão do FQE (architecture.md §11 E39).
Toda saída passa pelo Tool Output Firewall (bruto em `artifacts/`, extrato ao modelo).

O gate roda com o **`env` filtrado do worker** (§5.5), `cwd` no worktree, `shell: false` e `maxBuffer`
explícito: o `argv` é do operador, não do engine, e não recebe credencial de `git`/`gh`. Cada gate em
`.ade/config.json` declara `idempotent` (default `true`); `false` muda a reconciliação para `ambiguous`
(§3).

---

## 10. Eval runner

`eval_run` é classe de efeito com `phase: 'red' | 'green' | 'strictness'` (architecture.md §3 C9, §7).

| Fase | Árvore | Regra |
| :--- | :--- | :--- |
| `red` | `tree_before` (antes do Maker) | `strictness.mode = 'must_fail_before'` exige exit ≠ `expect_exit`. Eval que **nasce verde** devolve a story ao Intent Compiler, nunca ao Maker |
| `green` | `tree_after` | exit == `expect_exit`, `evidence[]` gravada como artifact |
| `strictness` | — | `additive` gera aviso registrado (mudança puramente aditiva, sem prova vermelha) e exige, no mesmo cenário, um eval `negative` ou um spot-check `mutate` (validação ajv); `mutate` reservado |

`red_reason ∈ {assertion, missing_target, compile_error, environment}`: **só `assertion` conta como vermelho
válido**; os demais rebaixam o eval para `additive` com aviso, e em classe ≥ `feature` param em
`awaiting_operator` (architecture.md §11 E12). Em `trivial` com `evals: []` na aprovação, o Maker preenche
`evals` uma vez (`author: 'maker'`), gravado como step `local_write` com `eval_authored_by`, e o vermelho
diferido é condição de validade (E2).

`EvalRecord` = `{eval_id, phase, tree, argv, exit, red_reason, duration_ms, stdout_ref, stderr_ref, evidence_refs}`,
gravado em `artifacts/evals/`. É a evidência do journal. **O relato do agente nunca conta** (digest #37).
`max_output_bytes` do `Eval` é o teto do que o modelo vê; o bruto vai íntegro para artifact.

O subprocesso do eval roda com o **`env` filtrado do worker** (§5.5), `cwd` no worktree, `shell: false` e
`maxBuffer` explícito, e o `argv` de eval autorado pelo Maker (E2) passa pela allowlist de binários de
§5.5 antes de qualquer execução.

---

## 11. Scheduler

Estados: `ready`, `running`, `waiting`, `retryable`, `parked`, `blocked`, `completed`, `failed`,
`awaiting_operator`.

`next_ready()` devolve **um conjunto** (N-capaz desde o dia 1) de stories em ordem topológica, desempate por
id, com `depends_on` `completed`, `spec_revision` válida, reserva de orçamento e `scope_paths` disjuntos
entre si. **N = 1 na v1** — o conjunto tem um elemento; o que é caro depois (assinatura do método, campo
`worktree`, GitPort por worktree) já está pago. DAG só quando o plano declara `depends_on`; a lista plana é
o caso comum (digest #22: o harness de longa duração da Anthropic não usa DAG).

Dependente de story `parked`/`failed`/`awaiting_operator` fica `blocked`. `continue_independent_after_block`
decide se as demais continuam — **não cortar**: é a diferença entre "uma story ruim para a noite" e "para só
o ramo dela" (port-map §4). Ciclo de dependência é recusa na validação do plano (exit 2, I58).

---

## 12. Classes de falha, movimentos e detector de loop

Classes fechadas (11): `transient`, `harness`, `environment`, `semantic`, `verification`, `authorization`,
`budget`, `scope`, `state_integrity`, `security`, `unknown`. Classificação determinística por estado do
transporte + `stderr` + `outcome`/`blockers` do `unit-result` + veredito do `review-result` — nunca por
julgamento de modelo.

| Movimento | Classes | Detalhe |
| :--- | :--- | :--- |
| `retry` | `transient`, `harness` | backoff exponencial até `transient_retries`/`harness_retries` |
| `rework` | `semantic`, `verification` | até `max_rework_rounds`; `scope` restaura a árvore uma vez |
| `park` | `environment`, esgotamento, `unknown` | `unknown` **nunca** vira tentativa cega (I43) |
| `stop` | `authorization`, `budget`, `security`, `state_integrity` | missão `stopped` nunca reabre; exige nova aprovação |

As regex `_TRANSIENT` e `_ENVIRONMENT` são portadas literais, **incluindo as mensagens em português e de
Windows** (`"não pode encontrar o arquivo"`, `WinError [23]`) — I42.

**Detector de loop** (I41), três regras, nenhuma zera com troca de modelo:

1. **Assinatura normalizada** repetida `loop_threshold` vezes → `parked: loop_detected`. As 5 regex de
   normalização de `tl_ci_slice.normalize` (`_TIMESTAMP`, `_TIME`, `_HEX`, `_PATH`, `_NUM`) são portadas
   literalmente. `tl_ci_slice.py` **não se corta junto com a CI**: a normalização é usada mesmo com CI
   desligada, e assinatura diferente = detector inútil sem falhar nenhum teste óbvio (port-map §4).
2. **Oscilação** de árvore A→B→A → `diff_oscillation`.
3. **Estagnação**: mesmos achados do Checker em rodadas consecutivas → `stagnation`.
   `findings_digest = sha256(sorted(normalize(location) + '|' + normalize(problem)))` sobre os achados reais
   do `review-result` rico, com as regex de `tl_ci_slice.normalize` (architecture.md §11 E22) — o defeito
   latente do runtime (digest #32) era digerir um campo inexistente e disparar falso na segunda rodada.
   Também é estagnação a **assinatura de falha idêntica** (hash de `stderr`/stack normalizado) em duas
   tentativas consecutivas (architecture.md §10 A6).

---

## 13. Orçamentos

| Teto | Regra |
| :--- | :--- |
| `max_model_calls` | **reserva** Maker + Checker antes de começar a story; resultado já gravado não é cobrado de novo (I44) |
| `max_usd` | só sobre **custo observado**, logo **teto por família com custo reportado**. Uso não observado é `unknown` e **nunca** vira estimativa no teto (I45). Codex e `agy` não reportam USD (digest #28, adapters §9): a tabela `~/.ade/prices.json` produz `cost_source: 'estimated'` para telemetria e relatório, jamais para aplicar o teto. Consequência escrita, porque três documentos prometem o contrário: numa missão roteada só para essas famílias **não há teto em dólar** — o que segura a missão é `max_model_calls` + `max_wall_clock_seconds`. O resumo de aprovação marca explicitamente "sem teto em USD para `<família>`" e o runbook de custo estourado não pode oferecer "eleve `max_usd`" para elas |
| `max_wall_clock_seconds` | contado do primeiro evento do journal (I46) |
| `max_parked_units` | para a missão quando o acúmulo deixa de ser útil (I47) |

Contagem por **invocação de CLI**, não por requisição de API: uma invocação pode conter várias requisições.
Chamadas de pesquisa e do juiz visual são journaled como `model_call` (as classes `research`/`visual_eval`
cobrem só o invólucro determinístico) — do contrário escapariam da reserva.

---

## 14. Entrega

Commit/push/PR/merge são **sempre do engine**; o worker nunca roda `git`/`gh` (I55, fronteira de política do
RUNTIME.md). Slice 1 entrega só `local_commit`; push/PR/merge entram na v0.2.

| Etapa | Invariante |
| :--- | :--- |
| `commit` | a árvore de trabalho tem de ser **exatamente** a árvore revisada; edição do operador durante uma parada vai para `refs/ade/` e a story fica em `awaiting_operator` (I33). Trabalho aprovado sem `local_commit` permitido → `awaiting_operator`, nunca `completed` (I56) |
| `push` | refspec fixa: `<commit revisado>:refs/heads/<branch>`. Branch apontando para outro commit → nada é enviado (I35). Erro do `git push` **não prova falha**: consulta o remoto antes de decidir (I36) |
| `pull_request` | adoção só com `baseRefName` e `headRefOid` exatos; nunca duplica (I37) |
| `merge` | `gh pr merge --match-head-commit` + revalidação terminal `MERGED`; sucesso de enfileiramento não é merge (I38). Merge local só se a branch ainda aponta para o commit revisado; conflito → `merge --abort` + `awaiting_operator` (I39). Merge remoto exige CI `success` quando a CI está ativa (I40) — portado **desligado** (`ci.enabled: false` default), com teste do caminho inerte (E25) |
| `gh` | fixtures gravadas **por versão** do `gh` (medida: 2.100.0), com `--json` fixado nos campos usados. Mudança de formato é falha de fixture, não surpresa em produção |
| rede | indisponível na retomada = `awaiting_operator`. Nunca retry (architecture.md §6) |

---

## 15. Matriz de crash × fase

Critério de aceite, não documentação (architecture.md §6). Legenda: **R** `released` (roda de novo, nada
cobrado) · **A** `ambiguous` (checkpoint + decisão) · **OK** adota · **n/a** a fase não existe para o ator.
Colunas de slice: `prepare`→`commit` são do slice 1; `push`→`merge` da v0.2; visual da v0.4a e o painel da
v0.4b (E37).

| Crash \ fase | `prepare` | `eval:red` | `implement` | `contain` | `gates` | visual (FQE) | `review`/`rework` | `commit` | `push`/PR | `merge` | takeover |
| :--- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- | :-- |
| **Engine** | R | R (restaura `tree_before`) | recibo terminal ou pid morto → **A** + checkpoint; `starting`/`start_failed` → R | R (é leitura + decisão) | R, cache por árvore | R (captura idempotente); nota do juiz segue `model_call` | como `implement` | OK se `HEAD^{tree}` bate, senão R/A | consulta remoto/`gh`; nunca duplica | `OPEN` não prova nada → **A** + operador | registro presente → `awaiting_operator`; ausente → R |
| **Worker/CLI** | n/a | n/a (eval é do engine) | `start_failed`/`ENOENT` → **R, não cobra**; terminal sem result → **A** | n/a | falha de gate = `semantic`/`verification`, não crash | browser morto = falha de portão, rodada repete | idem `implement`; Checker que edita a árvore → `state_integrity` | n/a | n/a | n/a | sessão morre; **a árvore é a verdade** |
| **Máquina** (reboot) | R, com `git worktree prune` **depois** da reconciliação (ordem abaixo) | R | recibo sobrevive ao reboot; pid morto **ou `process_fingerprint` divergente** (§5.2) → **A** | R | R | R | como `implement` | como engine | como engine | como engine | → `awaiting_operator` |
| **Crash durante o append do journal** | cauda torn → truncada e `recovery{reason:'torn_tail'}` (§1.3); a linha truncada não existiu para a dobra, então o step volta ao veredito da sua classe (intent não gravado = nada aconteceu = R; intent gravado e result torn = reconcilia pela classe) | | | | | | | | | | |
| **Browser** | — | — | — | — | — | screenshot/a11y são artefatos em disco; rodada não repete | — | — | — | — | painel reconecta e relê a projeção |

Regras transversais da matriz:

- O painel **nunca é fonte**: fechar o navegador não muda estado, o índice é reconstruível, e toda ação de
  operador vira `step` antes de virar efeito.
- Lease morto-vivo após reboot é detectado por fingerprint (§4), não por TTL sozinho.
- Nenhuma célula é `ok` por presunção; onde não há evidência de terceiro, é `A`.
- **Ordem fixa da retomada**, porque limpeza antes de reconciliação destrói trabalho pago sem rastro:
  (1) adquirir lease; (2) reconciliar **todas** as intenções abertas, gravando checkpoint de qualquer
  árvore suja (§3); (3) só então `git worktree prune`/`git worktree remove`, e **nunca** sobre worktree
  citado por intenção aberta ou por story não terminal. Vale igualmente para o sweep de órfãos (§17
  item 3) e para o `ade doctor`. Teste:
  `prune_never_runs_before_reconciliation_checkpoints_dirty_trees`.

---

## 16. Versionamento

`format_version` (do journal) e `runtime_stamp` são coisas diferentes e as duas ficam em cada linha. O
`runtime_stamp` tem **três partes**: `<core_version>:<config_digest>:<capabilities_digest>` (E7).
`core_version` é constante do núcleo durável (C1–C5, C7) e **só ela** bloqueia com
`stale_workflow_version`; `capabilities_digest` cobre upgrade silencioso de CLI (`agy` 1.2.3 → 1.2.4 sem
ação) e fica no journal para o relatório.

| Situação | Comportamento |
| :--- | :--- |
| `format_version` maior que o suportado | recusa, exit 2. Só sobe com migração explícita e script de migração |
| `core_version` divergente em **intenção aberta** | `stale_workflow_version`: para a missão até `ade run --accept-stale-version`, gravado como evento `decision` no journal (I48, E7, E32) |
| `config_digest`/`capabilities_digest` divergentes, ou divergência sem intenção aberta | segue; a divergência fica no journal para o relatório |

Isto é o que impede a ADE em dogfood de trocar o engine embaixo de uma missão e reconciliar uma intenção
que a versão nova não entende. Seis linhas de código; **não cortar** (port-map §4).

---

## 17. Caminho para N>1

**Pronto desde o dia 1** (custo zero agora, caro depois do primeiro commit):

| Já pago | Onde |
| :--- | :--- |
| `worktree` no evento do journal | §1.1 |
| GitPort por worktree, sem singleton | §7 |
| `next_ready()` devolvendo conjunto | §11 |
| Reserva de orçamento contando intenções abertas | §13 |
| Um escritor serializado (N tarefas, uma fila) | §1.5 |
| Worktree linkado suportado (`.git` como arquivo, `rev-parse --git-path`) | I60 |
| Guarda de árvore suja **por worktree**, não global | §7 (ganho colateral: o operador edita o repo sem parar a missão) |

**Falta** (nenhum item muda o formato do journal):

1. Fila de integração: `local_merge` e merge de PR movem a ponta compartilhada → um por vez, com
   regravação do `base_before` no `intent_context` a cada tentativa. Desenho pronto em
   `tl_supervisor.advance_merge_queue` (port-map §5.2).
2. `claim_scope` / `_paths_overlap` para garantir `scope_paths` disjuntos.
3. Sweep de órfãos: crash com N worktrees deixa N diretórios → heartbeat + `git worktree prune`.
4. Gates da story **depois** da integração, não só antes: duas irmãs com escopos disjuntos ainda conflitam
   em `package.json`/lockfile.
5. `node_modules` por worktree: custo em disco vs quebra de isolamento se compartilhado. Sem resposta no
   painel (J3 buraco #8) — decidir com medição antes de ligar N>1.

---

## 18. Windows

| Restrição | Mitigação | Evidência |
| :--- | :--- | :--- |
| `lpCommandLine` do `CreateProcessW` = 32.767 chars; pack pode passar de 60 KB | **sempre `{pack_path}`**, nunca `{pack_text}`. `ade doctor` valida `len(argv) < 30.000` | digest #31, port-map §1.2 |
| `MAX_PATH` 260 em APIs não-Unicode | worktrees em caminho curto (`.ade/wt/<story>`, não `.ade/missions/<id>/wt/...`); `core.longpaths=true` verificado pelo doctor | architecture.md §6 |
| Shims `npm` (`claude`; `codex`, `agy`, `git` e `gh` são `.exe` nativos) | BinaryResolver (§6) | addendum §1 |
| `.cmd` via `spawn` lança `EINVAL`; `{shell:true}` é DEP0190 | `.exe` real, `shell:false` | addendum §1.2/§1.3 |
| Sandbox de SO do Claude Code não roda em Windows nativo | `contain` pós-fato + canário por família (§8) é a única fronteira universal | digest #8, #40 |
| `taskkill /T` é PID/PPID, não Job Object | aceito como best-effort com guarda de fingerprint; addon nativo remove a classe | addendum §2.3 |
| Suíte de paridade custa ~18 min em série | Vitest paralelo por caso, tmpdir próprio por worker | port-map §0 |
| Único caso skipado (`test_push_that_errors_after_landing_is_not_repeated`) | o shim vira `node shim.js`: **o skip desaparece no porte** e I36 passa a ter cobertura no Windows | port-map §0, I36 |

---

## 19. Invariante → onde vive no TS → teste que o prova

Layout canônico do repositório: **`docs/plans/slice-1.md` §2** (pacote único na raiz, `src/` e `tests/`
na raiz, E29) — não há `src/core/`, e `packages/core` só existe se a v0.4b mover tudo com um `git mv`
(ADR 0001). Os caminhos abaixo são relativos a `src/`; módulos que não aparecem em slice-1 §2 (`deliver/`,
`scheduler/`, `plan/`, `ci/`, `config/`) são pós-slice-1 e nascem sob a mesma raiz. `scope_paths` das
stories da própria ADE cita estes caminhos literalmente, então divergência aqui é defeito: o portão de
lint de docs (G9) verifica que todo caminho citado nesta tabela existe no repositório.

Nomes de teste = nomes de `test_tl_runtime.py`. A
tabela `parity-name-map.json` é artefato de **entrada** da v0.2 e 93/93 é critério da v0.2; o slice 1 cobre
um subconjunto nomeado de 44 casos (E26). Dois alvos normativos: `parity` (zero credencial, CI Windows +
Linux) e `probes` (chamadas reais, local, opt-in).

| # | Onde vive | Teste |
| :-- | :--- | :--- |
| I01 | `step/step.ts` | `crash_before_maker_effect_releases_the_call` |
| I02 | `journal/canonical.ts` + `journal/journal.ts` | `journal_hash_chain_detects_tampering`, `invalid_journal_line_is_refused`, `canonicalize_key_order_matches_jcs_for_nested_objects`, `canonicalize_rejects_lone_surrogate`, `canonicalize_output_byte_identical_to_python_reference_fixture`, `torn_last_line_is_truncated_and_recovered`, `tampered_middle_line_is_refused` (novos) |
| I03 | `journal/journal.ts` | todos os casos de `ADE_FAULT` (injeção por `process.abort()`) |
| I04 | `lease/lease.ts` | `lease_is_exclusive`, `decide_needs_the_lease`, `lease_second_acquirer_gets_coordinator_conflict_exit_5`, `lease_is_released_after_holder_crash_without_graceful_unlock` |
| I05 | `step/step.ts` | `resume_after_commit_with_changed_pack_does_not_redispatch`, `changed_gate_command_is_not_served_from_cache` |
| I06 | `step/step.ts` | `crash_after_journaled_checker_result_never_redispatches`, `resume_after_commit_does_not_reserve_new_calls` |
| I07 | `runner/receipt.ts` | `missing_harness_executable_is_environment_and_not_charged` |
| I08 | `step/reconcile.ts` | os 14 casos de fault injection, `prune_never_runs_before_reconciliation_checkpoints_dirty_trees` (novo) |
| I09 | `step/reconcile.ts` + `runner/receipt.ts` | `crash_after_maker_effect_consumes_call_and_continues_from_checkpoint`, `reconcile_rejects_pid_reuse_via_fingerprint_mismatch` |
| I10 | `deliver/deliver.ts` | `crash_after_commit_is_reconciled_without_a_second_commit`, `branch_amended_after_journaled_commit_is_not_delivered` |
| I11 | `deliver/deliver.ts` | `crash_after_push_is_reconciled_against_the_remote`, `diverged_remote_after_crash_awaits_operator`, `remote_reset_after_a_pushed_crash_is_not_pushed_over` |
| I12 | `deliver/gh.ts` | `crash_after_pr_creation_is_reconciled`, `foreign_pr_on_the_branch_is_not_adopted`, `merged_pr_at_another_head_is_not_adopted` |
| I13 | `deliver/gh.ts` | `merge_queue_success_reply_is_not_a_merge`, `crash_between_merge_call_and_verification_waits_for_operator` |
| I14 | `deliver/deliver.ts` | `base_moved_during_interrupted_local_merge_waits_for_operator`, `merge_in_progress_after_crash_waits_for_operator` |
| I15 | `step/reconcile.ts` | `ci_infrastructure_failure_reruns_once_then_parks` |
| I16 | `step/reconcile.ts` | `gate_leftovers_after_crash_are_not_committed` |
| I17 | `step/step.ts` | `crash_after_push_is_reconciled_against_the_remote`, `base_moved_during_interrupted_local_merge_waits_for_operator` |
| I18 | `git/gitport.ts` | `crash_after_maker_effect_consumes_call_and_continues_from_checkpoint` |
| I19 | `git/gitport.ts` | `discarded_tree_is_kept_under_a_ref` |
| I20 | `git/gitport.ts` | `restore_keeps_a_file_ignored_only_by_the_discarded_rules` |
| I21 | `git/gitport.ts` | `worktree_tree_sees_a_same_size_rewrite_within_one_second` |
| I22 | `git/gitport.ts` | `rename_out_of_scope_into_scope_is_contained`, `secret_in_a_file_git_would_quote_is_caught` |
| I23 | `contain/contain.ts` | `secret_in_diff_stops_batch`, `sensitive_path_stops_batch`, `secret_with_scope_violation_still_stops` |
| I24 | `contain/secrets.ts` | `secret_beyond_the_pack_diff_cap_is_still_caught`, `secret_inside_a_binary_file_is_caught`, `contain_treats_maxbuffer_truncation_as_state_integrity` (novo) |
| I25 | `contain/contain.ts` | `scope_expansion_restores_tree_then_parks_on_repeat` |
| I26 | `contain/contain.ts` | coberto por `scope_expansion_...` e pelos casos de rework |
| I27 | `step/step.ts` | `worker_that_moves_head_stops_the_batch` |
| I28 | `adapters/checker.ts` (flags `--sandbox read-only` / `--permission-mode plan`) | `same_family_review_is_refused` + caminho `unexpected_tree_state` |
| I29 | `engine.ts` (`prepare`) | `dirty_tree_before_unit_stops`, `pre_existing_dirt_on_the_unit_branch_is_refused` |
| I30 | `engine.ts` (`prepare`) | `stale_unit_branch_with_foreign_commits_waits_for_operator` |
| I31 | `gates/gates.ts` | `gate_artifacts_never_reach_the_commit`, `gate_leftovers_after_crash_are_not_committed` |
| I32 | `gates/gates.ts` | `changed_gate_command_is_not_served_from_cache`, `gate_placeholders_and_script_name_matching` |
| I33 | `deliver/deliver.ts` | `operator_edit_after_review_is_never_committed` |
| I34 | `deliver/deliver.ts` | `branch_amended_after_journaled_commit_is_not_delivered` |
| I35 | `deliver/deliver.ts` | `branch_repointed_during_interrupted_push_is_not_pushed` |
| I36 | `deliver/deliver.ts` | `push_that_errors_after_landing_is_not_repeated` (**deixa de ser skip no Windows**) |
| I37 | `deliver/gh.ts` | `foreign_pr_on_the_branch_is_not_adopted` |
| I38 | `deliver/gh.ts` | `pr_merge_is_pinned_to_the_reviewed_commit`, `retargeted_pr_is_not_merged`, `pr_retargeted_between_check_and_merge_is_reported` |
| I39 | `deliver/deliver.ts` | `local_merge_refuses_a_branch_that_moved_after_review` |
| I40 | `deliver/ci.ts` | `ci_code_failure_is_sliced_reworked_and_merged` |
| I41 | `scheduler/loop-detector.ts` | `loop_detector_parks_on_repeated_gate_signature`, `diff_oscillation_parks`, `same_findings_twice_is_stagnation` |
| I42 | `scheduler/failure.ts` | `harness_crash_retries_once_then_parks`, `transient_failure_retries_with_backoff_then_succeeds`, `maker_blocked_on_authorization_stops_batch`, `rework_exhaustion_parks_unit_and_blocks_dependent` |
| I43 | `scheduler/failure.ts` | `ci_rerun_without_permission_parks_without_touching_ci` |
| I44 | `scheduler/budget.ts` | `budget_reserve_stops_before_an_unverifiable_unit`, `resume_after_commit_does_not_reserve_new_calls` |
| I45 | `adapters/usage.ts` | `zero_cost_cap_is_enforced_on_observed_cost`, `usage_parsers_never_invent`, `no_usd_cap_is_claimed_for_families_without_reported_cost` (novo) |
| I46 | `scheduler/budget.ts` | indireto (relógio de parede) |
| I47 | `scheduler/scheduler.ts` | `rework_exhaustion_parks_unit_and_blocks_dependent` |
| I48 | `engine.ts` (`runtime_stamp`) | `stale_runtime_version_stops_until_accepted` |
| I49 | `runner/spawn.ts` | `worker_env_is_scrubbed`, `gate_and_eval_env_is_scrubbed_like_worker_env`, `maker_authored_eval_cannot_reach_engine_credentials` (novos) |
| I50 | `git/gitport.ts` | `repository_hooks_do_not_run_inside_runtime_git_commands` |
| I51 | `config/routing.ts` | `same_family_review_is_refused` (na ADE: por `model_id`) |
| I52 | `config/config.ts` | `unisolated_adapter_needs_explicit_acceptance` |
| I53 | `plan/validate.ts` | `missing_immutable_digest_is_refused` |
| I54 | `plan/validate.ts` | `spec_drift_and_scope_drift_are_refused` (digest do objeto da story serializado) |
| I55 | `plan/validate.ts` + `deliver/deliver.ts` | `local_write_false_is_refused_before_any_dispatch`, `unauthorized_push_is_never_attempted`, `non_boolean_optional_effects_are_refused` |
| I56 | `deliver/deliver.ts` | `approved_work_without_local_commit_is_handed_to_the_operator` |
| I57 | `scheduler/scheduler.ts` | `batch_runs_two_dependent_units_and_closes`, `continue_independent_after_block_runs_unrelated_unit` |
| I58 | `plan/validate.ts` | indireto (dep fora do plano recusada) |
| I59 | `pack/pack.ts` (redação pós-montagem) | `gate_output_secret_is_redacted_from_packs` |
| I60 | `git/gitport.ts` | `linked_worktree_is_supported` |
| I61 | `engine.ts` (dobra/missão) | `intent_gap_for_human_awaits_operator_and_decide_resumes` |
| I62 | `gates/gates.ts` | `batch_runs_two_dependent_units_and_closes` (gates canônicos no CLOSE) |
| I63 | `ci/slice.ts` | `ci_code_failure_is_sliced_reworked_and_merged`, `ci_infrastructure_failure_reruns_once_then_parks` |
| I64 | `runner/spawn.ts` (Job Object do libuv + `taskkill /T /F`) | `naive_kill_of_direct_child_also_kills_grandchild_on_windows`, `taskkill_tree_kills_grandchild`, `doctor_containment_selftest_per_adapter` |
| I65 | `runner/receipt.ts` | `receipt_written_before_spawn_is_readable_by_another_process_as_starting`, `receipt_running_state_is_readable_mid_flight_by_a_cold_process`, `receipt_terminal_timeout_state_matches_actual_process_death`, `receipt_write_survives_fault_injection_before_fsync` |
| I66 | `runner/resolve-binary.ts` | `doctor_resolves_npm_shim_to_real_exe_on_windows`, `doctor_falls_back_to_cmd_wrapper_on_unknown_shim_format` |

**CLI falsa** (porte de `fixtures/runtime/fake_harness.py`, requisito do slice 1): lê
`<scenario>/<role>.json`, consome a próxima ação e mantém **o contador em disco** — é isso que faz um
reinício do engine ver a mesma sequência que um harness real veria. Precisa do trio: contador durável,
ação `no_result` (é como se prova `ambiguous`) e captura de pack + `env` recebidos (é como se provam I49 e
a ordem das seções do pack). Injeção de falha: `process.abort()`, **não** `process.exit(70)` (buffers
pendentes — port-map §1.2).

---

## 20. Divergências resolvidas

Arbitradas em `docs/architecture.md` §11 (2026-09-17). O corpo deste documento já reflete cada decisão.

**D1 — teto do diff do Checker → aceita** (architecture.md §11 E13). `review.max_diff_bytes` default
60.000 chars, por arquivo em ordem de relevância de escopo, com ponteiro `ade show diff:<story>#<arquivo>`.
O corte do pack passa a ser em bytes (`limits.max_pack_bytes`, default 120 000 [hipótese]); "40k tokens"
é alvo de projeto por estimativa, não teto executável. Seção de rodada tem teto próprio de 24 000 bytes.

**D2 — TTL de lease → aceita nas três frentes** (architecture.md §3 C3, §11). Vale (a) a regra dura de
nenhuma chamada externa síncrona no engine, (b) heartbeat em `worker_thread` a cada 2 s e (c) TTL 15 s
[hipótese], calibrado no slice 1. Refletido em §4.

**D3 — `gate` e `prepare` no enum → aceita, opção (a)** (architecture.md §11 E6). Os dois valores entram
em `effect_class` antes do slice 1, enquanto `journal-event.schema.json` ainda não congelou. Refletido em §3.

**D4 — branch "anexa" de I09 → aceita** (architecture.md §11 E21). A branch fica dormente na v1, o teste
`reconcile_attaches_to_still_running_detached_worker_after_engine_restart` é da v0.5+, e o fingerprint serve
para `taskkill` seguro e para decidir `ambiguous`. Refletido em §5.2 e §5.3.

**D5 — `findings_digest` → aceita** (architecture.md §11 E22), com a fórmula e o teste
`same_findings_reworded_is_still_stagnation`. Refletido em §12.

**D6 — `--accept-stale-version` → aceita** (architecture.md §11 E32). `ade run --accept-stale-version`,
aceitação gravada como evento `decision` (com `source: operator`), nunca como config. Refletido em §16.

---

## 21. Perguntas em aberto

1. p99 de `fsync` por linha em disco lento — se for proibitivo, a saída não é agrupar (write-ahead exige
   fsync entre intent e efeito), é reduzir o número de eventos por story. Medir no slice 1.
2. Alguma CLI real escapa da cascata de Job Object da libuv? Só
   `doctor_containment_selftest_per_adapter` com `claude`/`codex`/`agy` de verdade responde (addendum §2.3).
3. Calibração de `limits.max_pack_bytes` (120 000 [hipótese]) e de `review.max_diff_bytes` (60 000) por p90
   em story grande.
4. `node_modules` por worktree em N>1: custo em disco vs quebra de isolamento (J3 buraco #8).
5. `git worktree` + `core.longpaths` em repositório com árvore profunda: `.ade/wt/<story>` é curto, mas o
   caminho do arquivo dentro do repo clonado não é.
6. Teto executável para famílias sem USD reportado: `max_tokens_in`/`max_tokens_out` por story e por
   missão (as três famílias reportam tokens) seria o paralelo de `max_usd`, mas acrescentar campo ao
   `mission_budget` muda E3 — **decisão de arquitetura, não desta spec**. Enquanto não houver, vale o
   escrito em §13: para essas famílias o teto é contagem de chamadas + relógio.
7. Filtros `clean`/`smudge` (git-lfs) rodam dentro dos comandos git do engine e não há chave que os desligue
   sem quebrar o consumidor (RUNTIME.md "Limites conhecidos"): declarar como limitação ou detectar no doctor.

## 22. Emendas de `architecture.md` §12 (2026-09-17)

§12 prevalece sobre este documento. Itens com efeito aqui: E42 (`prepare` recusa worktree com `takeover.json`; `awaiting_operator{reason:'takeover_open'}`, exit 3); E49 (`node_modules` por junction/symlink quando o hash do lockfile bate; senão instalador do discovery como step `prepare` em classe ≥ `bounded`, `prepare_dependency_ms`; fecha a pergunta 5 de §21); E58 (eval runner exige reporter estruturado e `numTotalTests >= 1`); E63 (validação de `eval.cmd[0]` contra `scripts` no `prepare`, não no plano); E64 (`local_merge` ff-only em `safe` quando a base não mudou); E47 (exit codes = master-spec §4, sem 1 nem 6); E60/E61/E62 rejeitados (sem purga, sem teto de tokens, sem `operator_cancel` na v1); E43/E68 (só `core_version` bloqueia).
