# Addendum: recibo durável, contenção de árvore, lease e resolução de binário no porte TS (Windows)

Data: 2026-09-16. Segue `docs/research/runtime-port-map.md` (§1.1, I01-I09/I64-I66) e
`docs/research/landscape-routing-skills-terminal.md` (§4). Escopo: fechar I09/I64/I65 (recibo durável +
contenção de árvore), I04 (lease), I02 (canonicalização JCS) e a contradição de resolução de binário (I66),
com comando executado, não citação. Máquina: Windows 11 Pro 26200, node v24.16.0, sem Rust/MSVC instalado
(`where cargo`/`rustc`/`cl` = nada encontrado — custo de setup real, ver §2.4).

Legenda: **[verificado]** = execução nesta sessão ou fonte primária lida · **[inferido]** · **[hipótese]**.

---

## 0. Veredito resumido

| # | Invariante | Veredito | Custo | O que quebra se cortado |
| :-- | :--- | :--- | ---: | :--- |
| I66 | Resolução/spawn de binário no Windows | **TS próprio** — resolver o `.exe` real atrás do shim `.cmd`/sh no `ade doctor`; `cmd.exe /c` só como fallback | ~40-60 linhas, 0 dependências | `spawn('claude', ...)` falha com `ENOENT` imediato (comprovado) — quebra no dia 1 |
| I64 | Contenção da árvore do worker | **Achado principal: parcialmente grátis no Node core (libuv)** — ver §2. `taskkill /T /F` como rede de segurança universal já hoje; addon nativo (napi-rs) rebaixado a backlog validável | ~10 linhas hoje; ~150-200 linhas Rust + toolchain se o addon virar necessário | Timeout "mata" no papel mas o processo (ou um neto que escapou) continua escrevendo/gastando cota |
| I65 | Recibo durável por chamada | **TS próprio** — prototipado e executado nesta sessão (§3), funciona | ~100-150 linhas (core já rodou com 15) | Sem recibo em disco, I09 não existe: um crash do engine perde o rastro de qualquer `model_call` em voo |
| I09 | Reconciliação de `model_call` | **TS próprio**, composição de I64 (sobrevivência via `detached`) + I65 (recibo) + fingerprint anti-reuso de PID | incremental sobre I65, ~30-50 linhas | Reconciliador confia em PID sem fingerprint → adota processo errado depois de reuso de PID (observado nesta sessão, ver §3.3) |
| I04 | Lease exclusivo | **TS próprio no mesmo addon nativo de I64** (flock/LockFileEx) se o addon for construído; senão fallback `mkdir` + heartbeat/TTL com números (§4) | ~40-60 linhas no addon; ~60 linhas o fallback puro TS | Sem lock real: dois `ade run` concorrentes no mesmo lote correm o journal ao mesmo tempo |
| I02 | Canonicalização JCS | **Dependência `canonicalize` (erdtman)**, não reescrever à mão | 1 dependência, 0 sub-deps | Canonicalizador caseiro errado quebra a cadeia de hash em silêncio (já apontado como Alto no mapa original) |

O achado que muda a arquitetura: **I64 não é mais bloqueador de dia 1**. `deps/uv/src/win/process.c`
(vendorizado dentro de `nodejs/node`) já cria um Job Object por processo com
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` e atribui todo filho não-`detached` a ele — comprovado com `tasklist`
nesta sessão. Isso não elimina a necessidade de recibo durável (I65, ainda Alto) nem cobre 100% dos casos
(ver ressalvas em §2.3), mas reduz o addon nativo de "obrigatório para não vazar processo" para "upgrade
de robustez, validável por CLI real antes de construir".

---

## 1. I66 — contradição de binário resolvida com comando

### 1.1 Não é uma contradição — é contexto de shell não declarado

```
$ where claude
E:\Apps\npm\claude
E:\Apps\npm\claude.cmd
```

**Os dois arquivos existem ao mesmo tempo.** `npm` no Windows sempre grava três shims por CLI instalada
globalmente — `claude` (shim `sh`, para bash/WSL/git-bash), `claude.cmd` (shim `cmd.exe`) e `claude.ps1`
(shim PowerShell) — todos delegando ao mesmo binário nativo:

```
$ cat E:/Apps/npm/claude
#!/bin/sh
...
exec "$basedir/node_modules/@anthropic-ai/claude-code/bin/claude.exe"   "$@"

