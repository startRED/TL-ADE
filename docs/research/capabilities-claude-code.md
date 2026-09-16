# Capacidades reais do Claude Code 2.1.271 — insumo do Capability Registry da ADE

Data da pesquisa: 2026-09-16. Binário verificado na máquina: `claude --version` → `2.1.271 (Claude Code)`,
resolvido por `E:\Apps\npm\claude` → `node_modules/@anthropic-ai/claude-code/bin/claude.exe` (Windows 11 Pro 26200).
Docs oficiais consultadas em 2026-09-16 (code.claude.com/docs). CHANGELOG do repo `anthropics/claude-code`
lido via `gh api` (topo em 2.1.273; entrada 2.1.271 presente).

Legenda: **[V]** verificado em fonte primária (com a fonte no próprio item) · **[I]** inferido ·
**[H]** hipótese. Nenhuma inferência é apresentada como fato.

Método: `claude --help` e helps de subcomando na máquina; probes de existência de flag via
`claude -p <flag>` sem valor (o parser Commander responde `argument missing` para flag existente e
`unknown option` para inexistente — não chega a fazer chamada de API, custo zero); um smoke test único
autorizado; docs oficiais; CHANGELOG.

---

## 0. Resumo executivo para a ADE

Cinco fatos que mudam decisões já fixadas na spec v2:

1. **`--json-schema` existe.** Saída estruturada validada por JSON Schema em `-p`, entregue no campo
   `structured_output` do JSON de resultado. O "protocolo de saída estruturada" por prompt (spec §7)
   deixa de ser necessário para plano, research-finding e visual-eval. **[V]**
2. **`--max-budget-usd` existe.** Orçamento por chamada aplicado pelo próprio CLI. O engine mantém o
   orçamento por story/lote, mas pode delegar o teto por chamada. **[V]**
3. **`--advisor <model>` existe.** A spec §12 afirma "Sem advisor nativo das CLIs" — está errado para o
   Claude Code 2.1.271. **[V]**
4. **O sandbox de SO NÃO roda em Windows nativo** (macOS, Linux e WSL2 apenas). A spec §13 lista
   "sandbox de SO" como força do Claude Code; na máquina alvo ela não existe. **[V]**
5. **`--bare` quebra a autenticação por assinatura**: em modo bare, auth Anthropic é estritamente
   `ANTHROPIC_API_KEY` ou `apiKeyHelper`; OAuth e keychain nunca são lidos. Contradiz a decisão
   "sem chave de API obrigatória" (spec §2). Para isolamento sem perder a assinatura, usar
   `--safe-mode` ou `--setting-sources` + `--strict-mcp-config`. **[V]**

---

## 1. Modo headless (`-p` / `--print`)

| Capacidade | Flag exata | Fonte |
| :--- | :--- | :--- |
| Prompt | posicional, ou stdin (pipe, cap 10 MB) | `claude --help`; docs/headless **[V]** |
| Formato de saída | `--output-format text\|json\|stream-json` | `claude --help` **[V]** |
| Formato de entrada | `--input-format text\|stream-json` | `claude --help` **[V]** |
| Saída por schema | `--json-schema '<JSON Schema>'` → campo `structured_output` | docs/headless **[V]** |
| Limite de turnos | `--max-turns <turns>` (só com `-p`) | probe local + docs/cli-reference **[V]** |
| Orçamento por chamada | `--max-budget-usd <amount>` (só com `-p`) | `claude --help` **[V]** |
| System prompt | `--system-prompt`, `--system-prompt-file`, `--append-system-prompt`, `--append-system-prompt-file` | `claude --help` + probe **[V]** |
| System prompt de subagente | `--append-subagent-system-prompt[-file]` (só `-p`) | probe local; docs (v2.1.205/261+) **[V]** |
| Modo mínimo | `--bare`, `--safe-mode`, `--restricted` (três modos distintos) | `claude --help` **[V]** |
| Sem persistência | `--no-session-persistence` (só `-p`) | `claude --help` **[V]** |
| Parciais / hooks / subagentes no stream | `--include-partial-messages`, `--include-hook-events`, `--forward-subagent-text`, `--replay-user-messages` | `claude --help` **[V]** |
| Sugestão de próximo prompt | `--prompt-suggestions` | `claude --help` **[V]** |

Detalhes que importam:

