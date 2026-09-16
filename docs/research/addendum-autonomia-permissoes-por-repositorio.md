# Addendum — autonomia proporcional ao risco × permissões por CLI, no Windows

Data: 2026-09-16. Máquina: Windows 11 Pro 10.0.26200. Versões locais: `claude` 2.1.271, `codex-cli`
0.154.0, `gemini` 0.59.0, `agy` (Antigravity) 1.2.4. Agente de pesquisa da rodada de rearquitetação da
TL-ADE. Insumo de `docs/operations/` e do step `contain` (spec v2 §6, §9, §13).

Pergunta a fechar: **como a ADE expressa e faz valer os três níveis de autonomia do princípio 11 do
`PROMPT.md`** — safe (ler/editar/testar/branch/commit) → controlled (PR, dependências, migrations) →
restricted (produção, segredos, operações destrutivas) — **através de três CLIs com mecanismos de
permissão assimétricos, no Windows**.

Veredito em uma frase: nenhum dos cinco mecanismos nativos (permission-mode do Claude, sandbox do
Claude, `auto-mode` do Claude, sandbox/execpolicy do Codex, approval-mode/policy do Gemini) é, sozinho,
o `contain`. Todos são **camadas de defesa em profundidade que o worker vê**; o `contain` é a única
camada que o **engine** vê depois do fato, olhando a árvore git — e é a única que sobra quando o
operador assume o terminal. O desenho abaixo trata os mecanismos nativos como filtros baratos que
reduzem quanto lixo chega ao `contain`, nunca como substitutos dele.

---

## 1. Mapa de mecanismos × plataforma

Verificado no binário local (`--help`, execução real), não só na documentação. `[V]` = testado nesta
máquina; `[V-doc]` = confirmado em doc oficial sem teste local; `[I]` = inferência a partir do
verificado; `[H]` = hipótese não testada.

| Mecanismo | Claude Code 2.1.271 | Codex CLI 0.154.0 | Gemini CLI 0.59.0 | Antigravity 1.2.4 |
| :--- | :--- | :--- | :--- | :--- |
| **Modo de permissão** | `--permission-mode {acceptEdits\|auto\|bypassPermissions\|manual\|dontAsk\|plan}`. Default embutido em `-p` é **manual** (`permission_mode` no payload de hook aparece como `"default"` mesmo passando `manual` — são o mesmo modo) `[V]` | `-s/--sandbox {read-only\|workspace-write\|danger-full-access}` (interativo e `exec`); `-a/--ask-for-approval {on-request\|never}` **só no comando interativo** — **confirmado: `codex exec --help` não lista `-a`/`--ask-for-approval`** `[V]` | `--approval-mode {default\|auto_edit\|yolo\|plan}`; `-y/--yolo` deprecado em favor de `yolo` `[V-doc, capabilities-gemini-antigravity.md §2.1]` | `--sandbox` (boolean; restrição de terminal no processo, não container) `[V]` |
| **Allowlist/denylist de ferramenta** | `--allowedTools`/`--disallowedTools` (regra `Bash(git diff *)` com prefix-match; espaço antes do `*` importa), `--tools` (disponibilidade, diferente de auto-aprovação), `--restricted` (remove Bash/PowerShell/REPL/WebFetch, ignora settings de usuário/projeto) `[V]` | Não existe lista de nomes de ferramenta — é `--sandbox` (classe de acesso) + **execpolicy `.rules`** (por comando, ver §3) `[V]` | `--allowed-tools` **deprecado**; substituído pelo **Policy Engine** (`--policy`/`--admin-policy`, arquivos/diretórios com regras `command(...)`, `read_file(...)`, `read_url(...)`) `[V-doc]` | `toolPermission` presets no `config.json`: `request-review`, `proceed-in-sandbox`, `always-proceed`, `strict` `[V-doc, capabilities-gemini-antigravity.md §5]` |
| **Sandbox de SO** | **Builtin, mas doc oficial: "runs on macOS, Linux, and WSL2. Native Windows is not supported."** Sem sandbox ativo, falha aberta por padrão (`sandbox.failIfUnavailable` para tornar erro duro) `[V-doc, capabilities-claude-code.md §4]` | **Sandbox nativo no Windows, sem WSL** — restricted-token process, dois modos `elevated`/`unelevated` (`[windows]` em `config.toml`). Nesta máquina: `sandbox = "elevated"` `[V, config.toml lido]`. **Testado nesta rodada** (§3): funciona como *fail-closed* mas exige `[permissions.<nome>]` que não vem pronto — ver achado abaixo | **Nenhum motor nativo de Windows.** Só Docker/Podman/`sandbox-exec` (macOS)/`runsc`/`lxc` — nenhum roda nativamente aqui `[V-doc]` | Restrição de terminal no próprio processo (`enableTerminalSandbox` no `config.json`, nesta máquina `false`); **não é isolamento de SO** `[V-doc]` |
| **Hook de bloqueio pré-ação** | `PreToolUse` com JSON `{hookSpecificOutput:{permissionDecision:"allow"\|"deny"\|"skip", updatedInput}}`; exit 2 bloqueia sempre. **Testado nesta rodada** (§2.3): uma allow explícita de hook **executa o comando mesmo com `--permission-prompts none`** | Hooks existem (`--dangerously-bypass-hook-trust` sinaliza que hooks rodam por padrão e podem ser confiáveis/desconfiados por invocação) mas não documentados com o mesmo detalhe de decisão granular nesta pesquisa `[I]` | `gemini skills` existe como subcomando de gestão; não há hook pré-ferramenta documentado com poder de veto equivalente a `PreToolUse` `[I — ausência não confirmada exaustivamente]` | Sem hook de bloqueio documentado; herda o Policy Engine do Gemini via mesma base de código `[H]` |
| **Policy/classificador declarativo** | **`claude auto-mode`**: classificador allow/soft_deny/hard_deny em linguagem natural (~76 KB nesta instalação), só ativo quando `--permission-mode auto` é escolhido explicitamente — ver §2 | **`codex execpolicy check`**: avaliador Starlark determinístico allow/forbidden/sem-match, offline, sem executar o comando — ver §3.1. **`.rules` são carregadas automaticamente por `codex exec`** (achado novo, ver §3.3) | Policy Engine (`--policy`/`--admin-policy`) com regras declarativas por padrão de comando — mesma família de ideia que o execpolicy do Codex, não testado nesta rodada `[V-doc, não testado localmente]` | Herdado do Gemini `[H]` |
| **Resposta a pedido de permissão via ACP** | `session/request_permission` respondido pelo **cliente** (a ADE); nenhuma das três CLIs tem allowlist nativa no protocolo — é `_meta` de fornecedor. Claude não tem modo ACP nativo (usa adapter `claude-agent-acp`) `[V, adapters-and-acp.md §1.2–1.5]` | Adapter `codex-acp` expõe `sandbox mode` como opção de sessão (`INITIAL_AGENT_MODE=read-only\|agent\|agent-full-access`), não portável entre fornecedores `[V, adapters-and-acp.md §1.5]` | Gemini CLI tem `--acp` **nativo** | Adapter binário `agy_acp_server.par`, inclui Windows x86_64/aarch64 `[V, adapters-and-acp.md §1.3]` |
| **O que falha aberto** | Sandbox indisponível → roda sem sandbox por padrão (silencioso, salvo `failIfUnavailable`) `[V-doc]` | `.rules` ausente ou vazio → **`{"matchedRules":[]}`**, sem decisão — quem decide o default é o `-s/--sandbox`/`-a` em volta, não o execpolicy sozinho `[V, testado]` | Nenhum registro de failIfUnavailable equivalente localizado nesta pesquisa `[lacuna, ver §6]` | Idem |