$ cat E:/Apps/npm/claude.cmd
@ECHO off
...
"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe"   %*
```

`capabilities-claude-code.md` (shim `sh`) e `runtime-port-map.md`/`landscape-...md` (`claude.cmd`)
**verificaram fontes diferentes do mesmo fato**: qual shim resolve depende de qual `PATH`/resolução de
comando pergunta — `where` do git-bash lista os dois; o `CreateProcessW` do Node (usado por
`child_process`, sem `shell`) **não faz busca de `PATHEXT`** (isso é comportamento de `cmd.exe`/`COMSPEC`,
não da API Win32 de criação de processo) e portanto não resolve nenhum dos dois sozinho a partir do nome
nu. **[verificado nesta sessão]**

### 1.2 O que de fato funciona em Node, testado sem `{shell:true}`

Script `test-spawn.js` no scratchpad, `child_process.execFile`/`spawn`, sem shell, Node v24.16.0:

| Alvo | Resultado | Evidência |
| :--- | :--- | :--- |
| `execFile('claude', ['--version'])` (nome nu, via `PATH`) | **`ENOENT`** | `spawn claude ENOENT`, 8ms |
| `execFile('E:\\Apps\\npm\\claude', ...)` (shim sh, caminho absoluto) | **`ENOENT`** | Win32 não executa um arquivo texto `#!/bin/sh` |
| `execFile`/`spawn('E:\\Apps\\npm\\claude.cmd', ...)` (caminho absoluto) | **Lança `EINVAL` de forma síncrona** | confirma a doc oficial (§1.3) |
| `spawn('cmd.exe', ['/c', 'claude', '--version'])` | **Funciona** — `2.1.273 (Claude Code)`, 2173ms | `cmd.exe` faz a busca de `PATHEXT` |
| `spawn('E:\\Apps\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe', ...)` (o `.exe` real, resolvido do shim) | **Funciona** — mesma saída, **1877ms** (mais rápido, sem o salto extra de `cmd.exe`) | |
| `execFile('codex', ...)`, `execFile('gh', ...)`, `execFile('git', ...)` (binário `.exe` real no `PATH`) | **Funcionam direto**, sem shell, sem truque | `codex-cli 0.154.0`, `gh version 2.100.0`, `git version 2.54.0.windows.1` |
| `execFile('gemini', ...)` (mesmo padrão de shim do `claude`) | `ENOENT` no nome nu; `.cmd` absoluto lança `EINVAL` — mesmo padrão | confirma que o problema é geral a toda CLI instalada via `npm -g` no Windows, não específico do `claude` |

**Conclusão:** a distinção real não é "`.cmd` vs shim sh" — é **"binário `.exe` nativo no PATH" (git, gh,
codex, agy) vs "shim de `npm` (`.cmd`/sh/`.ps1`) na frente de um `.exe`" (claude, gemini)**. O primeiro
grupo funciona direto. O segundo precisa de uma destas duas rotas — ambas verificadas:

1. **Resolver o `.exe` real por trás do shim** (preferida: mais rápida, sem `cmd.exe` no meio, sem risco de
   metacaracteres `& | ^ % "` sendo reinterpretados por `cmd.exe`).
2. **`spawn('cmd.exe', ['/c', <caminho do .cmd>, ...args])`** — é exatamente o que a doc oficial recomenda
   ("spawning `cmd.exe` and passing the `.bat` or `.cmd` file as an argument, which is what
   `child_process.exec()` does internally") **[verificado: nodejs/node `doc/api/child_process.md`,
   seção "Spawning `.bat` and `.cmd` files on Windows", lida nesta sessão]** — mas com o custo do processo
   extra e do risco de parsing do `cmd.exe`.

### 1.3 Por que não `{shell: true}`

```
### DEP0190: Passing `args` to `node:child_process` `execFile`/`spawn` with `shell` option
Type: Runtime
changes: v24.0.0 — Runtime deprecation (era documentation-only em v23.11.0/v22.15.0)

When an `args` array is passed to `child_process.execFile` or `child_process.spawn` with the option
`{ shell: true }` or `{ shell: '/path/to/shell' }`, the values are not escaped, only space-separated,
which can lead to shell injection.
```
**[verificado: nodejs/node `doc/api/deprecations.md`, lido nesta sessão]**. Em Node **v24** (a versão
instalada, v24.16.0) isso já é depreciação de **runtime** (emite aviso), não só de documentação. Motivo é
segurança, não estilo — o pack do Maker/Checker passa por `argv`, e `{shell:true}` sem escapar é
exatamente o vetor de injeção que I23/C8 (segurança de skill) tentam fechar por outro lado.

### 1.4 Algoritmo de resolução recomendado (`ade doctor`)