- **Ordem dos argumentos.** `--allowedTools`, `--disallowedTools`, `--tools`, `--mcp-config`,
  `--plugin-url`, `--channels` e `--file` são **variádicos** (`<tools...>`). Um prompt posicional
  colocado depois deles é engolido como mais um valor. A regra da spec §5 ("prompt antes de
  `--allowedTools`") está correta; o motivo é a variadicidade. **[V]** (`claude --help`)
- **Os três modos mínimos não são equivalentes** **[V]** (`claude --help`, docs/headless):
  - `--bare` — pula hooks, LSP, sync de plugins, atribuição, auto-memory, prefetches, leituras de
    keychain e auto-descoberta de CLAUDE.md. Define `CLAUDE_CODE_SIMPLE=1`. **Auth só por
    `ANTHROPIC_API_KEY`/`apiKeyHelper`.** Contexto volta por `--system-prompt[-file]`,
    `--append-system-prompt[-file]`, `--add-dir`, `--mcp-config`, `--settings`, `--agents`,
    `--plugin-dir`. Skills ainda resolvem por `/nome-da-skill`. A doc diz que `--bare` "will become
    the default for `-p` in a future release".
  - `--safe-mode` — desliga todas as customizações (CLAUDE.md, skills, plugins, hooks, MCP, comandos,
    agentes, output styles, workflows, temas, keybindings). **Auth, modelo, ferramentas nativas e
    permissões funcionam normalmente.** Define `CLAUDE_CODE_SAFE_MODE=1`. É o modo certo para a ADE
    quando quer reprodutibilidade sem perder a assinatura. **[I para a recomendação; V para o que faz]**
  - `--restricted` — remove as ferramentas que executam comando/código (Bash, PowerShell, REPL) e
    WebFetch salvo se `--tools` as nomear; ignora settings de user/project/local; confina file tools
    aos working directories; recusa `bypassPermissions`. Pensado para harness de avaliação.
- **Sem `-p`, um diretório não confiável ainda roda hooks do `.claude/settings.json` do projeto e
  conecta os servidores do `.mcp.json`** — `-p` pula o diálogo de workspace trust. Relevante para o
  catálogo de terceiros e para worktrees de repositórios alheios. **[V]** (docs/headless)
- Saída não lida rapidamente: o processo espera o dreno da fila até 30 s antes de sair. **[V]**
- SIGTERM → exit 143, turno fica inacabado e é retomado no `--resume`; SIGINT encerra o turno. Só o
  hook `SessionEnd` roda na saída. **[V]** (docs/headless) — casa direto com a reconciliação na
  retomada do runtime portado.
- Tarefas Bash de fundo morrem ~5 s após o resultado; **subagente/workflow de fundo segura o processo**
  até terminar, com teto de 10 min ocioso (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `0` = sem teto). **[V]**

### Skills e comandos em `-p`

Skills invocadas pelo usuário funcionam em `-p`: basta incluir `/nome-da-skill` na string do prompt.
`/model`, `/effort`, `/fast`, `/color`, `/rename` aceitam valor como argumento; `/config key=value`
muda setting numa invocação `-p` (v2.1.205+). `/login` e afins não existem em `-p`. **[V]** (docs/headless)

---

## 2. Sessões

| Capacidade | Flag | Fonte |
| :--- | :--- | :--- |
| Retomar por ID/nome/caminho do `.jsonl` | `-r, --resume [value]` | `claude --help`, docs/sessions **[V]** |
| Continuar a mais recente do diretório | `-c, --continue` | idem **[V]** |
| ID de sessão escolhido pelo chamador | `--session-id <uuid>` | `claude --help` **[V]** |
| Bifurcar ao retomar | `--fork-session` | `claude --help` **[V]** |
| Nome de exibição | `-n, --name <name>` | `claude --help` **[V]** |
| Sessão de fundo | `--bg` / `--background`, + `claude attach|logs|stop|rm|respawn|agents` | `claude --help` **[V]** |

**`--session-id <uuid>` é a peça de ouro para o journal da ADE**: o engine gera o UUID, grava no
`step_intent` antes do efeito e não precisa fazer parsing da saída para correlacionar. **[I]** (a flag
é **[V]**; o uso proposto é inferência de design.)

**Fidelidade do resume (crítico para "assumir o terminal")** — docs/sessions **[V]**:

- Sessões criadas com `claude -p` ou pelo Agent SDK **ficam fora do picker e fora de `claude --continue`**.
  Continuam retomáveis por `claude --resume <session-id>` — inclusive **em modo interativo**. Ou seja:
  headless → interativo funciona, mas **só pelo ID**. A ADE já tem o ID (`--session-id`).
- `claude --resume <session-id>` roda **de qualquer diretório** (v2.1.223+): procura no projeto atual e
  worktrees, depois em todos os projetos da máquina.
- **Restaurado:** histórico completo (incluindo tool_use/tool_result), modelo, agente (`--agent`),
  goal ativo, scheduled tasks não expiradas, worktree da sessão.
- **NÃO restaurado:** `--mcp-config`, `--settings`, `--plugin-dir`, `--fallback-model`, `--add-dir`
  (precisam ser repassados); tarefas Bash/monitor de fundo; ferramenta que estava em execução quando o
  processo morreu não termina nem re-executa.
- **Modo de permissão:** restaurado só no resume **interativo** por `--continue` / `--resume <id>` /
  `--resume <nome único>`. Nunca restaurado pelo picker, por `/resume`, nem por `-p`. `bypassPermissions`
  e `plan` **nunca** voltam no terminal. Em `-p` só `plan` volta, e apenas com as quatro condições
  (`--permission-prompt-tool` presente; sem `--permission-mode`/`--dangerously-skip-permissions`; sem
  `--fork-session`; fora de channels).
- Transcrições: `~/.claude/projects/<project>/<session-id>.jsonl`. **O formato de linha é interno e muda
  entre versões — a doc desaconselha explicitamente parsear.** A ADE deve usar `--output-format json`
  / `stream-json` / `transcript_path` dos hooks, não ler o `.jsonl`. **[V]**
- Retenção: `cleanupPeriodDays` (30 dias por padrão). `CLAUDE_CODE_SKIP_PROMPT_HISTORY` suprime escrita
  de transcript. **[V]**

**Consequência para o step `human_takeover` da spec §5:** o fluxo é `claude --resume <uuid>` interativo
no mesmo worktree, repassando `--mcp-config/--settings/--add-dir` originais e um `--permission-mode`
explícito (porque o modo não volta sozinho quando vem do picker e nunca volta se era bypass). **[I]**

---

## 3. Modelos, esforço e orquestração

### Modelos **[V]** (docs/model-config, 2026-09-16)

| Alias | ID na Anthropic API | Janela padrão | Com `[1m]` |
| :--- | :--- | ---: | ---: |
| `fable` | `claude-fable-5-1` | 200K | 1M |
| `opus` | `claude-opus-5` | 200K | 1M |
| `sonnet` | `claude-sonnet-5` | **1M nativo** | 1M |
| `haiku` | `claude-haiku-4-5` | **100K** | — (não suporta) |

- `--model <alias|id>`; sufixo `[1m]` habilita 1M (`claude --model opus[1m]`). **[V]**
- **Surpresa:** não existe "haiku 5.x". O classificador barato da spec §7 roda em
  `claude-haiku-4-5`, janela 100K. Confirmado empiricamente no smoke test
  (`modelUsage."claude-haiku-4-5-20251001".contextWindow = 200000` — o relatório traz 200000; a doc
  diz 100K para Haiku 4.5. Divergência registrada, ver §9). **[V para o campo; divergência aberta]**
- `--fallback-model <a,b,c>`: lista separada por vírgula, tentada em ordem quando o primário está
  sobrecarregado; re-tenta o primário no início de cada turno do usuário. **[V]** (`claude --help`)
- Env: `ANTHROPIC_DEFAULT_MODEL`, `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE,HAIKU}_MODEL`,
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS`, `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. **[V]**

### Esforço **[V]**

- `--effort <level>`: o `--help` local lista `low, medium, high, xhigh, max`.
- **`ultracode` existe e é aceito**, mas não aparece na lista do help. Probe:
  `claude -p --effort ultracode` → passa (só reclama de prompt ausente); `claude -p --effort bogus` →
  `Warning: Unknown --effort value 'bogus' — ignoring it... Valid values: low, medium, high, xhigh, max`.
  Ou seja, `ultracode` é aceito silenciosamente. **[V: probe local]**
- **O que `ultracode` faz** (docs/model-config): envia esforço `xhigh` ao modelo **e** orquestra
  *dynamic workflows* para tarefas substanciais. Ativável por `/effort ultracode`, `--effort ultracode`
  ou `{ "ultracode": true }` em settings. Indisponível quando workflows estão desligados, quando o
  modelo não suporta `xhigh`, ou quando o teto de esforço da organização é menor que `xhigh`. **[V]**
- Persistência: `CLAUDE_CODE_EFFORT_LEVEL`, `effortLevel`, `modelSettings.<model>.effort`. **[V]**
- Raciocínio adaptativo é padrão em Fable 5.x, Sonnet 5/4.6, Opus 5/4.8/4.7 e **não pode ser desligado**;
  `MAX_THINKING_TOKENS` só afeta Opus 4.6 / Sonnet 4.6. **[V]**

### Advisor, safe mode, workflows — respostas diretas às perguntas do prompt

- **`--advisor <model>`: EXISTE.** Probe local: `error: option '--advisor <model>' argument missing`.
  Doc (cli-reference): "Enable server-side advisor tool with model alias or full model ID
  (`fable`, `opus`, `sonnet`)". **Contradiz a spec §12.** **[V]**
- **`--safe-mode`: EXISTE** e é feature oficial documentada (ver §1). **[V]**
- **Workflow tool / orquestração multi-agente é oficial**, não comunitária:
  - `--effort ultracode` orquestra dynamic workflows (docs/model-config). **[V]**
  - CHANGELOG 2.1.269: `CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS` (1–256) para elevar o limite de
    agentes concorrentes por run do Workflow tool. **[V]**
  - CHANGELOG 2.1.270: tamanho padrão de dynamic workflow passa a `small` no plano Pro; guideline do
    `medium` cai de 15 para 10 agentes. **[V]**
  - CHANGELOG 2.1.271: workflows dinâmicos pausam ao bater limite de uso e continuam sozinhos no reset. **[V]**
  - `claude ultrareview [target]` — revisão multi-agente hospedada na nuvem, com `--json`,
    `--timeout <min>`, `--post`/`--no-post`. **[V]** (`claude ultrareview --help`)
  - **Agent teams**: desligados por padrão, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; a doc de custos
    estima **~7× mais tokens** que sessões normais quando teammates rodam em plan mode. **[V]**
- `CLAUDE_CODE_SUBAGENT_MODEL`: **existe e é documentado** (docs/sub-agents). Aceita alias ou ID.
  Ordem de resolução: `model` da invocação → frontmatter do subagente → `CLAUDE_CODE_SUBAGENT_MODEL` →
  modelo da conversa principal. `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` (v2.1.257+) força todos. **[V]**

---

## 4. Permissões e sandbox

### Permissões **[V]** (`claude --help` + probes + docs)

- `--permission-mode <mode>`: o parser recusa valor inválido com
  `Allowed choices are acceptEdits, auto, bypassPermissions, manual, dontAsk, plan`.
  **`default` também é aceito** (probe passou), embora não apareça nessa mensagem — a doc trata
  `default` e `manual` como o mesmo modo. **[V]**
- `--allowedTools` / `--disallowedTools`: lista separada por vírgula **ou espaço**, sintaxe de
  permission rule. `Bash(git diff *)` faz prefix match — **o espaço antes do `*` importa**:
  `Bash(git diff*)` casaria também `git diff-index`. Nome nu em `--disallowedTools` remove a
  ferramenta (`"Edit"`, `"*"`, `"mcp__*"`); regra com escopo (`Bash(rm *)`) mantém a ferramenta e nega
  só as chamadas que casam. **[V]** (docs/headless, docs/cli-reference)
- `--tools <tools...>`: restringe o conjunto de ferramentas nativas. `""` desabilita todas,
  `"default"` usa todas. Diferente de `--allowedTools` (que é auto-aprovação, não disponibilidade). **[V]**
- `--dangerously-skip-permissions` = `--permission-mode bypassPermissions`.
  `--allow-dangerously-skip-permissions` apenas disponibiliza o modo no ciclo Shift+Tab sem iniciar nele. **[V]**
- `--permission-prompt-tool <tool>`: **existe** (probe local). Ferramenta MCP que responde prompts de
  permissão em modo não-interativo. **[V]**
- `--permission-prompts host|none` (v2.1.259+): `none` = ninguém responde, tudo que prompt aria é
  negado automaticamente e o Claude é informado de que não deve tentar de novo; remove `AskUserQuestion`
  e cancela elicitations MCP não respondidas. **É a flag certa para lote desatendido da ADE.** **[V]**
- Em `-p`, o modo inicial embutido é **Manual em todos os planos** — se a ADE não passar
  `--permission-mode`, tudo que precisa de aprovação simplesmente falha. **[V]** (docs/headless)
- Com `--output-format stream-json`, negações aparecem como mensagens `permission_denied` e o `result`
  final lista em `permission_denials` (campo confirmado no smoke test: `"permission_denials":[]`). **[V]**

### Sandbox de SO **[V]** (docs/sandboxing)

- **"The sandbox is built into Claude Code and runs on macOS, Linux, and WSL2. Native Windows is not
  supported. On Windows, run Claude Code inside a WSL2 distribution."** Isso invalida o sandbox como
  capacidade do adapter `claude` na máquina alvo (Windows 11 nativo).
- Não existe flag `--sandbox` (probe: `unknown option '--sandbox'`). Ativação é por settings:
  `claude --settings '{"sandbox": {"enabled": true, "allowUnsandboxedCommands": false}}'`, ou
  `sandbox.enabled` em `~/.claude/settings.json`, ou `/sandbox` na sessão. **[V]**
- Chaves relevantes: `sandbox.enabled`, `sandbox.allowUnsandboxedCommands`, `sandbox.failIfUnavailable`,
  `sandbox.autoAllowBashIfSandboxed`, `sandbox.filesystem.{allowRead,denyRead,denyWrite,disabled}`,
  `sandbox.network.{allowUnixSockets,tlsTerminate,allowManagedDomainsOnly}`, `sandbox.excludedCommands`,
  `sandbox.credentials.{files,envVars,awsPairs,sigv4}`, `permissions.blockReadsOutsideWorkingDirectories`. **[V]**
- Por padrão, se o sandbox não pode iniciar (plataforma não suportada, dependência faltando), **o Claude
  Code avisa e roda sem sandbox** — falha aberta. `sandbox.failIfUnavailable: true` torna isso erro duro. **[V]**
- **Consequência para a ADE:** o `contain` da spec §6 não pode delegar contenção ao sandbox do Claude
  Code no Windows. Contenção continua sendo responsabilidade do engine (worktree + verificação de árvore
  + `--add-dir` restrito + `--disallowedTools`), e `sandbox.failIfUnavailable: true` serve como detector
  honesto no `ade doctor`. **[I]**

---

## 5. Extensibilidade

### Hooks **[V]** (docs/hooks)

- **Rodam em headless `-p`** (e em cloud, terminal, IDE, desktop). Exceções: `SessionStart` pula hooks
  do tipo `mcp_tool` no launch; `Setup` sempre pula hooks `mcp_tool`.
- Eventos (40+), agrupados: por sessão — `SessionStart`, `Setup`, `SessionEnd`; por turno —
  `UserPromptSubmit`, `UserPromptExpansion`, `Stop`, `StopFailure`; loop de ferramenta — `PreToolUse`,
  `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch`;
  assíncronos — `FileChanged`, `CwdChanged`, `DirectoryAdded`, `ConfigChange`, `InstructionsLoaded`,
  `PreCompact`, `PostCompact`, `PreModelSwitch`, `PostModelSwitch`, `WorktreeCreate`, `WorktreeRemove`,
  `MessageDisplay`, `Notification`, `TeammateIdle`, `SubagentStart`, `SubagentStop`, `TaskCreated`,
  `TaskCompleted`, `Elicitation`, `ElicitationResult`.
- **PreToolUse com JSON de decisão:**
  ```json
  {"hookSpecificOutput":{"hookEventName":"PreToolUse",
   "permissionDecision":"allow|deny|skip",
   "permissionDecisionReason":"...",
   "updatedInput":{"command":"..."}}}
  ```
  Exit 0 + JSON → decisão vale; exit 2 → bloqueia independente do JSON; outro código → erro não bloqueante.
- Tipos de hook: `command`, `http`, `mcp_tool`, `prompt`, `agent`. Campos: `matcher` (nome de ferramenta,
  alternativa `A|B` ou regex), `if` (filtro extra, ex. `Bash(rm *)`), `timeout`, `statusMessage`, `once`,
  `async`, `asyncRewake`, `shell` (`bash`|`powershell`). Placeholders `${CLAUDE_PROJECT_DIR}`,
  `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`.
- Input comum: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode`,
  `hook_event_name`, `agent_id`, `agent_type`.
- Origens que somam (não se substituem): managed policy > `.claude/settings.json` >
  `.claude/settings.local.json` > `~/.claude/settings.json` > `hooks/hooks.json` de plugin >
  frontmatter de skill > frontmatter de subagente. `disableAllHooks: true` desliga tudo.
- **`--include-hook-events`** joga o ciclo de vida dos hooks no stream `stream-json`. **[V]** (`claude --help`)
- A doc de custos traz **exatamente** o padrão "saída filtrada" da spec §12: um `PreToolUse` que reescreve
  o comando com `updatedInput` para devolver só falhas. **[V]**

### Skills **[V]** (docs/skills)

- Locais: `~/.claude/skills/<n>/SKILL.md` (pessoal), `.claude/skills/<n>/SKILL.md` (projeto),
  `<subdir>/.claude/skills/...` (aninhada), `<plugin>/skills/<n>/SKILL.md` (invocada como
  `/plugin:skill`), e `.claude/skills/` no diretório de managed settings (enterprise).
- Frontmatter suportado: `name`, `description`, `when_to_use` (soma até 1.536 chars com description),
  `argument-hint`, `arguments`, `disable-model-invocation`, `user-invocable`, `allowed-tools`,
  `disallowed-tools`, `model`, `effort`, `context: fork`, `agent`, `background`, `paths`, `shell`,
  `hooks`, `metadata`, `license`, `compatibility`.
- **Descoberta automática (progressive disclosure):** só as `description` entram no contexto a cada
  turno; o corpo entra quando a skill é invocada. Isso é exatamente o modelo de "índice" da spec §9 —
  e significa que **o catálogo em escala não precisa reimplementar seleção por descrição para skills
  que a ADE decidir instalar**; precisa para as que ficarem fora (que é o caso, por segurança).
- Precedência com nomes iguais: enterprise > pessoal > projeto; local > bundled; local > sincronizada
  do claude.ai; skills de plugin são namespaced.
  **Atenção:** isso inverte a regra da spec §9 ("skills do repositório têm prioridade sobre catálogo") —
  no Claude Code, **pessoal (`~/.claude`) ganha de projeto (`.claude`)**. **[V]**
- Em `-p`: skills locais e de plugin funcionam plenamente. Skills sincronizadas do claude.ai têm
  comandos `!` desabilitados em headless.
- Injeção dinâmica de contexto: `` !`comando` `` roda antes do modelo ver a skill; falha aborta a invocação.
- Substituição: `$ARGUMENTS`, `$0..$n`, `$nome`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`,
  `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`.
- Ciclo de vida: conteúdo persiste entre turnos; após auto-compact, os primeiros 5.000 tokens de cada
  skill são reanexados, até 25.000 tokens combinados.
- `--disable-slash-commands` desliga **todas** as skills na sessão; `disableBundledSkills: true`
  desliga só as embutidas. **[V]**

### Subagentes **[V]** (docs/sub-agents)

- Prioridade: managed settings > `--agents` (CLI) > `.claude/agents/` > `~/.claude/agents/` >
  `agents/` de plugin.
- Frontmatter: `name`, `description`, `tools`, `disallowedTools`, `model` (alias, ID ou `inherit`),
  `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `memory` (`user|project|local`),
  `background`, `omitClaudeMd`, `effort`, **`isolation: worktree`**, `color`, `initialPrompt`,
  `experimental` (ex. `cacheTtl: 5m|1h`).
- `--agents '<json>'` aceita: `description`, `prompt` (system prompt), `tools`, `disallowedTools`,
  `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `initialPrompt`, `memory`,
  `effort`, `background`, `omitClaudeMd`, `isolation`. Validado no startup.
- **Isolamento de contexto:** contexto novo com system prompt + mensagem de delegação + CLAUDE.md
  (salvo `omitClaudeMd: true`) + snapshot de git status + skills pré-carregadas + roster de agentes.
  **Não herda:** histórico da conversa, output style, auto memory, tamanho da janela do pai.
  Exceção: fork (`/subtask`) herda o pai.
- Tipos embutidos: `Explore` (read-only), `Plan` (read-only), `General-purpose`, `claude`.
- `--agent <agent>` faz o agente ser a sessão principal.

### Plugins e marketplace **[V]** (`claude plugin --help`)

- `claude plugin details|disable|enable|eval|init|install|list`, `--plugin-dir <path>` (diretório, `.zip`,
  ou pasta de plugins — v2.1.265+), `--plugin-url <url>`.
- **`claude plugin eval [target]`** roda `<eval dir>/**/case.yaml` (ou `prompt.md` + `graders/*.md`)
  contra um plugin e reporta resultados pontuados, **adicionando um braço de baseline sem plugin**.
  Isso é o A/B estilo Caliper da spec §12, já pronto e de primeira parte. **[V]**
  A própria ajuda avisa: roda na sua máquina, como você; o sandbox do run limita mas não garante;
  suíte passar não é vetting de segurança. `--trust-plugin` responde a confirmação em CI.
- `claude plugin details <n>` mostra inventário de componentes e **custo de tokens projetado** — insumo
  direto para o "menos-é-mais" da spec §12. **[V]**

### MCP **[V]**

- `--mcp-config <configs...>` (arquivos JSON ou strings, separados por espaço) e `--strict-mcp-config`
  (usa **só** o que veio em `--mcp-config`, ignorando toda outra configuração MCP).
- Com `-p`, espera servidores pendentes até `MCP_TIMEOUT` (30 s padrão). Servidor remoto com lista de
  ferramentas em cache pula a espera, aparece `pending` no `system/init` e conecta na primeira chamada.
- `system/init` traz `mcp_servers` (`name`, `status`) e `mcp_server_errors` (`name`, `type`, `message`;
  `type` ∈ `unknown_type`, `url_missing_type`, `invalid_config`, `reserved_name`) — **portão de CI da ADE
  para detectar servidor que não subiu**. Idem `plugins` / `plugin_errors`.
- Definições de ferramentas MCP são **deferred por padrão**: só nomes e instruções do servidor entram no
  contexto até o uso. **[V]** (docs/costs)
- `claude mcp add|add-json|get|list|login|logout|...` para gestão fora da sessão.

### Memória **[V]** (docs/memory)

- Hierarquia de carregamento (do mais amplo ao mais específico):
  managed policy (`C:\Program Files\ClaudeCode\CLAUDE.md` no Windows) → `~/.claude/CLAUDE.md` →
  `./CLAUDE.md` ou `./.claude/CLAUDE.md` → `./CLAUDE.local.md`. CLAUDE.md/CLAUDE.local.md de todos os
  diretórios **acima** do cwd carregam no launch; os de subdiretórios carregam sob demanda quando o
  Claude lê arquivos lá.
- `@path/to/file` importa e expande no launch; relativo resolve contra o arquivo que importa;
  **profundidade máxima de 4 saltos**; import é ignorado dentro de code span/fence.
  Import externo ao working directory num arquivo de projeto dispara diálogo de aprovação na primeira vez.
- **Claude Code lê `CLAUDE.md`, não `AGENTS.md`** — a ponte recomendada é um `CLAUDE.md` com `@AGENTS.md`.
  No Windows, symlink exige admin/Developer Mode, então usar o import.
- `.claude/rules/*.md` com frontmatter `paths:` (glob) carrega condicionalmente; sem `paths`, carrega
  sempre com a mesma prioridade de `.claude/CLAUDE.md`. `~/.claude/rules/` vale para todos os projetos.
- **Auto memory**: ligada por padrão, escrita pelo próprio Claude em
  `~/.claude/projects/<project>/memory/` (`MEMORY.md` como índice, carregado no início de toda conversa
  nos primeiros 200 linhas / 25 KB). Desligar: `autoMemoryEnabled: false` ou
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Diretório alternativo: `autoMemoryDirectory`.
  Auto memory do pai **não** entra em subagentes.
- `claudeMdExcludes` (globs, arrays mergeiam entre camadas) exclui CLAUDE.md de terceiros — útil quando a
  ADE roda em monorepo alheio. Managed policy CLAUDE.md não pode ser excluído.
- `--setting-sources user,project,local` controla quais fontes de settings carregam;
  `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1` faz `--add-dir` também carregar memória.
- CLAUDE.md > 4 MiB é pulado; alvo recomendado: < 200 linhas.

---

## 6. Multimodal

- **Entrada de imagem em headless: sim, por caminho de arquivo no prompt.** Não existe flag `--image`
  (probe: `unknown option '--image'`). A doc de common-workflows lista três formas: drag-and-drop,
  colar (`Ctrl+V`, ou `Alt+V` no Windows/WSL) e **"Provide an image path to Claude. E.g., 'Analyze this
  image: /path/to/your/image.png'"** — a única que funciona em `-p`. **[V para a ausência de `--image`;
  V para o caminho no prompt; I para "é a única que funciona em -p"** — as outras duas são gestos de UI.]