**Nota sobre o princípio "documentos oficiais > binário > release notes":** aqui a ordem se inverteu de
propósito no que diz respeito a `auto-mode` e a `execpolicy` — **não há doc de produto para nenhum dos
dois nesta pesquisa**; o `--help` e a execução local são a única fonte primária disponível, e foram
tratados como tal.

---

## 2. `claude auto-mode` — o que é, e o veredito

### 2.1 O que existe

`claude auto-mode {config|defaults|critique|reset}` `[V]`. `config` imprime a política **efetiva**
(defaults + overrides de `~/.claude/settings.json` em `autoMode`); `defaults` imprime só o embutido.
Nesta instalação os dois são **idênticos byte a byte** (76.470 bytes, `diff` vazio) — não há override
local. `[V]`

Estrutura do JSON: quatro arrays —

| Chave | Itens | Papel |
| :--- | ---: | :--- |
| `allow` | 17 | Exceções nomeadas que **nunca** contam como violação (ex.: "Security Discussion", "Transient Retry", "Test Artifacts", "Local Operations", "Read-Only Operations", "Declared Dependencies", "Toolchain Bootstrap") |
| `soft_deny` | 70 | Categorias que **pedem aprovação** ("named+specifics" — a regra exige que o modelo nomeie a ação e os detalhes antes de agir). Cobrem exatamente o vocabulário dos três níveis de autonomia: `Git Destructive`, `Production Deploy`, `Merge Without Review`, `Self-Approval`, `CI Bypass`, `Protected-Scope IaC Apply`, `Secret-Store Writes`, `Credential Exploration`, `Irreversible Local Destruction`, `Package Registry Bypass`, entre outras |
| `hard_deny` | 1 (multi-cláusula) | Um único item, longo: **exfiltração de dados através da fronteira de confiança** — três checagens em sequência (o quê está sendo enviado / rastrear o destino completo / o destino final é externo confirmado). Cobre push para remoto não confiável, `git remote set-url` seguido de push, compartilhamento público, pipelines de CI reconfigurados para vazar |
| `environment` | 21 | Perguntas sem resposta nesta instalação (`"None configured"` em 12 das 21) — organização, provedor de nuvem, hosts internos confiáveis, namespaces protegidos. **É o ponto de extensão que a ADE preencheria por repositório**, se decidir usar `auto-mode` |