1. Localizar candidatos no `PATH` (equivalente a `where`).
2. Se existir um `.exe` direto (git, gh, codex, agy) → usar esse caminho, sem embrulho.
3. Se só existir shim `.cmd`/sh de `npm` → ler o `.cmd`, extrair por regex o caminho entre aspas após
   `%dp0%\` (`"%dp0%\node_modules\@escopo\pacote\bin\nome.exe"`), resolver `%dp0%` para o diretório do
   próprio shim, **verificar que o `.exe` resolvido existe em disco**, e usar esse caminho direto
   (rota verificada em §1.2, mais rápida e sem risco de parsing de `cmd.exe`).
4. Se o parsing do shim falhar (formato desconhecido — ex. uma versão futura de `npm` muda o template) →
   fallback para `spawn('cmd.exe', ['/c', <caminho do .cmd>, ...args])`, e marcar no relatório do
   `ade doctor` que este adapter está na rota de fallback (mais lenta, mais arriscada) para o operador
   revisar.
5. Cachear a resolução (caminho final + estratégia usada) no relatório do `doctor`; não re-resolver a
   cada spawn.

Custo: ~40-60 linhas TS, zero dependência nova. Já é exatamente o que `capabilities-claude-code.md`
recomendava ("não assumir `.cmd`, resolver no `ade doctor`") — este addendum fecha com o algoritmo exato
e a prova de que cada rota funciona.

### 1.5 Surpresa fora de escopo

`where agy` resolveu para `C:\Users\Erick\AppData\Local\agy\bin\agy.exe`, versão `1.2.4`, e
`execFile('agy', ['--version'])` funcionou direto. O prompt desta pesquisa afirma que "'antigravity' NÃO
está instalado" — `agy` é um binário diferente (não confirmado se é o mesmo produto sob outro nome de
comando, ou algo não relacionado); não investigado further, fora do escopo de I66/I64. **[verificado a
existência; hipótese sobre a identidade]**.

---

## 2. I64 — contenção da árvore de processos do worker

### 2.1 Achado principal: libuv já faz kill-on-close por processo, no Windows, hoje

`deps/uv/src/win/process.c` (vendorizado em `nodejs/node`, lido nesta sessão via
`raw.githubusercontent.com/nodejs/node/main/deps/uv/src/win/process.c`):

```c
// linhas ~65-98 — job global lazy por processo
static HANDLE uv_global_job_handle_;
static uv_once_t uv_global_job_handle_init_guard_ = UV_ONCE_INIT;

static void uv__init_global_job_handle(void) {
  /* Create a job object and set it up to kill all contained processes when
   * ... spawned with the UV_PROCESS_DETACHED flag are assigned to this job. */
  info.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_BREAKAWAY_OK |
      JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK |
      JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION |
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  uv_global_job_handle_ = CreateJobObjectW(&attr, NULL);
  ...
  AssignProcessToJobObject(uv_global_job_handle_, GetCurrentProcess());
}

// linhas ~1082-1100 — todo filho não-detached entra no job
/* If the process isn't spawned as detached, assign to the global job object
 * so windows will kill it when the parent process dies. */
if (!(options->flags & UV_PROCESS_DETACHED)) {
  uv_once(&uv_global_job_handle_init_guard_, uv__init_global_job_handle);
  AssignProcessToJobObject(uv_global_job_handle_, info.hProcess);
}
```

Ou seja: **todo processo Node no Windows, na primeira vez que faz um `spawn()` não-`detached`, cria um Job
Object próprio com `KILL_ON_JOB_CLOSE` e injeta o filho nele.** Como o handle do job é fechado
automaticamente pelo SO quando o processo dono morre (crash, `TerminateProcess`, saída normal — não
importa a causa), o kernel mata todos os membros do job nesse instante. Jobs aninham desde Windows 8/Server
2012 (comentário do próprio libuv, linha ~81), então se o **filho** também for um processo Node que
spawnou um **neto** (seu próprio job interno), matar o filho fecha o job *dele*, que mata o neto em
cascata. **[verificado: código-fonte, lido integralmente nesta sessão]**

### 2.2 Prova empírica (executada e reproduzível no scratchpad)

Topologia: `run-scenario.js` (teste) → spawna `parent.js` (não-detached) → `parent.js` spawna
`grandchild.js` (não-detached) → neto só escreve heartbeat em disco a cada 500ms.

**Cenário A — mata só o pai (`parent.kill()`), sem `/T`, sem addon, sem dependência:**

```
parent pid = 31400
grandchild pid = 4464
heartbeat antes do kill: 1789541692116 n=2 pid=4464
tasklist(parent) antes: "node.exe","31400","Console","1","49.592 K"
tasklist(grandchild) antes: "node.exe","4464","Console","1","48.512 K"
--- acionando kill, modo = naive ---
+300ms: parentAlive(probe)=false gcAlive(probe)=false hb="1789541692618 n=3 pid=4464"
        tasklist(gc)="INFORMAÇÕES: nenhuma tarefa em execução correspondente aos critérios especificados."