- A ferramenta `Read` do Claude Code lê imagens (PNG, JPG…) e as apresenta visualmente; `@arquivo.png`
  também inclui o conteúdo. **[V: descrição da ferramenta Read no binário 2.1.271]**
- `--file <file_id:relative_path>` baixa **recursos de arquivo** no startup (ex.:
  `--file file_abc:doc.txt file_def:img.png`). É para file resources do serviço, não para caminhos
  locais arbitrários. **[V]** (`claude --help`)
- CHANGELOG 2.1.269: "Fixed CMYK JPEG images failing to attach with 'cannot decode'" — confirma pipeline
  de anexo de imagem ativo e mantido. **[V]**
- **Geração de imagem: não existe no Claude Code 2.1.271.** Nenhuma flag, nenhum subcomando, nenhuma
  ferramenta nativa de geração de imagem no `--help` nem na lista de ferramentas. A decisão da spec §10
  (usar `$imagegen` do Codex) permanece correta. **[V por ausência em `claude --help` + lista de
  ferramentas do binário; I quanto à exaustividade]**

---

## 7. Telemetria

### JSON de resultado — forma REAL, capturada no smoke test

Comando (único teste de fumaça autorizado, sem ferramentas, sem edição):

```
claude -p "responda apenas OK" --output-format json --model haiku --tools ""
```