Prova literal (trecho do `hard_deny`, único item, `defaults` == `config`):

```
"Data Exfiltration: Sensitive data crossing the trust boundary (the trusted repos, domains, and
buckets listed in Environment) as a result of the agent's action — directly, or by arming an
automated pathway that will. [...] Three checks, in order: What is being sent? [...] Trace the full
destination path. [...] Is the final destination confirmed external or public?"
```

E o `environment` (íntegro, nesta instalação):

```
"Repository visibility": assume private unless the remote host and repo name indicate otherwise, [...]
"Host containment": None configured — assume Claude Code runs on an ordinary developer machine or CI
  runner with open internet; if it runs inside a container/VM/pod with an egress allow-list [...] say
  so here [...]
"Sensitive remote targets": any namespace, host, or container whose name carries `prod` or
  `production` as a whole word or name segment [...]
```

`auto-mode` só ativa quando a sessão é lançada com **`--permission-mode auto`** — confirmado no
`--help`: `auto` é uma das seis opções de `--permission-mode`, ao lado de `manual` (default embutido em
`-p`), `bypassPermissions`, `acceptEdits`, `dontAsk`, `plan`. `[V]`

### 2.2 Teste ao vivo

`git status` (operação de leitura, categoria `Read-Only Operations` do `allow`) sob
`--permission-mode auto --permission-prompts none`:

```
result: Branch `master`, no commits yet, working tree empty.
denials: []
```

Passou sem fricção — confirma que o `allow` list é reconhecido e que `--permission-prompts none` não
degrada uma ação já classificada como `allow` pelo próprio `auto-mode`.

### 2.3 O achado decisivo: hook `PreToolUse` vs. `--permission-prompts none`

A pergunta que `landscape-routing-skills-terminal.md` deixou aberta era outra (se `auto-mode`
substitui/complementa/colide com `contain`), mas o prompt desta rodada pede também avaliar a interação
não testada entre `--permission-prompts none` e hooks `PermissionRequest`/`PreToolUse` que aprovam.
Testei com um projeto isolado (`.claude/settings.json` só com um hook `PreToolUse` que sempre devolve
`permissionDecision:"allow"`) chamando `claude -p ... --permission-mode manual --permission-prompts none`
(o `auto` nem é necessário para este teste — o efeito é sobre qualquer modo que prompt aria):

```json
{"type":"system","subtype":"hook_response","hook_name":"PreToolUse:Bash","hook_event":"PreToolUse",
 "output":"{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"allow\",
 \"permissionDecisionReason\":\"auto-approved by test hook\"}}","exit_code":0,"outcome":"success"}
```

Resultado: o `Bash` correspondente **executou de verdade** — `tool_result` final:
`"content":"hook-permission-probe-99999","is_error":false"` (o valor exato do `echo` de teste). Uma
primeira tentativa da mesma chamada tinha sido interceptada por **outro** hook global do operador (um
"Fact-Forcing Gate" alheio a este teste, não relacionado a `--permission-prompts none`), e o modelo
re-tentou — o que por si só confirma outra coisa útil: **o `result` textual final de uma sessão `-p` não
é evidência confiável de execução real**; `permission_denials` e os eventos de hook são a fonte de
verdade, nunca o texto que o modelo escreve. **[V — teste local, prova acima]**

**Conclusão sobre a interação:** uma decisão explícita de hook `PreToolUse` **tem precedência sobre**
`--permission-prompts none`. Isso faz sentido com a doc: `--permission-prompts none` decide quem
responde um **prompt** — se o hook já decidiu antes de haver prompt, não há prompt a negar. **[V]**

### 2.4 Veredito: complementa, não substitui — e nunca colide se a ADE não escolher `auto`

- `auto-mode` é um **classificador semântico de intenção**, avaliado pelo próprio modelo Claude contra
  uma política de ~76 KB em linguagem natural. Ele julga o **conteúdo e a intenção** de uma ação
  (`git push` para onde, contendo o quê) — algo que `contain` (regex + diff de árvore) não faz.
- `contain` é um **verificador determinístico pós-fato**: opera sobre a árvore git real depois que o
  Maker terminou, não confia no julgamento de nenhum modelo, e é o único que sobrevive a "assumir o
  terminal" (§6).
- Eles não competem pelo mesmo papel: `auto-mode`, quando ligado, é um filtro **pré-execução, só para a
  família Claude**, que reduz a chance de uma ação chegar perto do limite do `contain`. `contain` é o
  portão final, **cross-family**, que não confia em julgamento nenhum.