[... +700ms/+1000ms/+2000ms iguais ...]
exitlog do neto: "<neto nunca registrou saída própria>"
```

`tasklist` (fonte independente do processo Node de teste) confirma: o neto morre em <300ms, e nunca roda o
próprio handler JS de `exit` — prova de que foi morto pelo kernel (via cascata de job), não por lógica
própria. **[verificado, executado nesta sessão, `run-scenario.js A naive`]**

**Contraprova — `{detached:true}` escapa do job do criador e sobrevive à morte dele** (necessário para o
design de I09, §3.3):

```
$ node spawn-detached-then-exit.js
engine: worker detached pid = 8196 -- engine vai sair AGORA (process.exit)
$ sleep 2 && node check-detached-survived.js
worker pid = 8196
probe isAlive = true
tasklist = "node.exe","8196","Console","1","48.524 K"
heartbeat atual = 1789541907038 n=4 pid=8196
```

O "engine" (processo que criou o worker) morreu de verdade (`process.exit`, processo separado, sem relação
de memória com o checador) e o worker, marcado `detached:true`+`unref()`, seguiu vivo e escrevendo
heartbeat 2s depois. **[verificado, executado nesta sessão]** — confirma a doc oficial: *"On Windows,
setting `options.detached` to `true` makes it possible for the child process to continue running after the
parent exits"* **[verificado: `doc/api/child_process.md`, lido nesta sessão]**.

### 2.3 O que isso NÃO cobre — ressalvas reais, não apenas teóricas

| Ressalva | Por quê | Mitigação |
| :--- | :--- | :--- |
| A CLI worker (`claude.exe`/`codex.exe`/`gemini`) precisa **ela mesma** spawnar seus próprios filhos (MCP servers, ripgrep, etc.) sem `detached`/`CREATE_BREAKAWAY_FROM_JOB` para a cascata continuar. **Não verificado por CLI real nesta sessão** — depende do binário interno de cada vendor. | `AssignProcessToJobObject` pode falhar silenciosamente (`ERROR_ACCESS_DENIED` engolido, comentário linha ~1088-1099 do libuv) se o processo já estiver sob um job sem `SILENT_BREAKAWAY_OK`, embora isso só afete versões pré-Windows 8 (irrelevante hoje). | Teste de `ade doctor` por adapter: reproduzir a topologia de §2.2 trocando `parent.js` pela CLI real, medir se o neto morre. **[hipótese a validar]** |
| Recibo/reconciliação (I09) exige o worker **sobreviver** ao engine (`detached`) — e um worker `detached` sai do job do engine, então a contenção "grátis" não se aplica a ele quando é o próprio engine que precisa matá-lo depois (ex.: timeout descoberto após reconciliação num restart) | Design intencional: I09 pede sobrevivência, não morte | `taskkill /T /F /PID <pid_do_recibo>` no processo reconciliado — verificado em §3.2, funciona porque o **próprio worker**, se for Node/libuv, ainda cria job para os filhos dele; e mesmo que não seja, `/T` faz sua própria varredura por PID/PPID no snapshot do processo |
| Órfão que escapou do job **antes** de `AssignProcessToJobObject` rodar (a janela entre `CreateProcess` e a atribuição) — vale só se a CLI spawnar algo nos primeiros milissegundos de vida | Mesma classe de corrida que o `tl_job.py` original fecha com `CREATE_SUSPENDED` (§2.4) | Aceitável para v1 dado o ganho: era 100% sem contenção, passa a ser "contido, exceto por uma janela de poucos ms" |
| `taskkill /T` também é PID/PPID-based (não Job Object) — o campo PPID do processo pode, em teoria, apontar para um PID já reciclado | Mesma classe de bug do `node-pty` #967 (§2.5), mas o `taskkill.exe` faz sua própria varredura interna num único instante, sem o round-trip JS que amplia a janela do `node-pty` | Aceito como best-effort de v1; addon nativo remove essa classe de erro por completo (garantia do kernel via `KILL_ON_JOB_CLOSE`, não por PID) |

### 2.4 `node-pty`: hipótese fechada com evidência de código

`gh api search/code` **[verificado nesta sessão, 2026-09-16]**:

| Termo buscado em `microsoft/node-pty` | Resultados |
| :--- | ---: |
| `AssignProcessToJobObject` | **0** |
| `CreateJobObjectW` | **0** |
| `CREATE_SUSPENDED` | **0** |
| `CREATE_NEW_PROCESS_GROUP` | **0** |
| `JobObject` (livre) | **0** |
| *sanity check* — `ConPTY` | 16 (prova que a API de busca está funcionando) |
| *sanity check* — `CreateProcess` | 2 |

Fecha a `[hipótese]` de `runtime-port-map.md` I64: **`node-pty` não contém nenhum código de Job Object.**
Inspeção direta de `src/windowsPtyAgent.ts` (`kill()`, linhas ~196-238) confirma o mecanismo real:

```ts
public kill(): void {
  ...
  this._getConsoleProcessList().then(consoleProcessList => {
    consoleProcessList.forEach((pid: number) => {
      try { process.kill(pid); }
      catch { /* Ignore if process cannot be found (kill ESRCH error) */ }
    });
    this._ptyNative.kill(this._pty, this._useConptyDll);
  });
}
```

`_getConsoleProcessList()` pergunta a um processo-agente auxiliar (via IPC) a lista de PIDs anexados ao
console do pty, e mata **cada PID individualmente** com `process.kill(pid)`. É enumeração por PID, sem
nenhuma garantia atômica do kernel — exatamente a classe de corrida que explica a issue #967 (`kill()` mata
PID alheio até 5s depois, já documentada em `landscape-routing-skills-terminal.md` §4.1). **Veredito
confirmado, não apenas herdado**: `node-pty` não deve ser tratado como mecanismo de contenção; só como I/O
de terminal.

### 2.5 O que o `tl_job.py` original faz a mais que o Node grátis não cobre

Lido nesta sessão (`tl_job.py` 1083-1180, `JobObjectContainment`): `CreateJobObjectW` +
`SetInformationJobObject(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE)` — igual ao libuv — **mas** spawna com
`CREATE_SUSPENDED`, atribui ao job **antes** de `ResumeThread`, fechando 100% a janela de corrida
"neto nasce antes da atribuição" que §2.3 aponta como residual no mecanismo grátis do Node. Também nunca
concede `BREAKAWAY_OK`/`SILENT_BREAKAWAY_OK` (o job do libuv concede os dois, de propósito — ver comentário
linha ~77-83 do `uv__init_global_job_handle`, para não quebrar quem roda `node` dentro de outro job de
CI). Isso é uma diferença de postura real: **o job do libuv é desenhado para não travar quem hospeda Node,
não para máxima contenção — o do `tl_job.py` é desenhado para máxima contenção.**

**Upgrade path formal** (napi-rs + crate `windows`, porte 1:1 de `tl_job.py` 1083-1180):
`CreateJobObjectW` → `SetInformationJobObject` (sem `BREAKAWAY_OK`) → `CreateProcessW` próprio com
`CREATE_SUSPENDED` (não dá para pedir isso ao `child_process.spawn` do Node — exige reimplementar a
criação do processo na *addon*, não reusar o spawn do Node) → `AssignProcessToJobObject` → `ResumeThread` →
`TerminateJobObject` no timeout. Custo: ~150-200 linhas Rust (Windows) + plumbing de stdio (pipes com
`SECURITY_ATTRIBUTES.bInheritHandle`) porque a *addon* passa a possuir o `CreateProcessW`, não o Node.
Equivalente POSIX (`setsid`+`PR_SET_CHILD_SUBREAPER`+`killpg`+`waitid(WNOWAIT)`, portando
`tl_job.py` 968-1010) **não testado nesta sessão** (escopo = Windows) — ~100-150 linhas adicionais,
**[hipótese]** de custo.

**Toolchain**: `where cargo`/`rustc`/`cl` não retornou nada nesta máquina — custo de primeira construção
inclui instalar Rust (ou Visual Studio Build Tools para C++/node-gyp). O padrão de empacotamento
napi-rs+prebuild via `optionalDependencies` por plataforma é maduro e usado em produção —
`@napi-rs/nice` (MIT, `Brooooooklyn/nice`, publicado 2025-08-14, 17 pacotes de plataforma incluindo
`win32-x64-msvc`) **[verificado: registry.npmjs.org]** — mas exige CI multi-plataforma para os prebuilds.

**Veredito final I64**: dado o achado de §2.1-2.2, a v1 **não precisa** do addon nativo para não vazar
processo no caso comum (engine → worker não-detached, `.kill()` no PID direto + `taskkill /T /F` como
reforço). O addon vira item de backlog, promovido a obrigatório **somente se** o teste de `ade doctor`
proposto em §2.3 mostrar que alguma CLI real escapa da cascata.

---

## 3. I65/I09 — recibo durável e reconciliação

### 3.1 Prototipo mínimo (rodado nesta sessão)

`receipt.js` (15 linhas, núcleo):

```js
function writeReceiptSync(path, obj) {
  const tmp = path + '.tmp-' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, JSON.stringify(obj) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, path); // libuv usa MoveFileEx(REPLACE_EXISTING) no Windows: atômico
}
```

Porte 1:1 de `tl_job.write_atomic` (`tl_job.py` 516-529: tmp por pid + `fsync` + `os.replace`).

`job-runner.js`: escreve `starting` (sem pid, antes do spawn) → spawna worker **`detached:true`+`unref()`**
→ escreve `running` (com pid) → corrida entre saída natural e timeout de 3s → no timeout, `taskkill /T /F`
+ escreve `timeout` (terminal).

**Execução real, três leituras por um processo Node totalmente separado (`read-receipt.js`, PID
diferente a cada chamada, sem IPC/memória compartilhada), lançadas em pontos diferentes do ciclo de vida:**

```
--- leitura #1 (~0.2s: deve ser starting ou running) ---
[read-receipt pid=30676] recibo lido do disco: {"state":"running","pid":36708,"argv":["grandchild.js"],"startedAt":"2026-09-16T06:59:32.644Z"}
--- leitura #2 (~1.7s: worker ainda rodando, deve ser 'running') ---
[read-receipt pid=38624] recibo lido do disco: {"state":"running","pid":36708,"argv":["grandchild.js"],"startedAt":"2026-09-16T06:59:32.644Z"}
--- leitura #3 (depois do job-runner terminar: deve ser 'timeout') ---
[read-receipt pid=39224] recibo lido do disco: {"state":"timeout","pid":36708,"exitedAt":"2026-09-16T06:59:35.843Z"}
--- saída completa do job-runner.js ---
recibo: starting (sem pid ainda)
recibo: running pid=36708
TIMEOUT atingido (3000ms) -- matando a árvore do worker pid=36708
recibo: timeout (terminal)
```

E confirmação de que a contenção realmente funcionou (worker morto, não só o recibo dizendo isso):

```
$ node -e "try{process.kill(36708,0);console.log('vivo')}catch(e){console.log('morto:',e.code)}"
worker 36708 morto: ESRCH
```

**[verificado, executado nesta sessão — scripts em `receipt.js`, `job-runner.js`, `read-receipt.js` no
scratchpad]**. Prova literal de I65: um processo que nunca existiu na memória do escritor lê o estado
correto do disco, em cada fase (`starting`→`running`→`running`→`timeout`), sem nenhuma IPC.

Estados não prototipados nesta sessão (`crashed`, `start_failed`) seguem o mesmo padrão trivialmente:
`start_failed` = `spawn()` emite `error` antes de `pid` existir → grava `start_failed` sem pid (mesmo shape
de `starting`, nunca chegou a `running` — mapeia para `released` em I07); `crashed` = código de saída
diferente de 0 sem `SIGTERM` nosso → grava `crashed` com `exitCode`. **[inferido, por analogia direta ao
que já rodou]**.

### 3.2 PID reuso — visto de verdade, não só hipotético

Ao rodar os cenários de §2.2 e §3.1 em sequência nesta sessão, **os mesmos números de PID reapareceram em
corridas diferentes dentro de poucos minutos** (churn normal de processo numa máquina de desenvolvimento
com Claude Code + ferramentas rodando). Isso não é teórico: **um recibo que carregasse só `pid` sem mais
nada arriscaria, num restart do engine, `isAlive(pid)==true` apontando para um processo completamente
não relacionado** que herdou o mesmo número.

### 3.3 Design de reconciliação (I09) — como I64+I65 se compõem

1. Engine spawna worker com `{detached:true, stdio:'ignore'}` + `child.unref()` — sobrevive a um crash do
   engine (§2.2, contraprova).
2. Recibo carrega, além de `state`/`pid`, um **fingerprint** = hash do
   `(unit, authorization_fingerprint, cwd, argv, timeout, result_file)` — porte direto de
   `tl_job.manifest_fingerprint` (`tl_job.py` 507-509) — gravado em `running`.
3. No restart, o reconciliador lê o recibo: se `state == "running"`, testa `isAlive(pid)`
   (`process.kill(pid,0)`); se vivo, **confirma via um segundo sinal fora do PID** (ex.: o processo ainda
   tem o `cwd`/linha de comando esperados — obtenha via `wmic process where ProcessId=<pid> get
   CommandLine` ou, melhor, grave o fingerprint também num arquivo-lado que o processo *supervisor*
   consegue reabrir) antes de "anexar e esperar"; se `isAlive` for falso, ou o fingerprint não bater →
   `ambiguous` + checkpoint, nunca redespacha (I07/I09 do mapa original, inalterado).
4. Timeout descoberto **depois** da reconciliação (worker antigo, novo processo engine) mata com
   `taskkill /T /F /PID <pid do recibo>` — verificado que funciona mesmo sem relação de `child_process` no
   processo atual (§2.2 cenário B já prova isso: `taskkill` opera por PID do sistema, não por handle do
   Node).

Custo incremental sobre o já-prototipado: campo de fingerprint + rotina `isAlive` + a chamada de
`taskkill` já testada — **~30-50 linhas**.

---

## 4. I04 — lease exclusivo

`fs` do Node **não expõe `flock`** — confirmado nesta sessão (busca na doc oficial de `fs`, sem qualquer
menção a locking de arquivo) **[verificado: nodejs.org/api/fs.html via fetch nesta sessão]**, consistente
com o que `runtime-port-map.md` já havia verificado.

`proper-lockfile` avaliado contra a exigência de I04 (exit 5 `coordinator_conflict`, liberação após
crash):

| Sinal | Valor | Fonte |
| :--- | :--- | :--- |
| Última publicação npm | 2021-01-25 (`4.1.2`) | **[verificado: registry.npmjs.org]** |
| Último push no repo | 2023-10-25 | **[verificado: gh api `repos/moxystudio/node-proper-lockfile`]** |
| Issues abertas | 21 | idem |
| Licença | MIT | idem |
| Mecanismo | `mkdir` (atômico) + mtime + retry — **não** usa `flock`/`LockFileEx` nativo | descrição do pacote |

**Não recomendado como dependência principal** para um requisito marcado "inegociável" pelo próprio
`PROMPT.md` — 3+ anos sem push é um sinal de manutenção fraca demais para o papel de coordenação exclusiva
do journal.

### 4.1 Opção A (recomendada) — lock real no mesmo addon nativo de I64

Já que I64 pode terminar exigindo uma *addon* nativa (napi-rs) como upgrade, o mesmo binding ganha
`flock(fd, LOCK_EX|LOCK_NB)` (crate `libc`/`rustix`) no POSIX e
`LockFileEx(handle, LOCKFILE_FAIL_IMMEDIATELY|LOCKFILE_EXCLUSIVE_LOCK, ...)` no Windows — **~40-60 linhas
adicionais**. Mesma garantia do `tl_job.lock_exclusive` original (`tl_job.py` 1240-1249): o SO libera o
lock sozinho quando o processo morre (fd/handle fechado automaticamente), **sem heartbeat nem TTL para
corretude**. Requisito: já ter pago o custo de toolchain do addon de I64 — se a decisão for **não**
construir o addon, cai para a opção B.

### 4.2 Opção B (fallback puro TS, sem addon) — heartbeat + TTL com números

```
lockDir = <lote>/.lock/            (fs.mkdirSync, sem recursive — EEXIST = conflito)
heartbeat: reescreve <lockDir>/heartbeat a cada 2000ms (fs.writeFileSync, não precisa fsync — é só liveness)
TTL: 6000ms (3x o intervalo de heartbeat) sem heartbeat novo = considerado morto
retomada de posse: TTL vencido E process.kill(pid_do_lock, 0) lança ESRCH (POSIX/mesmo usuário no Windows)
retry de aquisição: backoff de 250ms com jitter, até 5s, depois falha com exit 5 coordinator_conflict
```

Estritamente mais fraco que a opção A: uma pausa longa do event loop (GC, disco lento) sem heartbeat perto
do limite do TTL pode gerar um falso "morto" enquanto o dono original ainda está ativo. A margem de 3x
(2s/6s) existe para absorver isso, mas não é uma garantia do kernel como `flock`/`LockFileEx`.
**[inferido — números de partida, não medidos sob carga real]**.

---

## 5. I02 — canonicalização JCS (RFC 8785)

### 5.1 Pacote escolhido

`canonicalize` (`erdtman/canonicalize`), **[verificado nesta sessão]**:

| Sinal | Valor |
| :--- | :--- |
| Versão / publicação | `5.0.0`, 2026-09-08 |
| Downloads/semana | 2.514.229 |
| Licença | Apache-2.0 |
| Dependências | 0 |
| Repo — último push | 2026-09-09, 63 estrelas, 3 issues abertas, não arquivado |

Código lido integralmente nesta sessão (`unpkg.com/canonicalize@5.0.0/lib/canonicalize.js`): pilha
explícita (sem recursão, profundidade limitada pela heap, não pela stack de chamada), detecção de ciclo via
`Set`, `toJSON` resolvido antes da ordenação.

### 5.2 As três armadilhas do `JSON.stringify` puro — e como o pacote resolve cada uma

1. **Ordem de chave.** `JSON.stringify` preserva ordem de inserção; RFC 8785 exige ordenação lexicográfica
   por *code unit* UTF-16. `canonicalize` faz `Object.keys(value).sort()` — o comparador default do
   `Array.sort` já é por code unit, exatamente o que a RFC pede.
2. **`1.0` → `"1"` não é bug do `JSON.stringify` — é o comportamento correto que a RFC exige** (ECMAScript
   `Number::toString`, que não distingue inteiro de ponto flutuante em double-precision). A armadilha real
   do **porte** é outra: `tl_runtime.py` roda em Python, onde `1` (int) e `1.0` (float) são tipos
   distintos e `json.dumps` os serializa como `"1"` e `"1.0"` respectivamente. Se algum campo numérico do
   journal foi historicamente um `float` Python com valor inteiro, o canonicalizador Python teria emitido
   `"1.0"` e o TS (corretamente, por JCS) emite `"1"` — **uma fonte real de divergência de hash entre um
   journal antigo escrito pelo runtime Python e um novo escrito pelo runtime TS**, não um defeito do
   `canonicalize`. Irrelevante se a ADE nunca precisar continuar a cadeia de hash de um journal Python
   existente (o caso comum, dado que é um porte, não uma migração in-place) — mas vale um teste de
   paridade dedicado (§6) para não descobrir isso tarde. **[inferido]**
3. **Surrogate isolado.** `JSON.stringify` serializa `"\uD800"` sozinho sem erro, produzindo JSON
   tecnicamente mal formado. `canonicalize` chama `value.isWellFormed()` (String.prototype, ES2024,
   disponível desde Node 20) e lança `Error('Lone surrogate is not allowed')`.

### 5.3 Veredito

Dependência, não implementação própria — replicar à mão arrisca reintroduzir exatamente estas três
armadilhas sem os testes que o pacote já tem. Manter, ainda assim, um teste de paridade cross-linguagem
dedicado (§6) para a armadilha nº 2.

---

## 6. Testes de paridade propostos (provam cada invariante desta rodada)

| Invariante | Teste (nome no estilo `test_tl_runtime.py`) | O que prova |
| :--- | :--- | :--- |
| I66 | `doctor_resolves_npm_shim_to_real_exe_on_windows` | `ade doctor` resolve `claude`/`gemini` para o `.exe` real, sem `ENOENT`/`EINVAL` |
| I66 | `doctor_falls_back_to_cmd_wrapper_on_unknown_shim_format` | shim não reconhecido cai no fallback `cmd.exe /c` e ainda funciona |
| I64 | `naive_kill_of_direct_child_also_kills_grandchild_on_windows` | replica §2.2 cenário A como teste automatizado (Vitest + `tasklist` de verificação) |
| I64 | `detached_worker_survives_creator_process_exit` | replica §2.2 contraprova |
| I64 | `taskkill_tree_kills_grandchild_when_worker_not_detached_from_engine_job` | fallback funciona quando chamado explicitamente na reconciliação |
| I64 | `doctor_containment_selftest_per_adapter` | roda a topologia de §2.2 substituindo `parent.js` por `claude`/`codex`/`gemini` de verdade — fecha a ressalva de §2.3 |
| I65 | `receipt_written_before_spawn_is_readable_by_another_process_as_starting` | write-ahead, sem pid |
| I65 | `receipt_running_state_is_readable_mid_flight_by_a_cold_process` | replica §3.1 leitura #1/#2 |
| I65 | `receipt_terminal_timeout_state_matches_actual_process_death` | replica §3.1 leitura #3 + verificação `ESRCH` |
| I65 | `receipt_write_survives_fault_injection_before_fsync` (crash simulado entre `writeSync` e `fsyncSync`) | tmp nunca é promovido a `path` — sem corrupção do recibo anterior |
| I09 | `reconcile_rejects_pid_reuse_via_fingerprint_mismatch` | um PID vivo mas com fingerprint diferente do gravado não é adotado — cobre §3.2 |
| I09 | `reconcile_attaches_to_still_running_detached_worker_after_engine_restart` | composição completa de I64+I65 |
| I04 | `lease_second_acquirer_gets_coordinator_conflict_exit_5` | |
| I04 | `lease_is_released_after_holder_crash_without_graceful_unlock` | opção A: imediato (SO fecha o handle); opção B: só após TTL — o teste precisa parametrizar qual |
| I02 | `canonicalize_key_order_matches_jcs_for_nested_objects` | |
| I02 | `canonicalize_integer_valued_float_matches_js_number_tostring` | cobre a armadilha nº 2 de §5.2 |
| I02 | `canonicalize_rejects_lone_surrogate` | |
| I02 | `canonicalize_output_byte_identical_to_python_reference_fixture` | paridade cross-linguagem contra `json.dumps(sort_keys=True, ...)` de referência para o mesmo conjunto de objetos |

---

## 7. Fontes

Execuções locais desta sessão (2026-09-16, Windows 11 Pro 26200, node v24.16.0): `where claude/codex/
gemini/agy/gh/git`; `cat` dos shims `claude`/`claude.cmd`; scripts em
`C:\Users\Erick\AppData\Local\Temp\claude\...\scratchpad\` — `test-spawn.js`, `run-scenario.js`,
`spawn-detached-then-exit.js`, `check-detached-survived.js`, `receipt.js`, `job-runner.js`,
`read-receipt.js`; `gh api search/code` sobre `microsoft/node-pty` e `nodejs/node`; `gh api
repos/moxystudio/node-proper-lockfile`, `repos/erdtman/canonicalize`; `curl` sobre `registry.npmjs.org`
(`canonicalize`, `json-canonicalize`, `proper-lockfile`, `taskkill`, `@vscode/windows-process-tree`,
`@napi-rs/nice` e pacotes de plataforma).

Código-fonte primário lido integralmente ou nas faixas citadas:
- `deps/uv/src/win/process.c` — `raw.githubusercontent.com/nodejs/node/main/deps/uv/src/win/process.c`
- `src/windowsPtyAgent.ts` — `raw.githubusercontent.com/microsoft/node-pty/main/src/windowsPtyAgent.ts`
- `lib/canonicalize.js` — `unpkg.com/canonicalize@5.0.0/lib/canonicalize.js`
- `E:\Documentos\ProjetosIA\tl-orchestrator-release\scripts\tl_job.py` (95, 505-529, 968-1010, 1083-1249)

Documentação oficial:
- Node.js — `child_process`, "Spawning `.bat` and `.cmd` files on Windows",  `options.detached`:
  https://github.com/nodejs/node/blob/main/doc/api/child_process.md
- Node.js — Deprecations, DEP0190: https://github.com/nodejs/node/blob/main/doc/api/deprecations.md
- Node.js — `fs` (sem flock; `fsyncSync`; opção `flush` de `appendFile` desde v21.1.0/v20.10.0):
  https://nodejs.org/api/fs.html
- RFC 8785 — JSON Canonicalization Scheme: https://www.rfc-editor.org/rfc/rfc8785

Pesquisa anterior desta rodada (contexto, não repetido aqui):
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\runtime-port-map.md`
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\landscape-routing-skills-terminal.md`
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\capabilities-claude-code.md`

Pacotes avaliados e descartados, com evidência:
- `proper-lockfile`: https://github.com/moxystudio/node-proper-lockfile ·
  https://www.npmjs.com/package/proper-lockfile
- `tree-kill` (última publicação 2019): https://www.npmjs.com/package/tree-kill
- Família `dsh-win32-process` (padrão de publicação em massa sob múltiplos escopos, alpha, sem histórico —
  não recomendado): https://www.npmjs.com/package/@deepseek-ai/dsh-win32-process

Pacotes citados como referência de padrão (não dependências diretas):
- `@napi-rs/nice`: https://github.com/Brooooooklyn/nice · https://www.npmjs.com/package/@napi-rs/nice
- `@vscode/windows-process-tree`: https://www.npmjs.com/package/@vscode/windows-process-tree