Resposta (campos reais, 2026-09-16, em `E:\Documentos\ProjetosIA\TL-ADE`):

```json
{"type":"result","subtype":"success","is_error":false,"result":"OK",
 "session_id":"5997cecd-f48e-4d7f-9347-6c4592885257",
 "uuid":"60cc9320-6ce6-4972-b3ad-08b72e825c5e",
 "total_cost_usd":0.06284,
 "num_turns":1,"stop_reason":"end_turn","terminal_reason":"completed","api_error_status":null,
 "duration_ms":8333,"duration_api_ms":2150,"ttft_ms":3901,"ttft_stream_ms":2754,
 "time_to_request_ms":1840,"first_content_frame_ms":2755,"queued_turn_count":0,"result_index":0,
 "usage":{"input_tokens":10,"output_tokens":108,
   "cache_creation_input_tokens":31145,"cache_read_input_tokens":0,
   "output_tokens_details":{"thinking_tokens":102},
   "server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},
   "service_tier":"standard","speed":"standard","inference_geo":"not_available",
   "cache_creation":{"ephemeral_1h_input_tokens":31145,"ephemeral_5m_input_tokens":0},
   "iterations":[{"type":"message","input_tokens":10,"output_tokens":108,
     "cache_read_input_tokens":0,"cache_creation_input_tokens":31145,
     "cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":31145}}]},
 "modelUsage":{"claude-haiku-4-5-20251001":{
   "inputTokens":10,"outputTokens":108,"cacheReadInputTokens":0,
   "cacheCreationInputTokens":31145,"webSearchRequests":0,
   "costUSD":0.06284,"contextWindow":200000,"maxOutputTokens":32000,
   "thinkingTokens":102,"canonicalModel":"claude-haiku-4-5",
   "provider":"firstParty","costBasis":"list"}},
 "permission_denials":[],
 "fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required",
 "subagent_stats":{"spawned":0,"max_depth":0,"completed":0,"failed":0,
   "requested":{"background":0,"foreground":0,"unset":0},"started_in_background":0,
   "spawned_by_subagents":0,"killed":{"parent":0,"user":0,"system":0},
   "refused":{"depth_limit":0,"concurrency_limit":0,"budget":0},"by_type":{}}}
```

Campos que a ADE deve gravar no journal **[V, medido]**:
`session_id`, `uuid`, `total_cost_usd`, `usage.*`, `modelUsage.<id>.{costUSD,costBasis,canonicalModel,
contextWindow,maxOutputTokens}`, `permission_denials`, `subagent_stats`, `num_turns`, `stop_reason`,
`terminal_reason`, `is_error`, `duration_ms`/`duration_api_ms`. Com `--json-schema`, some
`structured_output`. **[V para os campos medidos; V (docs) para `structured_output`]**

**Três observações medidas, não inferidas:**

1. **`costBasis: "list"`** — o custo é estimativa local a preço de tabela, não fatura. A doc reforça:
   "client-side estimates and can differ from your actual bill". Com `modelPricing` em managed settings,
   passa a usar as tarifas contratadas. **[V]**
2. **Uma chamada trivial custou US$ 0,06284** porque `cache_creation_input_tokens = 31145`: o
   `CLAUDE.md` do usuário, skills e system prompt entraram no contexto mesmo com `--tools ""`. O
   "classificador barato" da spec §7 **não é barato por usar Haiku** — é barato quando também usa
   `--safe-mode` (ou `--bare` + API key) e `--system-prompt` enxuto. Medição própria. **[V]**
3. `contextWindow` reportado para `claude-haiku-4-5` foi **200000**, enquanto docs/model-config diz
   **100K** para Haiku 4.5. Divergência aberta (ver §9). **[V do campo; contradição registrada]**

### OpenTelemetry **[V]** (docs/monitoring-usage)

- Ativação: `CLAUDE_CODE_ENABLE_TELEMETRY=1`.
- Exporters: `OTEL_METRICS_EXPORTER` (`otlp|prometheus|console|none`), `OTEL_LOGS_EXPORTER`,
  `OTEL_TRACES_EXPORTER` (requer `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1`).
- OTLP: `OTEL_EXPORTER_OTLP_PROTOCOL` (`grpc|http/json|http/protobuf`), `OTEL_EXPORTER_OTLP_ENDPOINT`
  (+ overrides `_METRICS_`/`_LOGS_`/`_TRACES_`), `OTEL_EXPORTER_OTLP_HEADERS`.
- Intervalos: `OTEL_METRIC_EXPORT_INTERVAL` (60000 ms), `OTEL_LOGS_EXPORT_INTERVAL` (5000 ms),
  `OTEL_TRACES_EXPORT_INTERVAL` (5000 ms).
- Conteúdo: `OTEL_LOG_USER_PROMPTS`, `OTEL_LOG_ASSISTANT_RESPONSES`, `OTEL_LOG_TOOL_DETAILS`,
  `OTEL_LOG_TOOL_CONTENT`, `OTEL_LOG_RAW_API_BODIES` (`1` ou `file:<dir>`),
  `CLAUDE_CODE_OTEL_CONTENT_MAX_LENGTH` (61440 bytes).
- Cardinalidade: `OTEL_METRICS_INCLUDE_{SESSION_ID,VERSION,ACCOUNT_UUID,ENTRYPOINT,RESOURCE_ATTRIBUTES,REPOSITORY}`.
- **Métricas:** `claude_code.session.count`, `claude_code.lines_of_code.count`,
  `claude_code.pull_request.count`, `claude_code.commit.count`, `claude_code.cost.usage` (USD),
  `claude_code.token.usage` (tokens), `claude_code.code_edit_tool.decision`,
  `claude_code.active_time.total` (s).
  Atributos de custo/token: `model`, `query_source` (`main|subagent|auxiliary`), `speed`, `effort`,
  `agent.name`, `skill.name`, `plugin.name`, `marketplace.name`, `mcp_server.name`, `mcp_tool.name`.