- **Não há colisão possível a menos que o engine escolha `--permission-mode auto`.** O modo inicial
  embutido em `-p` é `manual` `[V-doc]`; a ADE nunca precisa passar `auto`. **Desligamento determinístico:
  não emitir `--permission-mode auto` nas sessões despachadas** — não existe outra chave (env var,
  settings.json) que ligue `auto-mode` silenciosamente; é preciso o valor literal do flag. `claude
  auto-mode reset` some com overrides locais, mas isso é irrelevante se o modo nunca é selecionado.
- **Se a ADE decidir usar `auto-mode`** (por exemplo, como uma segunda camada de julgamento semântico
  antes do `contain`, nas famílias que rodam Claude): preencher o `environment` por repositório
  (`Trusted repo`, `Sensitive remote targets`, `Host containment`) é o único ponto de customização
  suportado — e **isso é literalmente o mesmo conteúdo que o `<repo>/.ade/config.json` da §5 precisa
  capturar de qualquer forma** (escopo, remotos confiáveis, padrões de path sensível). Recomendação:
  **não adotar `auto-mode` como gate primário na v1** (é específico da família Claude, não determinístico,
  e duplica o propósito do `contain`) — mas **gerar o bloco `environment` a partir do
  `<repo>/.ade/config.json`** como segunda camada opcional de defesa quando o Maker é `claude`, sem
  bloquear o pipeline nela. `[I]`

---

## 3. `codex sandbox` e `codex execpolicy` como primitivas — testado

### 3.1 `codex execpolicy check` — DSL Starlark, determinístico, sem execução

```
$ codex execpolicy check -r rules.rules echo hello
```

Iteração até achar a sintaxe certa (erros do próprio parser Starlark serviram de doc):

```
$ codex execpolicy check -r bad.rules -- echo hello
Error: failed to parse policy at ...
Caused by: starlark error: error: Parse error: unexpected identifier 'content', expected new line

$ echo 'prefix_rule(program = "echo", args = [], decision = "allow")' > test2.rules
$ codex execpolicy check -r test2.rules -- echo hello
Error: [...] Missing parameter `pattern` for call to `prefix_rule`
```

Forma correta, testada com sucesso — allow, forbidden, e sem-match:

```jsonc
// rules.rules
prefix_rule(pattern = ["echo"], decision = "allow")
prefix_rule(pattern = ["curl"], decision = "forbidden")
```

```
$ codex execpolicy check -r rules.rules --pretty -- echo hi
{"matchedRules":[{"prefixRuleMatch":{"matchedPrefix":["echo"],"decision":"allow"}}],"decision":"allow"}
exit=0

$ codex execpolicy check -r rules.rules --pretty -- curl http://example.invalid
{"matchedRules":[{"prefixRuleMatch":{"matchedPrefix":["curl"],"decision":"forbidden"}}],"decision":"forbidden"}
exit=0

$ codex execpolicy check -r rules.rules --pretty -- python3 -c "print(1)"
{"matchedRules":[]}
exit=0
```

**Achado prático:** o código de saída do processo **não distingue** `allow`/`forbidden`/sem-match — os
três deram `exit=0` no teste acima (a única vez que vi `exit=1` foi com um arquivo de regras
verdadeiramente vazio, tratado como erro de carga, não como decisão). **A ADE precisa ler o campo
`decision` do JSON, nunca o exit code.** `[V, teste literal acima]`

**Achado maior — carregamento automático em `codex exec`:** `codex exec --help` lista
`--ignore-rules: "Do not load user or project execpolicy .rules files"` — ou seja, **por padrão,
`codex exec` já carrega e aplica `.rules` do usuário e do projeto, sem precisar envolver o comando em
`codex sandbox --`**. Localizei o arquivo real desta máquina: `~/.codex/rules/default.rules` (7 regras
`prefix_rule`, todas `decision="allow"`, geradas pelo próprio Codex ao longo do uso interativo — é um
allowlist aprendido, persistido). `[V, arquivo lido]`

```
$ cat ~/.codex/rules/default.rules
prefix_rule(pattern=["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "-Command", ".\\gradlew.bat compileJava"], decision="allow")
[... 6 regras análogas]
```

Isso muda a recomendação de `capabilities-codex.md`: a primitiva mais barata não é envolver comandos em
`codex sandbox --` (que exige perfil de permissão — ver §3.2); é **depositar um `.rules` gerado pela
ADE em `$CODEX_HOME/rules/<repo-ou-nível>.rules`** (ou o caminho de projeto equivalente) e deixar
`codex exec` aplicá-lo nativamente. Isso só vale para comandos rodando **dentro do Codex** — não ajuda a
governar Bash do Claude ou do Gemini.

### 3.2 `codex sandbox` — sandbox real, mas não é plug-and-play

```
$ codex sandbox -C <dir> -- cmd /c "echo hi"
error: the following required arguments were not provided:
  --permission-profile <NAME>
```

`-P/--permission-profile <NAME>` é obrigatório e não tem default utilizável: nesta instalação (perfis
comuns testados — `read-only`, `workspace-write`, `danger-full-access`, `default`) todos falharam com

```
Error: default_permissions requires a `[permissions]` table
```

— ou seja, **`-P` não aceita os nomes de `-s/--sandbox`**; espera um nome definido em
`[permissions.<nome>]` no `config.toml`, e **este `config.toml` (real, desta máquina, com `[windows]
sandbox = "elevated"` configurado por uso normal do Codex) não tem nenhum `[permissions.*]`
pré-definido.** Forcei um override via `-c permissions.default.disk_write_cwd=true` (chave adivinhada,
não documentada em `--help`) para passar da checagem de existência da tabela — e mesmo assim:

```
$ codex sandbox -P default -C <dir> -c "permissions.default.disk_write_cwd=true" -- powershell -NoProfile -Command "'inside' | Out-File -FilePath ok.txt"
Out-File : O acesso ao caminho '...\ok.txt' foi negado.
    + CategoryInfo : OpenError: (:) [Out-File], UnauthorizedAccessException
```

**A escrita foi negada mesmo dentro do próprio diretório de trabalho declarado (`-C`).** O sandbox
restricted-token do Windows nesta config (`elevated`) **falha fechado** quando o perfil de permissões
não está corretamente populado — o que é o comportamento de segurança certo, mas prova que **não há
caminho zero-config**: a chave real que libera escrita no cwd não está documentada em `codex sandbox
--help`, e não achei confirmação sem ler código-fonte do Codex (fora do escopo desta rodada, hierarquia
de fontes não permite adivinhar). **[V, teste literal acima; a chave certa fica como lacuna aberta]**

### 3.3 Custo de acoplar a ADE ao Codex instalado — avaliação

| Uso proposto | Custo | Veredito |
| :--- | :--- | :--- |
| `codex execpolicy check` como **pré-checagem cross-family** (avaliar se um comando *seria* permitido, antes de qualquer CLI rodar) | Baixo: binário síncrono, sem estado, JSON limpo, sintaxe Starlark de ~1 linha por regra, não amarra a família que vai *executar* o comando | **Adotar** como camada consultiva dentro do `contain`/`gates` — resultado vira anotação no journal, nunca decisão única |
| `.rules` auto-carregadas pelo próprio `codex exec` | Baixo: já é o comportamento padrão, só requer que a ADE escreva o arquivo certo no lugar certo (`$CODEX_HOME/rules/` ou equivalente de projeto) | **Adotar** para comandos que o Maker `codex` mesmo executa |
| `codex sandbox -- <cmd>` como jaula genérica para comandos de **qualquer** família (Claude/Gemini rodando dentro dele) | Alto: exige `[permissions.<nome>]` corretamente populado (chaves não documentadas publicamente), comportamento fail-closed real testado, acopla o `contain` a uma dependência externa versionada separadamente, e ainda não garante que a chamada sob outro binário (`claude`, `gemini`) se comporte bem dentro do wrapper de token restrito (não testado nesta rodada — includes risco de quebrar ConPTY, já frágil por si — ver `landscape-routing-skills-terminal.md` §4.1) | **Não adotar como jaula universal na v1.** Fica candidato a backlog v2, com o pré-requisito de mapear `[permissions]` a partir do código-fonte do Codex, não do `--help` |

---

## 4. Modo desatendido — flags exatas por família e o que acontece com uma ação que exigiria aprovação

### 4.1 Combinação recomendada por família (lote noturno, sem operador)

| Família | Flags para lote desatendido | O que acontece com ação que pediria aprovação |
| :--- | :--- | :--- |
| **Claude** | `-p --permission-mode bypassPermissions --permission-prompts none --disallowedTools "Bash(git push*),Bash(gh pr merge*),Bash(gh pr create*)" --add-dir <worktree>` (nunca `--permission-mode auto`: ver §2.4) | Com `bypassPermissions`, **não há pedido de aprovação a negar** — tudo roda, inclusive o que seria destrutivo, salvo o que está em `--disallowedTools` (que é aplicado antes, no nível de disponibilidade da ferramenta, não no de prompt). É por isso que a ADE **nunca** deve rodar `bypassPermissions` sem uma `disallowedTools` explícita cobrindo push/PR/merge — a rede de segurança real é o `contain` pós-fato, não o permission-mode |
| **Codex** | `codex exec --sandbox workspace-write --approve-for-me -C <worktree> ...` (achado novo: `--approve-for-me` = *"Route approval requests through automatic review using the workspace-write sandbox"* — o equivalente `exec` de um aprovador automático, já que `-a/--ask-for-approval` **não existe em `exec`**, confirmado no `--help` local) `[V]` | Uma ação fora do `workspace-write` (ex.: escrita fora do diretório declarado, acesso de rede sem `network_access=true`) é **bloqueada pelo próprio sandbox do SO**, não por um prompt — falha com erro de acesso negado (§3.2), não uma pergunta pendurada. Isso é estruturalmente diferente do Claude: o Codex nativo em Windows tem uma fronteira de SO real; o Claude não |
| **Gemini** | `--approval-mode yolo` (documentado; `-y/--yolo` é o alias deprecado) `[V-doc]` | Tudo roda sem pedir — mesmo risco do `bypassPermissions` do Claude: a rede de segurança vira 100% `contain` + o que o `--policy`/`--admin-policy` (não testado nesta rodada) filtrar antes |
| **Antigravity** | `--sandbox` (restrição de terminal no processo) + presets `toolPermission` (`always-proceed` para desatendido) | Restrição de terminal reduz superfície, mas não é isolamento de SO — mesma degradação do Gemini |