- **Eventos/logs:** `claude_code.user_prompt`, `claude_code.assistant_response`,
  `claude_code.tool_result`, `claude_code.api_request` (com `cost_usd`, `cost_usd_micros`,
  `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `request_id`,
  `client_request_id`, `effort`, `query_source`), `claude_code.api_error`.
- **Consequência para a ADE:** a atribuição por `skill.name` é o dado exato que a poda de harness da
  spec §12 precisa — quanto cada skill custou de fato. **[I]**

### `/cost`, `/usage`, `claude usage` **[V]**

- **Não existe `claude usage`** como subcomando: a lista de `claude --help` traz
  `agents, attach, auth, auto-mode, doctor, gateway, import, install, logs, mcp, plugin, project,
  respawn, rm, setup-token, stop, ultrareview, update`. Nada de `usage`.
- Dentro da sessão: `/usage` (bloco Session com custo, durações, linhas alteradas, uso por modelo, e
  linha `Prompt cache (main)` com requests, % de input vindo do cache, misses e se o cache está warm —
  v2.1.251+), `/context`, `/insights` (relatório HTML em `~/.claude/usage-data/report.html`),
  `/usage-credits`. Status line expõe `prompt_cache`.
- Para a ADE, a fonte canônica é o JSON de resultado (§7) e/ou OTEL — não os comandos interativos. **[I]**

---

## 8. Windows

| Item | Situação | Fonte |
| :--- | :--- | :--- |
| Binário | `claude` resolve para um shim `sh` que executa `bin/claude.exe` (native build, ~230 MB). No PATH deste ambiente: `E:\Apps\npm\claude`. Não assumir `claude.cmd`; **assumir shim/`.exe` e resolver o caminho no `ade doctor`**. | inspeção local **[V]** |
| Sandbox de SO | **Não suportado em Windows nativo.** macOS (Seatbelt), Linux e WSL2 (bubblewrap + socat). | docs/sandboxing **[V]** |
| CLAUDE.md gerenciado | `C:\Program Files\ClaudeCode\CLAUDE.md` | docs/memory **[V]** |
| Symlink para `AGENTS.md` | exige Administrador ou Developer Mode → usar `@AGENTS.md` | docs/memory **[V]** |
| Worktree: remoção | Remover worktree **não** apaga arquivos fora dela; junction NTFS / symlink de diretório dentro da worktree tem só o link apagado. | docs/worktrees **[V]** |
| Worktree: aprovações | "Yes, and don't ask again" normalmente grava em `.claude/settings.local.json` do checkout principal; **no Windows a regra fica com aquela worktree**. | docs/worktrees **[V]** |
| stdin em `-p` | Antes da v2.1.211, stdin ilegível no Windows derrubava a sessão ou saía em silêncio. Corrigido; 2.1.271 está acima disso. | docs/headless **[V]** |
| Hooks | `"shell": "powershell"` disponível além de `bash` | docs/hooks **[V]** |
| Colar imagem | `Alt+V` no Windows e WSL (não `Ctrl+V`) | docs/common-workflows **[V]** |
| ripgrep | Se o ripgrep embutido não rodar, instalar (`winget install BurntSushi.ripgrep.MSVC`) e `USE_BUILTIN_RIPGREP=0` | docs/troubleshooting **[V]** |
| WSL | Busca fica incompleta em `/mnt/c/`; a doc recomenda **Windows nativo** em vez de WSL para performance de filesystem — o que conflita com a necessidade de WSL2 para sandbox. Trade-off real. | docs/troubleshooting **[V]** |
| ConPTY | Nenhuma menção nas docs do Claude Code. ConPTY é requisito do `node-pty` da ADE (Windows ≥ 10 1809), não do Claude Code. | ausência nas docs **[I]** |

**Worktree nativo:** `-w, --worktree [name]` (flag, confirmada por probe local) e o tool `EnterWorktree`
/ `ExitWorktree` na sessão. Cria em `.claude/worktrees/<name>/` na raiz do repo, em branch
`worktree-<name>`, a partir do branch default do remote (`worktree.baseRef: "fresh"` padrão; `"head"`
para partir do HEAD local). Aceita `--worktree "#1234"` ou URL de PR/MR. `.worktreeinclude`
(sintaxe `.gitignore`) copia arquivos gitignorados como `.env`. `--tmux` só com `--worktree`.
Em `-p` **não há limpeza automática** e o lock fica até a varredura de locks obsoletos. **[V]**

**Decisão para a ADE:** manter os worktrees próprios em `<repo>/.ade/wt/` (spec §4) e **não** passar
`--worktree`. Motivos: (a) o Claude Code impõe seu próprio enforcement de isolamento (bloqueia Edit/Write
no checkout principal, bloqueia `git -C`/`--git-dir`/`GIT_DIR` redirecionando para lá, e bloqueia comando
cuja forma ele não consegue analisar — sem desligar); (b) `-p` não limpa; (c) o lock e a varredura por
`cleanupPeriodDays` são um segundo dono do ciclo de vida. Se a ADE quiser o enforcement, a alternativa é
`EnterWorktree` para um caminho dentro de `.claude/worktrees/` — fora dele, o Claude Code **pede
aprovação humana** e só `bypassPermissions` pula. **[I, baseado em docs/worktrees V]**

---

## 9. Contexto

- **Janela por modelo:** ver tabela em §3. Fable 5.1/5 e Opus 5: 200K padrão, 1M com `[1m]`.
  Sonnet 5 na Anthropic API: **1M nativo**, sem sufixo. Haiku 4.5: 100K, sem opção de 1M. **[V]**
- **Divergência aberta:** o smoke test reportou `contextWindow: 200000` para `claude-haiku-4-5-20251001`
  enquanto docs/model-config diz 100K. Duas leituras plausíveis: o campo reporta um valor de plataforma
  e não o efetivo do modelo, ou a tabela da doc está defasada. **Não resolver por inferência** — a ADE
  deve ler `modelUsage.<id>.contextWindow` do JSON de resultado como fonte operacional e tratar a tabela
  como referência. **[V do conflito; H das explicações]**
- **Auto-compact:** `--autocompact <auto|tokens>` (v2.1.221+), `/autocompact 500k`,
  `CLAUDE_CODE_AUTO_COMPACT_WINDOW`, `autoCompactWindow`. Faixa 100K–1M; formatos `200000`, `500k`, `1M`,
  `200` (= 200.000). Padrões: ~967K em modelos com 1M; fronteira de 200K em Opus 4.6 / Sonnet 4.6 sem 1M
  ou com `CLAUDE_CODE_DISABLE_1M_CONTEXT=1`. **[V]**
- **`/compact [instruções]`** substitui histórico por sumário focado. Em sessão nova imprime
  `Not enough messages to compact.` `/clear` custa zero; `/compact` custa uma requisição grande. **[V]**
- **Erro de thrashing:** `Autocompact is thrashing: the context refilled to the limit...` — o compact
  funcionou mas um arquivo/saída reencheu o contexto várias vezes seguidas; o Claude Code para de tentar.
  **É exatamente um caso do detector de loop da spec §6 e deve virar sinal de `park`/`rework`.** **[V do
  erro; I do mapeamento]**
- **Context editing / limpeza de tool results:** o Claude Code limpa tool results antigos do contexto e
  conta isso como "expected rebuild" nas estatísticas de cache. Não há flag de CLI para controlar. **[V]**
- **Prompt caching via CLI:** automático. TTL de 1h em assinatura, 5 min com usage credits / API key /
  cloud provider. Flags que ajudam reuso de cache:
  - `--exclude-dynamic-system-prompt-sections` — move cwd, env info, memory paths e git status do system
    prompt para a primeira mensagem do usuário, melhorando reuso entre usuários. Só com system prompt
    padrão (ignorado com `--system-prompt`). **[V]**
  - `--system-prompt-snapshot on|off` — `on` (padrão) grava o system prompt na primeira requisição da
    conversa e reenvia verbatim em toda requisição e resume, mesmo que um launch posterior passe texto
    diferente, até a conversa ser compactada. **Armadilha para a ADE:** mudar `--append-system-prompt`
    entre chamadas de uma mesma sessão retomada **não tem efeito** com snapshot ligado. **[V]**
  - Subagente: `experimental: { cacheTtl: "1h" }` no frontmatter. **[V]**
- Sobreviventes da compactação: CLAUDE.md da raiz do projeto é relido do disco e reinjetado; CLAUDE.md
  aninhados e rules com `paths:` recarregam quando o Claude lê arquivos correspondentes. Instrução dada
  só na conversa se perde. **[V]**

---

## 10. Achados que não estavam no radar (mas mudam decisão)

| Achado | Impacto na spec v2 |
| :--- | :--- |
| `claude ultrareview [target] --json --timeout <min>` — revisão multi-agente na nuvem do branch atual / PR / base branch | Checker de "outra família" pode ser complementado por um Checker oficial multi-agente da mesma família, com saída JSON. Barato de integrar como portão extra. **[V]** |
| `claude agents --json` lista sessões ativas (interativas e de fundo) sem exigir TTY; `--bg`, `attach`, `logs <id>`, `stop`, `rm`, `respawn --all` | Sobrepõe parte da área "Agentes" do painel (spec §11). Decidir: a ADE gerencia os processos (PTY próprio) **ou** delega ao agent view. Misturar os dois é ter dois donos do ciclo de vida. **[V]** |
| `--init`, `--init-only`, `--maintenance` (hooks `Setup` com matcher) | Preparação de worktree (instalar deps, `graft init`) tem gancho oficial: `WorktreeCreate` + `Setup`. **[V]** |
| `--from-pr <number|url>` | Retomar a sessão ligada a um PR — casa com o ciclo `pull_request → ci → merge`. **[V]** |
| `claude import [source]` | Importa config de outro agente (AGENTS.md, MCP, comandos, subagentes, skills) — v2.1.213+. **[V]** |
| `claude doctor` (sem sessão) lê settings do diretório atual sem prompt de trust | `ade doctor` pode encadear. **[V]** |
| `--betas <betas...>` (só API key) | Irrelevante sob assinatura. **[V]** |
| `system/api_retry` no stream, com `attempt`, `max_retries`, `retry_delay_ms`, `error` categorizado (`rate_limit`, `overloaded`, `billing_error`, `model_not_found`, ...) | O engine distingue falha retentável de falha de plano sem heurística sobre texto de erro. **[V]** |
| `result` com `subtype: "error_during_execution"` e array `errors` para recusa de worktree no resume (v2.1.260+) | Erro estruturado, não só exit code. **[V]** |
| `system/init` com array `capabilities` (ex. `interrupt_receipt_v1`) — v2.1.205+ | **Feature-detection oficial em vez de comparar strings de versão.** O Capability Registry da ADE deve ler isso no `ade doctor`. **[V]** |

---

## 11. Respostas diretas às 9 decisões

1. **Headless.** Prompt posicional/stdin; `--output-format json|stream-json`; `--input-format text|stream-json`;
   **`--json-schema` existe** (→ `structured_output`); `--max-turns` existe; **`--max-budget-usd` existe**;
   `--system-prompt[-file]` e `--append-system-prompt[-file]` existem; **`--bare` existe** mas força
   `ANTHROPIC_API_KEY` — para isolamento com assinatura use `--safe-mode`.
2. **Sessões.** `--resume`, `--continue`, `--session-id <uuid>`, `--fork-session` existem. Resume
   preserva histórico, modelo, agente, goal, worktree; **não** preserva `--mcp-config`/`--settings`/
   `--plugin-dir`/`--add-dir`/`--fallback-model` nem modo de permissão em `-p`. Sessão `-p` **é**
   retomável interativamente, **mas só por session ID** (não aparece no picker nem em `--continue`).
3. **Modelos/esforço.** `--model` com aliases `fable|opus|sonnet|haiku` e sufixo `[1m]`;
   **`--effort` aceita `ultracode`** (não listado no help, aceito no probe) = `xhigh` + orquestração de
   dynamic workflows; `--fallback-model` aceita lista; `CLAUDE_CODE_SUBAGENT_MODEL` (+ `_FORCE=1`)
   documentado; **`--safe-mode` e `--advisor` existem**; Workflow tool, `ultrareview` e agent teams são
   features oficiais.
4. **Permissões/sandbox.** `--permission-mode` ∈ `{default/manual, acceptEdits, auto, dontAsk, plan,
   bypassPermissions}`; `--allowedTools "Bash(git diff *)"` com espaço obrigatório antes do `*`;
   `--dangerously-skip-permissions`; `--permission-prompt-tool` para headless e
   **`--permission-prompts none`** para lote desatendido. **Sandbox de SO não existe em Windows nativo.**
5. **Extensibilidade.** Hooks rodam em `-p`; `PreToolUse` decide por
   `hookSpecificOutput.permissionDecision` ∈ `allow|deny|skip` e pode reescrever com `updatedInput`.
   Skills: `.claude/skills/<n>/SKILL.md`, frontmatter amplo, descoberta por `description`, precedência
   **pessoal > projeto** (inverso da spec). Subagentes por `--agents <json>` com contexto isolado e
   `model`/`effort`/`isolation` por subagente. `--mcp-config` + `--strict-mcp-config`. Memória:
   hierarquia de 4 níveis, `@import` até 4 saltos, auto memory ligada por padrão.
6. **Multimodal.** Imagem de entrada em headless: **caminho de arquivo no prompt** (não há `--image`).
   Geração de imagem: **não existe**.
7. **Telemetria.** JSON com `total_cost_usd`, `usage.*`, `modelUsage.<id>.costUSD` + `costBasis`,
   `session_id`, `permission_denials`, `subagent_stats` (medido). OTEL completo com
   `CLAUDE_CODE_ENABLE_TELEMETRY=1` + `OTEL_*`, incluindo atribuição por `skill.name`.
   **Não existe `claude usage`**; dentro da sessão é `/usage`, `/context`, `/insights`.
8. **Windows.** Shim + `claude.exe` nativo; sem sandbox de SO; worktree nativo funciona com ressalvas de
   junction e de onde a aprovação é gravada; `Alt+V` para colar imagem; `"shell": "powershell"` em hooks.
9. **Contexto.** 1M via `[1m]` (Sonnet 5 nativo); auto-compact configurável 100K–1M; `/compact` com
   instrução; limpeza de tool results automática; prompt caching automático com TTL 1h/5min, mais
   `--exclude-dynamic-system-prompt-sections` e `--system-prompt-snapshot`.

---

## 12. CapabilitySet proposto (JSON)

Formato: cada capacidade é uma chave; o valor é `true`/`false` ou um objeto com o dado operacional.
`src` é a fonte; `conf` é `V` (verificado), `I` (inferido) ou `H` (hipótese).
Destinado a `harness.capabilities.claude` na config da ADE (spec §13).

```json
{
  "family": "claude",
  "binary": "claude",
  "version": "2.1.271",
  "verifiedAt": "2026-09-16",
  "platform": "win32",
  "featureDetection": {
    "preferred": "system/init.capabilities array (stream-json, v2.1.205+)",
    "fallback": "claude --version",
    "src": "docs/headless", "conf": "V"
  },

  "headless": {
    "supported": true,
    "flag": "-p / --print",
    "outputFormats": ["text", "json", "stream-json"],
    "inputFormats": ["text", "stream-json"],
    "structuredOutput": { "supported": true, "flag": "--json-schema <schema>", "resultField": "structured_output", "src": "docs/headless", "conf": "V" },
    "maxTurns": { "supported": true, "flag": "--max-turns <n>", "printOnly": true, "conf": "V" },
    "perCallBudgetUsd": { "supported": true, "flag": "--max-budget-usd <amount>", "printOnly": true, "src": "claude --help", "conf": "V" },
    "systemPrompt": { "replace": "--system-prompt[-file]", "append": "--append-system-prompt[-file]", "subagentAppend": "--append-subagent-system-prompt[-file]", "conf": "V" },
    "stdinMaxBytes": 10485760,
    "sigtermExitCode": 143,
    "backgroundWaitCeilingEnv": "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS",
    "variadicFlagsRequirePromptFirst": { "value": true, "flags": ["--allowedTools", "--disallowedTools", "--tools", "--mcp-config", "--plugin-url", "--channels", "--file"], "src": "claude --help", "conf": "V" }
  },

  "isolationModes": {
    "bare": { "flag": "--bare", "skips": ["hooks", "LSP", "plugin sync", "auto-memory", "CLAUDE.md autodiscovery", "keychain"], "breaksSubscriptionAuth": true, "requires": "ANTHROPIC_API_KEY or apiKeyHelper", "env": "CLAUDE_CODE_SIMPLE=1", "src": "claude --help", "conf": "V" },
    "safeMode": { "flag": "--safe-mode", "disablesAllCustomizations": true, "keepsAuthAndPermissions": true, "env": "CLAUDE_CODE_SAFE_MODE=1", "recommendedForAde": true, "src": "claude --help", "conf": "V (flag) / I (recommendation)" },
    "restricted": { "flag": "--restricted", "removesCodeExecutionTools": true, "refusesBypassPermissions": true, "conf": "V" },
    "settingSources": { "flag": "--setting-sources user,project,local", "conf": "V" },
    "strictMcp": { "flag": "--strict-mcp-config", "conf": "V" },
    "noPersistence": { "flag": "--no-session-persistence", "printOnly": true, "conf": "V" }
  },

  "sessions": {
    "resume": { "flag": "--resume <id|name|jsonl-path>", "crossDirectory": true, "conf": "V" },
    "continue": { "flag": "--continue", "excludesPrintSessions": true, "conf": "V" },
    "callerAssignedId": { "supported": true, "flag": "--session-id <uuid>", "conf": "V" },
    "fork": { "flag": "--fork-session", "conf": "V" },
    "name": { "flag": "-n, --name", "conf": "V" },
    "headlessToInteractiveResume": { "supported": true, "onlyBySessionId": true, "notInPicker": true, "src": "docs/sessions", "conf": "V" },
    "restoredOnResume": ["history", "model", "agent", "goal", "scheduled tasks", "worktree binding"],
    "notRestoredOnResume": ["--mcp-config", "--settings", "--plugin-dir", "--fallback-model", "--add-dir", "background bash/monitor tasks", "permission mode in -p"],
    "transcriptPath": "~/.claude/projects/<project>/<session-id>.jsonl",
    "transcriptParsingSupported": { "value": false, "reason": "formato interno, muda entre versoes", "src": "docs/sessions", "conf": "V" }
  },

  "models": {
    "flag": "--model <alias|id>",
    "aliases": { "fable": "claude-fable-5-1", "opus": "claude-opus-5", "sonnet": "claude-sonnet-5", "haiku": "claude-haiku-4-5" },
    "contextWindows": { "fable": 200000, "opus": 200000, "sonnet": 1000000, "haiku": 100000 },
    "oneMillionSuffix": { "supported": true, "syntax": "<alias>[1m]", "notFor": ["haiku"], "conf": "V" },
    "fallback": { "flag": "--fallback-model <a,b,c>", "retriesPrimaryEachTurn": true, "conf": "V" },
    "envOverrides": ["ANTHROPIC_DEFAULT_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_FABLE_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL", "CLAUDE_CODE_MAX_CONTEXT_TOKENS", "CLAUDE_CODE_DISABLE_1M_CONTEXT"],
    "haikuContextWindowConflict": { "docs": 100000, "resultJson": 200000, "resolution": "ler modelUsage.<id>.contextWindow em runtime", "conf": "V (conflito) / H (causa)" },
    "src": "docs/model-config + smoke test"
  },

  "effort": {
    "flag": "--effort <level>",
    "levelsInHelp": ["low", "medium", "high", "xhigh", "max"],
    "ultracode": { "accepted": true, "listedInHelp": false, "means": "xhigh + orquestracao de dynamic workflows", "unavailableWhen": ["workflows off", "modelo sem xhigh", "teto da org < xhigh"], "src": "probe local + docs/model-config", "conf": "V" },
    "env": "CLAUDE_CODE_EFFORT_LEVEL",
    "settings": ["effortLevel", "modelSettings.<model>.effort", "ultracode"]
  },

  "advisor": { "supported": true, "flag": "--advisor <fable|opus|sonnet|model-id>", "kind": "server-side advisor tool", "contradictsSpec": "spec v2 §12 afirma que nao existe", "src": "probe local + docs/cli-reference", "conf": "V" },

  "orchestration": {
    "workflowTool": { "official": true, "concurrencyEnv": "CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS", "range": [1, 256], "src": "CHANGELOG 2.1.269/2.1.270/2.1.271", "conf": "V" },
    "ultrareview": { "command": "claude ultrareview [target] --json --timeout <min> [--post|--no-post]", "cloudHosted": true, "multiAgent": true, "conf": "V" },
    "agentTeams": { "experimental": true, "env": "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1", "tokenMultiplierApprox": 7, "src": "docs/costs", "conf": "V" },
    "backgroundAgents": { "flags": ["--bg"], "commands": ["claude agents --json", "attach", "logs", "stop", "rm", "respawn"], "conf": "V" }
  },

  "permissions": {
    "modes": ["default", "manual", "acceptEdits", "auto", "dontAsk", "plan", "bypassPermissions"],
    "flag": "--permission-mode <mode>",
    "printDefaultMode": "manual",
    "allowedTools": { "flag": "--allowedTools", "syntax": "Bash(git diff *)", "spaceBeforeStarRequired": true, "conf": "V" },
    "disallowedTools": { "flag": "--disallowedTools", "bareNameRemovesTool": true, "conf": "V" },
    "toolRoster": { "flag": "--tools <names|\"\"|default>", "conf": "V" },
    "bypass": { "flag": "--dangerously-skip-permissions", "conf": "V" },
    "promptToolForHeadless": { "flag": "--permission-prompt-tool <mcp-tool>", "conf": "V" },
    "unattended": { "flag": "--permission-prompts none", "sinceVersion": "2.1.259", "deniesEverythingThatWouldPrompt": true, "recommendedForAdeBatch": true, "conf": "V" },
    "deniedListedIn": "result.permission_denials"
  },

  "osSandbox": {
    "supportedOnWindowsNative": false,
    "supportedPlatforms": ["macos", "linux", "wsl2"],
    "enableVia": "--settings '{\"sandbox\":{\"enabled\":true}}' | sandbox.enabled | /sandbox",
    "noCliFlag": true,
    "failsOpenByDefault": true,
    "hardFailSetting": "sandbox.failIfUnavailable",
    "src": "docs/sandboxing", "conf": "V",
    "adeImpact": "contain da ADE nao pode delegar ao sandbox no Windows"
  },

  "hooks": {
    "runInHeadless": true,
    "events": ["SessionStart", "Setup", "SessionEnd", "UserPromptSubmit", "UserPromptExpansion", "Stop", "StopFailure", "PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "FileChanged", "CwdChanged", "DirectoryAdded", "ConfigChange", "InstructionsLoaded", "PreCompact", "PostCompact", "PreModelSwitch", "PostModelSwitch", "WorktreeCreate", "WorktreeRemove", "MessageDisplay", "Notification", "TeammateIdle", "SubagentStart", "SubagentStop", "TaskCreated", "TaskCompleted", "Elicitation", "ElicitationResult"],
    "preToolUseDecision": { "field": "hookSpecificOutput.permissionDecision", "values": ["allow", "deny", "skip"], "canRewriteInput": "updatedInput", "exit2Blocks": true, "conf": "V" },
    "types": ["command", "http", "mcp_tool", "prompt", "agent"],
    "windowsShell": "powershell",
    "streamEvents": { "flag": "--include-hook-events", "requires": "--output-format stream-json", "conf": "V" },
    "outputFilteringPattern": { "supported": true, "how": "PreToolUse + updatedInput", "src": "docs/costs", "conf": "V" },
    "disableAll": "disableAllHooks"
  },

  "skills": {
    "locations": ["~/.claude/skills/<n>/SKILL.md", ".claude/skills/<n>/SKILL.md", "<subdir>/.claude/skills/", "<plugin>/skills/<n>/SKILL.md", "managed settings .claude/skills/"],
    "frontmatter": ["name", "description", "when_to_use", "argument-hint", "arguments", "disable-model-invocation", "user-invocable", "allowed-tools", "disallowed-tools", "model", "effort", "context", "agent", "background", "paths", "shell", "hooks", "metadata", "license", "compatibility"],
    "autoDiscoveryByDescription": true,
    "progressiveDisclosure": { "descriptionsAlwaysInContext": true, "bodyOnInvoke": true, "conf": "V" },
    "precedence": ["enterprise", "personal (~/.claude)", "project (.claude)", "bundled", "synced"],
    "precedenceContradictsSpec": { "value": true, "note": "spec v2 §9 assume projeto > usuario; o Claude Code faz pessoal > projeto", "conf": "V" },
    "worksInHeadless": true,
    "invokeInPrompt": "/skill-name dentro da string do prompt",
    "dynamicContextInjection": "!`comando` (desabilitado para skills sincronizadas em headless)",
    "disableAll": "--disable-slash-commands",
    "disableBundled": "disableBundledSkills"
  },

  "subagents": {
    "cliFlag": "--agents '<json>'",
    "jsonFields": ["description", "prompt", "tools", "disallowedTools", "model", "permissionMode", "mcpServers", "hooks", "maxTurns", "skills", "initialPrompt", "memory", "effort", "background", "omitClaudeMd", "isolation"],
    "contextIsolation": { "freshContext": true, "inherits": ["system prompt", "delegation message", "CLAUDE.md", "git status", "preloaded skills"], "doesNotInherit": ["conversation history", "output style", "auto memory", "parent context window size"], "conf": "V" },
    "modelPerSubagent": true,
    "modelEnv": { "default": "CLAUDE_CODE_SUBAGENT_MODEL", "force": "CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1", "sinceVersion": "2.1.257", "conf": "V" },
    "worktreeIsolation": "isolation: worktree",
    "builtInTypes": ["Explore", "Plan", "General-purpose", "claude"],
    "streamForwarding": { "flag": "--forward-subagent-text", "env": "CLAUDE_CODE_FORWARD_SUBAGENT_TEXT", "parentToolUseIdField": "parent_tool_use_id", "conf": "V" },
    "statsInResult": "subagent_stats"
  },

  "plugins": {
    "sessionOnlyLoad": ["--plugin-dir <path|zip|folder>", "--plugin-url <url>"],
    "commands": ["details", "disable", "enable", "eval", "init", "install", "list"],
    "abTesting": { "supported": true, "command": "claude plugin eval [target]", "producesBaselineArm": true, "note": "substitui o A/B estilo Caliper da spec v2 §12", "conf": "V" },
    "tokenCostReport": "claude plugin details <name>",
    "loadErrorsInInit": ["plugins", "plugin_errors"]
  },

  "mcp": {
    "configFlag": "--mcp-config <files|json...>",
    "strictFlag": "--strict-mcp-config",
    "startupTimeoutEnv": "MCP_TIMEOUT",
    "startupTimeoutDefaultMs": 30000,
    "initFields": ["mcp_servers", "mcp_server_errors"],
    "toolDefinitionsDeferredByDefault": true
  },

  "memory": {
    "hierarchy": ["managed policy CLAUDE.md", "~/.claude/CLAUDE.md", "./CLAUDE.md | ./.claude/CLAUDE.md", "./CLAUDE.local.md"],
    "windowsManagedPath": "C:\\Program Files\\ClaudeCode\\CLAUDE.md",
    "imports": { "syntax": "@path", "maxDepth": 4, "skipsCodeBlocks": true, "externalImportPrompt": true, "conf": "V" },
    "readsAgentsMd": false,
    "agentsMdBridge": "@AGENTS.md dentro de CLAUDE.md",
    "rulesDir": ".claude/rules/*.md com frontmatter paths (glob)",
    "autoMemory": { "onByDefault": true, "path": "~/.claude/projects/<project>/memory/", "indexLoadLimit": "200 linhas ou 25KB", "disable": ["autoMemoryEnabled: false", "CLAUDE_CODE_DISABLE_AUTO_MEMORY=1"], "notInheritedBySubagents": true, "conf": "V" },
    "excludes": "claudeMdExcludes (globs, merge entre camadas)",
    "maxFileSizeBytes": 4194304
  },

  "multimodal": {
    "imageInputHeadless": { "supported": true, "how": "caminho do arquivo no texto do prompt ou @arquivo.png", "dedicatedFlag": null, "imageFlagExists": false, "src": "probe (--image unknown) + docs/common-workflows", "conf": "V" },
    "fileResourceFlag": "--file <file_id:relative_path>",
    "pasteShortcutWindows": "Alt+V",
    "imageGeneration": { "supported": false, "src": "ausencia em claude --help e no roster de ferramentas", "conf": "V (ausencia) / I (exaustividade)" }
  },

  "telemetry": {
    "resultJsonFields": ["type", "subtype", "is_error", "result", "structured_output", "session_id", "uuid", "total_cost_usd", "num_turns", "stop_reason", "terminal_reason", "api_error_status", "duration_ms", "duration_api_ms", "ttft_ms", "usage", "modelUsage", "permission_denials", "subagent_stats", "fast_mode_state"],
    "usageSubfields": ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens_details.thinking_tokens", "server_tool_use", "service_tier", "cache_creation.ephemeral_1h_input_tokens", "cache_creation.ephemeral_5m_input_tokens", "iterations"],
    "modelUsageSubfields": ["inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "costUSD", "contextWindow", "maxOutputTokens", "thinkingTokens", "canonicalModel", "provider", "costBasis"],
    "costIsEstimate": { "value": true, "basis": "list", "overrideSetting": "modelPricing (managed settings only)", "conf": "V" },
    "measuredTrivialCallUsd": { "value": 0.06284, "model": "claude-haiku-4-5", "cacheCreationTokens": 31145, "note": "com --tools \"\" mas sem --safe-mode; o CLAUDE.md do usuario entrou no contexto", "conf": "V" },
    "otel": {
      "enable": "CLAUDE_CODE_ENABLE_TELEMETRY=1",
      "exporters": ["OTEL_METRICS_EXPORTER", "OTEL_LOGS_EXPORTER", "OTEL_TRACES_EXPORTER"],
      "tracesBeta": "CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1",
      "metrics": ["claude_code.session.count", "claude_code.lines_of_code.count", "claude_code.pull_request.count", "claude_code.commit.count", "claude_code.cost.usage", "claude_code.token.usage", "claude_code.code_edit_tool.decision", "claude_code.active_time.total"],
      "events": ["claude_code.user_prompt", "claude_code.assistant_response", "claude_code.tool_result", "claude_code.api_request", "claude_code.api_error"],
      "attributionAttributes": ["model", "query_source", "speed", "effort", "agent.name", "skill.name", "plugin.name", "marketplace.name", "mcp_server.name", "mcp_tool.name"],
      "conf": "V"
    },
    "usageSubcommandExists": false,
    "inSessionCommands": ["/usage", "/context", "/insights", "/usage-credits"]
  },

  "windows": {
    "binaryResolution": { "path": "E:\\Apps\\npm\\claude (sh shim) -> node_modules/@anthropic-ai/claude-code/bin/claude.exe", "doNotAssumeClaudeCmd": true, "resolveInDoctor": true, "conf": "V" },
    "osSandboxAvailable": false,
    "conPtyRequiredBy": "node-pty da ADE, nao pelo Claude Code",
    "symlinkNeedsAdmin": true,
    "worktreeJunctionCaveat": "remover worktree apaga so o link, nao o alvo",
    "worktreeApprovalStaysLocal": true,
    "ripgrepFallback": "USE_BUILTIN_RIPGREP=0",
    "wslTradeoff": "sandbox exige WSL2; a doc recomenda Windows nativo por performance de busca"
  },

  "worktree": {
    "nativeFlag": "-w, --worktree [name|#PR|PR-url]",
    "tools": ["EnterWorktree", "ExitWorktree"],
    "defaultPath": ".claude/worktrees/<name>",
    "defaultBranch": "worktree-<name>",
    "baseRefSetting": { "key": "worktree.baseRef", "values": ["fresh", "head"], "default": "fresh" },
    "gitignoredFileCopy": ".worktreeinclude",
    "isolationEnforcement": { "blocksEditsInMainCheckout": true, "blocksGitRedirects": true, "blocksUnparseableCommands": true, "cannotBeDisabled": true, "conf": "V" },
    "noAutoCleanupInPrintMode": true,
    "adeDecision": { "useNativeWorktree": false, "reason": "ADE mantem <repo>/.ade/wt/ proprio; evitar dois donos do ciclo de vida e do lock", "conf": "I" }
  },

  "context": {
    "autoCompact": { "flag": "--autocompact <auto|tokens>", "env": "CLAUDE_CODE_AUTO_COMPACT_WINDOW", "setting": "autoCompactWindow", "range": [100000, 1000000], "conf": "V" },
    "compactCommand": "/compact [instrucoes]",
    "thrashingError": { "text": "Autocompact is thrashing: the context refilled to the limit", "adeMapping": "sinal de loop -> park/rework", "conf": "V (erro) / I (mapeamento)" },
    "toolResultClearing": { "automatic": true, "noCliControl": true, "conf": "V" },
    "promptCaching": { "automatic": true, "ttlSubscription": "1h", "ttlApiKeyOrCredits": "5m", "cacheFriendlyFlags": ["--exclude-dynamic-system-prompt-sections", "--system-prompt-snapshot on|off"], "subagentTtl": "experimental.cacheTtl", "conf": "V" },
    "systemPromptSnapshotGotcha": { "value": true, "note": "com snapshot on (padrao), mudar --append-system-prompt numa sessao retomada nao tem efeito ate a compactacao", "conf": "V" },
    "survivesCompaction": ["CLAUDE.md da raiz (relido do disco)", "skills: 5k tokens cada, 25k combinados"]
  },

  "errorSignals": {
    "apiRetryEvent": { "type": "system", "subtype": "api_retry", "fields": ["attempt", "max_retries", "retry_delay_ms", "error_status", "no_response", "error"], "errorCategories": ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "billing_error", "rate_limit", "overloaded", "invalid_request", "model_not_found", "server_error", "max_output_tokens", "cloud_credential_error", "unknown"], "conf": "V" },
    "resultErrorSubtype": "error_during_execution (com array errors)",
    "exitCodes": { "success": 0, "sigterm": 143, "failedResume": 1 }
  }
}
```

---

## 13. Fontes

Primárias locais (máquina, 2026-09-16):

- `claude --version` → `2.1.271 (Claude Code)`
- `claude --help`; `claude agents --help`; `claude mcp --help`; `claude plugin --help`;
  `claude ultrareview --help`; `claude project --help`
- Probes de existência/valor de flag: `claude -p <flag>` (sem valor) e `claude -p --effort <valor>`
- Smoke test: `claude -p "responda apenas OK" --output-format json --model haiku --tools ""`
- `cat /e/Apps/npm/claude` (shim) e `ls -la .../@anthropic-ai/claude-code/bin/claude.exe`

Documentação oficial (code.claude.com, acessada 2026-09-16):

- https://code.claude.com/docs/en/cli-reference
- https://code.claude.com/docs/en/headless
- https://code.claude.com/docs/en/sessions
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/hooks
- https://code.claude.com/docs/en/skills
- https://code.claude.com/docs/en/sub-agents
- https://code.claude.com/docs/en/sandboxing
- https://code.claude.com/docs/en/memory
- https://code.claude.com/docs/en/monitoring-usage
- https://code.claude.com/docs/en/costs
- https://code.claude.com/docs/en/worktrees
- https://code.claude.com/docs/en/troubleshooting
- https://code.claude.com/docs/en/common-workflows
- Índice completo: https://code.claude.com/docs/llms.txt

Repositório oficial:

- https://github.com/anthropics/claude-code — `CHANGELOG.md` via
  `gh api repos/anthropics/claude-code/contents/CHANGELOG.md` (topo 2.1.273; entradas 2.1.269–2.1.273
  consultadas)

Agent SDK (o `-p` é a face CLI dele):

- https://code.claude.com/docs/en/agent-sdk/overview
- https://code.claude.com/docs/en/agent-sdk/typescript (`SDKSystemMessage`, `SDKHookStartedMessage`)
- https://code.claude.com/docs/en/agent-sdk/cost-tracking

---

## 14. Questões abertas

1. `contextWindow` de `claude-haiku-4-5` no JSON de resultado (200000) contradiz docs/model-config
   (100K). Resolver medindo, não inferindo.
2. `--effort ultracode` é aceito mas não listado na mensagem de valores válidos do binário instalado —
   verificar se `ultracode` está sujeito ao teto de esforço quando a conta não tem workflows habilitados
   (a doc diz que fica indisponível; o probe não conseguiu observar o comportamento sem gastar chamada).
3. Custo real de uma chamada de classificação com `--safe-mode` + `--system-prompt` enxuto não foi
   medido (só o caso sem isolamento, US$ 0,06284). Medir antes de fixar o orçamento do classificador da
   spec §7.
4. `--permission-prompts none` combinado com hooks `PermissionRequest` que permitem: a doc diz que o
   hook ainda pode aprovar. Não testado.
5. Se o `system/init.capabilities` array já traz nomes úteis para a ADE (além de `interrupt_receipt_v1`)
   — só observável rodando `stream-json`, que o escopo deste passe não autorizou.
6. Interação entre o enforcement de worktree do Claude Code e os worktrees próprios da ADE em
   `<repo>/.ade/wt/`: se a ADE apenas roda `claude` com `cwd` dentro do seu worktree (sem `--worktree` e
   sem `EnterWorktree`), o enforcement não é ativado — a contenção fica 100% com o engine. Confirmar por
   teste antes de fixar.