### 4.2 O que isso significa por nível de autonomia

- **`safe`**: nenhuma das flags acima muda — safe já é "roda sem perguntar" para ler/editar/testar/branch/commit, então `bypassPermissions`/`--approve-for-me`/`yolo` são seguros **desde que** `--disallowedTools`/sandbox neguem push e além. A ação que "exigiria aprovação" em `safe` é justamente algo fora do escopo `safe` (ex. um `git push`) — e aí a resposta certa não é "a CLI pergunta", é "a CLI nunca vê esse comando na allowlist/tools disponíveis".
- **`controlled`**: PR passa a ser permitido, mas **nunca dentro do worker**. A regra do runtime (`I55`,
  efeito externo sempre pelo engine) significa que mesmo com `bypassPermissions`/`yolo`/`--approve-for-me`
  ligados, `gh pr create`/`git push` continuam em `disallowedTools`/fora do `writable_roots` do worker —
  quem chama esses comandos é o **engine**, depois que o worker termina e o `contain` valida a árvore.
  Dependências e migrations continuam dentro do worktree do worker.
- **`restricted`**: aqui a resposta correta é **não desatender**. Nenhuma combinação de flags acima deve
  ser usada para produção/segredos/operações destrutivas — o design da §5 marca `restricted` como
  `ask_operator: "*"`, ou seja, o lote pausa e vira item de fila do painel independentemente do que as
  CLIs permitiriam tecnicamente.

---

## 5. `<repo>/.ade/config.json` — política de autonomia por repositório

Estende o schema já previsto na spec v2 §6 (`panel`, `visual`, `research`, `catalog`, `harness`,
`evals`) com um bloco `autonomy`. Amarra nível → `permitted_effects` (vocabulário de `I55` do runtime) →
flags por família → regras de `contain` → o que vira pergunta ao operador.

```jsonc
{
  "autonomy": {
    "default_level": "controlled",          // nível quando a story não declara um
    "operator_can_raise": true,              // resumo de aprovação pode elevar o nível de uma story específica
    "levels": {

      "safe": {
        "permitted_effects": {               // vocabulário igual a I55 (permitted_effects do lote)
          "local_write": true, "branch": true, "commit": true,
          "push": false, "pr": false, "merge": false, "deploy": false,
          "dependency_add": false, "migration_run": false, "secrets_read": false
        },
        "contain": {
          "scope_paths": "${story.scope_paths}",
          "deny_paths_always": [".env*", "**/secrets/**", ".git/hooks/**", "~/.ssh/**", "~/.aws/**", "**/*.pem", "**/*credentials*"],
          "on_scope_violation": "restore_and_park",   // igual a I25 do runtime
          "on_secret_found": "stop_batch"              // igual a I23: segurança > escopo, sempre
        },
        "families": {
          "claude": {
            "permission_mode": "bypassPermissions", "permission_prompts": "none",
            "disallowedTools": ["Bash(git push*)", "Bash(gh pr*)", "Bash(gh release*)", "WebFetch"],
            "add_dir": ["${worktree}"]
          },
          "codex": {
            "sandbox": "workspace-write", "approve_for_me": true,
            "network_access": false,
            "rules_file": ".ade/execpolicy/safe.rules"
          },
          "gemini": { "approval_mode": "auto_edit", "policy": [".ade/policy/safe.json"] }
        },
        "ask_operator": ["hard_deny (qualquer família)", "segundo scope_violation na mesma story"]
      },

      "controlled": {
        "permitted_effects": {
          "local_write": true, "branch": true, "commit": true,
          "push": true, "pr": true, "merge": false, "deploy": false,
          "dependency_add": true, "migration_run": true, "secrets_read": false
        },
        "contain": {
          "scope_paths": "${story.scope_paths}",
          "deny_paths_always": "${safe.contain.deny_paths_always}",
          "on_scope_violation": "restore_and_park",
          "on_secret_found": "stop_batch"
        },
        "families": {
          "claude": {
            "permission_mode": "bypassPermissions", "permission_prompts": "none",
            "disallowedTools": ["Bash(git push*)", "Bash(gh pr merge*)", "Bash(gh pr create*)"],
            "note": "push/pr sempre pelo engine, nunca no worker — ver §4.2"
          },
          "codex": {
            "sandbox": "workspace-write", "approve_for_me": true, "network_access": true,
            "rules_file": ".ade/execpolicy/controlled.rules"
          },
          "gemini": { "approval_mode": "auto_edit", "policy": [".ade/policy/controlled.json"] }
        },
        "engine_only_effects": ["push", "pr_create"],
        "ask_operator": ["merge", "dependência com bump major", "migration com DROP/TRUNCATE", "hard_deny"]
      },

      "restricted": {
        "permitted_effects": {
          "local_write": true, "branch": true, "commit": true,
          "push": false, "pr": false, "merge": false, "deploy": false,
          "dependency_add": false, "migration_run": false, "secrets_read": false
        },
        "contain": {
          "scope_paths": ["**"],
          "deny_paths_always": "${safe.contain.deny_paths_always}",
          "on_scope_violation": "stop_batch",
          "on_secret_found": "stop_batch"
        },
        "families": {
          "claude": { "permission_mode": "plan", "permission_prompts": "host" },
          "codex": { "sandbox": "read-only", "approve_for_me": false },
          "gemini": { "approval_mode": "plan" }
        },
        "ask_operator": ["*"],
        "note": "nenhum lote 'restricted' roda desatendido; todo efeito externo pausa em awaiting_operator"
      }
    }
  }
}
```

### 5.1 O que fica fixo em todos os níveis (precedência já provada do runtime, `I23`)

- **Segurança > escopo, sempre.** `deny_paths_always` e a varredura de segredo (`I22`–`I24`) valem
  **igual nos três níveis** — `safe` não é "menos seguro", é "menos aprovação exigida para efeito
  permitido". Um segredo no diff para o batch em `safe` exatamente como pararia em `restricted`.
- **Efeito externo é sempre do engine.** `push`, `pr_create`, `merge`, `deploy` nunca aparecem como
  ferramenta disponível ao worker em nenhum nível — isso está em `disallowedTools`/`sandbox
  network_access=false`/ausência de credencial no ambiente filtrado do worker (`I49`), não numa
  permissão que o nível concede. O que muda por nível é se o **engine**, depois do `gates`, está
  autorizado a executar esses efeitos (governado por `permitted_effects`, igual a `I55`).
- **Ambiente do worker é filtrado** (`I49`): nenhum nível herda `process.env` inteiro; token de
  push/PAT/chave de API de produção nunca chega ao processo do worker em nenhum nível — só o processo
  do engine que efetivamente executa `git push`/`gh pr create` tem a credencial.

### 5.2 O que o journal grava e o que o resumo de aprovação mostra

- Cada mudança de nível (por story ou por lote) é um `step` próprio no journal, com o `permitted_effects`
  resultante — mesmo grão que `I55` já usa para recusar lote com `local_write: false`.
- O resumo de aprovação (spec v2 §7.6) ganha uma linha por story: nível de autonomia + lista de
  `permitted_effects` habilitados + o que caiu em `ask_operator` para aquele nível — o operador aprova o
  **nível**, não uma lista de comandos individuais.
- `ade doctor` reporta, por família, se as flags do nível ativo realmente existem no binário instalado
  (ex.: se `codex exec --approve-for-me` sumir numa versão futura, doctor falha alto e a ADE não finge
  que o nível `controlled` ainda é seguro).

---

## 6. Onde a ADE fica sem rede de proteção nativa em Windows

Lista explícita do que **nenhum** mecanismo nativo cobre — o que o engine tem que fazer sozinho:

1. **Nenhuma CLI tem sandbox de SO plug-and-play para as três famílias ao mesmo tempo.** Claude: zero em
   Windows nativo (`[V-doc]`). Gemini/Antigravity: zero (`[V-doc]`, só restrição de terminal no
   processo). Codex: existe, mas testado nesta rodada como **não zero-config** — a chave que libera
   escrita no próprio cwd não está em `--help` público (§3.2). **Consequência:** `contain` +
   worktree isolado continua sendo a única fronteira universal, exatamente como a spec v2 já assume —
   esta rodada só torna a lacuna do Codex explícita em vez de assumida por inferência.
2. **Nenhum mecanismo nativo escaneia o diff por segredo.** `auto-mode` julga *intenção* de exfiltração
   (destino, se é externo); `execpolicy` julga o *comando*, não o *conteúdo* que ele escreve; o sandbox de
   SO controla *onde* se escreve, não *o quê*. A varredura de padrão de segredo no diff inteiro (`I22`–
   `I24` do runtime) é só do `contain` — nenhuma CLI reimplementa isso.
3. **`auto-mode` é exclusivo da família Claude e semântico, não determinístico.** Não há equivalente
   testável para Codex/Gemini com o mesmo poder de julgamento de intenção — o execpolicy do Codex e o
   Policy Engine do Gemini são baseados em padrão de comando, não em "para onde os dados finais vão".
   Uma política cross-family de intenção não existe hoje; se a ADE quiser isso, tem que escrevê-la.
4. **O resultado textual final de uma sessão `-p` não é confiável como prova de execução** (§2.3): o
   modelo pode reportar sucesso depois de uma tentativa negada e uma retentativa bem-sucedida — ou,
   no limite, sem nenhuma tentativa real. O engine **nunca** deve tratar `result`/`last_assistant_message`
   como evidência; só o diff de árvore e os eventos estruturados (`permission_denials`, `tool_result`)
   contam — o que já é o princípio 2 da spec v2 ("evals definem pronto"), agora com uma prova concreta do
   motivo.
5. **"Assumir o terminal" apaga todas as camadas acima.** Quando o operador digita direto no PTY
   interativo, nem `auto-mode`, nem `execpolicy`, nem sandbox, nem `--disallowedTools` estão no caminho —
   é o operador falando com a CLI sem filtro algum (spec v2 §5 já assume isso: "digitação do operador não
   é interpretada; só o resultado na árvore conta"). Esta rodada confirma que essa regra não é uma
   simplificação — é a **única** invariante que sobrevive ao takeover, porque é a única implementada fora
   de qualquer CLI.
6. **Nenhuma CLI expõe um jeito confiável de provar, de fora, que seu próprio sandbox estava realmente
   ativo durante uma chamada específica** (só o Codex grava log de sandbox em `.sandbox/`, os outros não
   têm equivalente confirmado). O `ade doctor` pode checar se o sandbox *existe*/*está configurado*, mas
   não pode auditar retroativamente se uma chamada específica rodou dentro dele — outro motivo para o
   `contain` pós-fato ser a fonte de verdade, nunca a alegação de configuração.
7. **ACP não resolve nada disto.** `adapters-and-acp.md` §1.2 já mapeou: zero `allowlist`/`sandbox` no
   schema v1 do protocolo — se a ADE migrar para ACP, o `contain` continua sendo implementado pelo
   cliente (a ADE), exatamente como hoje. Migrar para ACP não é uma forma de terceirizar esta lacuna.
8. **Gemini/Antigravity: sem teste de `failIfUnavailable` equivalente localizado nesta pesquisa.** Não há
   confirmação de que o Policy Engine do Gemini falha fechado quando um arquivo de `--policy` é inválido
   ou ausente — ao contrário do execpolicy do Codex (testado: arquivo vazio → sem decisão, não crash) e do
   sandbox do Claude (documentado: falha aberto salvo `failIfUnavailable`). Fica como item para o
   `ade doctor` verificar antes de confiar em `--policy` na v1.

---

## Fontes

Todas as citações de `--help`/execução são desta máquina, 2026-09-16, versões no topo do documento.

- `claude --help`, `claude auto-mode --help`, `claude auto-mode config`, `claude auto-mode defaults` (execução local)
- `codex --help`, `codex exec --help`, `codex sandbox --help`, `codex execpolicy --help`, `codex execpolicy check --help` (execução local)
- `~/.codex/config.toml`, `~/.codex/rules/default.rules` (arquivos locais lidos)
- `gemini --help`, `agy --help` (execução local)
- Teste ao vivo: hook `PreToolUse` em `.claude/settings.json` isolado, sessão `claude -p` com
  `--output-format stream-json --include-hook-events`, scratchpad desta sessão
- Teste ao vivo: `claude -p --permission-mode auto --permission-prompts none` contra `git status` num
  repo git vazio, scratchpad desta sessão
- Teste ao vivo: `codex execpolicy check` com regras Starlark próprias (allow/forbidden/sem-match),
  scratchpad desta sessão
- Teste ao vivo: `codex sandbox -P <perfil> -C <dir>` com override `-c permissions.default.*`,
  scratchpad desta sessão
- `E:\Documentos\ProjetosIA\TL-ADE\PROMPT.md` §3 (princípios 5, 10, 11)
- `E:\Documentos\ProjetosIA\TL-ADE\docs\specs\2026-09-16-ade-design.md` §6, §9, §13
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\capabilities-claude-code.md` §4, §5
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\capabilities-codex.md` §4
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\capabilities-gemini-antigravity.md` §2.1, §4, §5
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\adapters-and-acp.md` §1.1–1.5, §3.5
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\landscape-routing-skills-terminal.md` §3.2, §4, §5 (item 7)
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\runtime-port-map.md` I19–I27, I49, I55
- `E:\Documentos\ProjetosIA\tl-orchestrator-release\docs\RUNTIME.md` (referência indireta via runtime-port-map.md)
