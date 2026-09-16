# Capacidades reais do Codex CLI 0.154.0 — Capability Registry da ADE

Data da pesquisa: 2026-09-16. Binário inspecionado: `codex-cli 0.154.0`, standalone Windows
(`C:\Users\Erick\AppData\Local\Programs\OpenAI\Codex\bin\codex` → pacote
`C:\Users\Erick\.codex\packages\standalone\releases\0.154.0-x86_64-pc-windows-msvc`).
Fontes primárias: `--help` do binário instalado, catálogo de modelos embutido (`codex debug models --bundled`),
docs oficiais (os antigos `developers.openai.com/codex/*` hoje redirecionam 308 para `learn.chatgpt.com/docs/*`;
cada página tem gêmea Markdown em `<url>.md`), repositório `openai/codex` (os `docs/*.md` do repo viraram stubs
que apontam para o site) e um smoke test único de `codex exec --json`.

Classificação: **[V]** verificado em fonte primária (com a fonte), **[I]** inferido, **[H]** hipótese.

---

## 0. Resumo executivo — o que muda na spec v2

| # | Achado | Impacto na ADE |
| :-- | :--- | :--- |
| 1 | `--full-auto` **não existe** em 0.154.0 (`error: unexpected argument '--full-auto' found`), apesar de a doc dizer que é "deprecated compatibility flag" [V] | Adapter usa `--sandbox workspace-write`; nunca `--full-auto` |
| 2 | `codex review` (top-level) **não tem** `--json`, `-o`, `--output-schema`, `-m`; `codex exec review` tem tudo isso [V] | O papel de Checker roteia por `codex exec review --json --base <branch>` |
| 3 | `codex exec` **não aceita** `-a/--ask-for-approval` (só o interativo aceita); em exec existe `--approve-for-me` [V] | Headless é sempre "sem aprovação humana"; o portão é o sandbox, não o approval |
| 4 | Modelos atuais: `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.2`. Não existe modelo chamado `codex`. Janela de contexto **272 000 tokens** em todos [V] | Matriz de capacidades da seção 13 da spec precisa dos slugs reais; "contexto 1M" não é do Codex |
| 5 | `model_reasoning_effort` aceita `max` e `ultra` nos modelos 5.6/6 pelo catálogo embutido, embora a Configuration Reference liste só `minimal..xhigh` [V, conflito] | Roteamento de esforço pode usar `low`/`medium`/`high`/`xhigh`; `max`/`ultra` só com fallback |
| 6 | Skills ficam em `.agents/skills` (repo e `$HOME`), **não** em `.codex/skills`; e `skills.config[].path` em `config.toml` aponta uma pasta de skill arbitrária [V] | O catálogo da seção 9 pode ser exposto ao Codex por caminho, sem copiar arquivos |
| 7 | Sandbox nativo no Windows existe em dois modos (`elevated` / `unelevated`), sem WSL [V] | "nativo no Windows" da spec confirmado e agora com chave de config exata |
| 8 | Subagentes/multi-agent são estáveis e ligados por padrão; agentes customizados em `.codex/agents/*.toml` [V] | A spec diz "sem advisor nativo das CLIs" — falso para Codex; dá para paralelizar revisão dentro da família |
| 9 | Nenhum evento JSONL reporta custo em USD; só tokens [V] | `costOf()` devolve `{ usd: "unknown", tokens }`, como a spec já previa |
| 10 | Não há flag de limite de turnos/custo por execução; o único orçamento é `features.rollout_budget.*`, **under development** [V] | O teto de custo continua sendo do engine da ADE, não do Codex |

---

## 1. Modo não interativo (`codex exec`)

### 1.1 Flags reais (saída de `codex exec --help`, 0.154.0) [V]

| Flag | Observação |
| :--- | :--- |
| `[PROMPT]` | Se ausente ou `-`, lê de stdin. Se stdin vem por pipe **e** há prompt, o stdin é anexado como bloco `<stdin>` |
| `--json` | stdout vira JSONL de eventos (seção 1.3). Alias documentado: `--experimental-json` |
| `-o, --output-last-message <FILE>` | Grava a última mensagem do agente em arquivo (e ainda imprime em stdout) |
| `--output-schema <FILE>` | JSON Schema da resposta final → structured output |
| `-s, --sandbox <MODE>` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `--dangerously-bypass-approvals-and-sandbox` | Alias `--yolo` aceito pelo parser (confirmado: `codex --yolo --help` sai 0) |
| `--approve-for-me` | Roteia pedidos de aprovação por revisão automática usando o sandbox workspace-write |
| `-C, --cd <DIR>` | Raiz de trabalho |
| `--add-dir <DIR>` | Diretórios extras graváveis |
| `--worktree` | Roda a sessão em worktree Git gerenciado (feature `worktrees` = experimental, off) |
| `--skip-git-repo-check` | Permite rodar fora de repositório Git |
| `--ephemeral` | Não persiste arquivos de sessão em disco |
| `--ignore-user-config` | Não carrega `$CODEX_HOME/config.toml` (auth continua usando `CODEX_HOME`) |
| `--ignore-rules` | Não carrega `.rules` de execpolicy de usuário/projeto |
| `-m, --model`, `-p, --profile`, `-c/--config key=value`, `--enable/--disable <FEATURE>`, `--strict-config` | Idem interativo |
| `-i, --image <FILE>...` | Anexa imagens ao prompt inicial |
| `--color always\|never\|auto`, `--thread-source <SOURCE>` | Cor e classificação de origem da thread |
| `--oss`, `--local-provider lmstudio\|ollama` | Provedor local |

**Não existem em `codex exec` 0.154.0** [V]: `--full-auto` (removido; o parser recusa), `-a/--ask-for-approval`,
`--no-alt-screen`, `--remote`, `--search`. `--search` e `-a` só no comando interativo.

> Conflito com a doc: `https://learn.chatgpt.com/docs/non-interactive-mode.md` (2026-09) afirma
> "Codex keeps `codex exec --full-auto` as a deprecated compatibility flag and prints a warning".
> O binário 0.154.0 recusa a flag. Fonte primária (binário) vence. [V]

### 1.2 Prompt longo e stdin [V]

`https://learn.chatgpt.com/docs/non-interactive-mode.md`:

- `cat prompt.txt | codex exec -` — stdin **é** o prompt.
- `npm test 2>&1 | codex exec "resuma as falhas"` — prompt é a instrução, stdin entra como contexto.
- `generate_prompt.sh | codex exec - --json > result.jsonl` — combina as duas coisas.

Para a ADE: prompt consolidado por chamada vai por stdin com `codex exec -`, evitando limite de linha de
comando do Windows (32 767 caracteres) [I].

### 1.3 Forma real dos eventos JSONL (smoke test)

Comando executado uma vez, sem escrita:
`codex exec --json --sandbox read-only --skip-git-repo-check -C . "responda apenas OK"` [V]

```jsonl
{"type":"thread.started","thread_id":"01a0a8dc-e93c-7031-b148-1f27523b2477"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"OK"}}
{"type":"turn.completed","usage":{"input_tokens":19449,"cached_input_tokens":6912,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
```

Observações:

- **Sem custo em USD**, sem slug de modelo nos eventos. Só contagem de tokens. [V]
- `cache_write_input_tokens` aparece no binário e **não** no exemplo da doc — o schema tem campos a mais
  que a doc; o parser da ADE precisa ser tolerante a campos novos. [V]
- Overhead fixo de ~19,4k tokens de entrada num prompt trivial (instruções do sistema + AGENTS.md do
  usuário + catálogo de skills). Isso é o piso de custo por chamada headless. [V]
- Tipos de evento documentados: `thread.started`, `turn.started`, `turn.completed`, `turn.failed`,
  `item.started`, `item.completed`, `item.*`, `error`. Tipos de item: agent message, reasoning,
  command execution, file change, MCP tool call, web search, plan update. [V — doc non-interactive-mode]
- Progresso vai para **stderr**; stdout sem `--json` traz só a mensagem final. [V]

### 1.4 Limitar turnos/custo [V]

Não existe flag. O único mecanismo nativo é `features.rollout_budget.*` em `config.toml`
(`enabled`, `limit_tokens` obrigatório, `reminder_interval_tokens`, `sampling_token_weight`,
`prefill_token_weight`), e `codex features list` mostra `rollout_budget` como `under development / false`.
Correlatos úteis: `tool_output_token_limit` (orçamento de tokens por saída de ferramenta no histórico),
`model_auto_compact_token_limit`, `skills.max_context_tokens`.

→ **Decisão**: o teto por story/lote continua sendo do engine da ADE (matar o processo), como no
tl-orchestrator. Opcionalmente ligar `-c features.rollout_budget.enabled=true -c features.rollout_budget.limit_tokens=N`
como cinto de segurança secundário, ciente de que é feature instável. [I]

---

## 2. Sessões, resume e "assumir o terminal"

| Capacidade | Comando exato | Fonte |
| :--- | :--- | :--- |
| Retomar headless | `codex exec resume <SESSION_ID> [PROMPT]` ou `codex exec resume --last` | [V] `codex exec resume --help` |
| Bifurcar headless | `codex exec fork <SESSION_ID>` | [V] `codex exec --help` |
| Retomar interativo | `codex resume <SESSION_ID> [PROMPT]`, `--last`, `--all` | [V] `codex resume --help` |
| **Headless → interativo** | `codex resume <SESSION_ID> --include-non-interactive` | [V] `codex resume --help`: "Include non-interactive sessions in the resume picker and --last selection" |
| Enfileirar mensagem numa sessão viva | `codex queue --thread <UUID\|nome> --message <TEXT>` | [V] `codex queue --help` |
| Bifurcar interativo | `codex fork [SESSION_ID] [--last] [--all]` | [V] `codex --help` |
| Arquivar/apagar | `codex archive`, `codex unarchive`, `codex delete [--force]` | [V] `codex --help` |

**Identidade da sessão.** O `thread_id` do evento `thread.started` é o id da sessão e nomeia o rollout em
disco: o smoke test gerou `thread_id=01a0a8dc-e93c-7031-b148-1f27523b2477` e o arquivo
`~/.codex/sessions/2026/09/16/rollout-2026-09-16T03-17-25-01a0a8dc-e93c-7031-b148-1f27523b2477.jsonl`. [V]
Há também `~/.codex/session_index.jsonl` (`{id, thread_name, updated_at}`) e bancos
`thread_history_1.sqlite` / `state_5.sqlite`. [V]

**Fidelidade do takeover.** Uma sessão criada por `codex exec` é retomável na TUI pelo mesmo UUID, desde
que **não** tenha usado `--ephemeral`. [V para a persistência e para a flag; I para a fidelidade integral do
transcript, não testada]. Regra para o adapter: nunca usar `--ephemeral` em story que possa virar takeover;
`--ephemeral` só em chamadas descartáveis (classificação, avaliação visual). [I]

**Queue como alternativa ao takeover.** `codex queue` injeta mensagem numa sessão existente sem PTY — pode
substituir o takeover em casos simples ("mande o agente refazer com esta instrução") sem trocar de processo. [I]

---

## 3. Modelos, esforço e custo

### 3.1 Catálogo embutido (`codex debug models --bundled`, 0.154.0) [V]

| Slug | Nome | Effort padrão | Efforts suportados | Visível |
| :--- | :--- | :--- | :--- | :--- |
| `gpt-6-astra` | GPT-6-Astra | low | low, medium, high, xhigh, max, ultra | sim |
| `gpt-5.6-sol` | GPT-5.6-Sol | low | low..ultra | sim |
| `gpt-5.6-terra` | GPT-5.6-Terra | medium | low..ultra | sim |
| `gpt-5.6-luna` | GPT-5.6-Luna | medium | low, medium, high, xhigh, max | sim |
| `gpt-5.5` | GPT-5.5 | medium | low, medium, high, xhigh | sim |
| `gpt-5.2` | GPT-5.2 | medium | low..xhigh | sim |
| `gpt-5.4`, `gpt-5.4-mini` | — | medium | low..xhigh | ocultos |
| `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest` | modelos cyber | low/medium | low..ultra | ocultos |
| `codex-auto-review` | Codex Auto Review | medium | low..max | oculto (uso interno da revisão automática) |

Janela de contexto: **272 000 tokens para todos** os slugs (`~/.codex/models_cache.json`, campo
`context_window`). [V] Todos usam `shell_type: "unified_exec"`. [V]

Guia oficial de escolha (`agent-configuration/subagents.md`): `gpt-5.6` para trabalho exigente,
`gpt-5.6-terra` para leitura/varredura rápida e barata, `gpt-5.6-luna` para trabalho repetitivo de alto
volume. [V] (Note que a doc fala em `gpt-5.6` genérico; o catálogo do binário só traz as variantes
sol/terra/luna — o alias `gpt-5.6` provavelmente resolve no servidor. [H])

### 3.2 Esforço [V, com conflito]

- Catálogo do binário: `low | medium | high | xhigh | max | ultra` (depende do modelo).
- Configuration Reference: `model_reasoning_effort` = `minimal | low | medium | high | xhigh`
  ("Responses API only; `xhigh` is model-dependent").
- Doc de subagentes cita `ultra`, `max`, `xhigh`, `high`, `medium`, `low`.

→ Adapter deve tratar effort como string opaca passada por `-c model_reasoning_effort="<v>"`, validar contra
o catálogo do binário (`codex debug models --bundled`) e degradar para `high` se o valor for recusado. [I]

### 3.3 Overrides e perfis [V]

- `-c chave=valor` com caminho pontilhado; valor parseado como TOML, com fallback para string literal.
  Ex.: `-c model_reasoning_effort="xhigh"`, `-c sandbox_workspace_write.network_access=true`.
- `-p, --profile <nome>` carrega `$CODEX_HOME/<nome>.config.toml` **em camada** sobre a config base.
- `--enable <FEATURE>` / `--disable <FEATURE>` = `-c features.<name>=true|false`.
- `--strict-config` faz erro em campo desconhecido — útil no `ade doctor` para detectar config podre.

### 3.4 Custo [V]

Nada de USD em lugar nenhum da saída headless. `codex usage` não existe (cai no CLI interativo).
Os únicos números são os cinco campos de `usage` no `turn.completed`. Preço por token de assinatura
ChatGPT não é exposto. → `CostReport.usd = "unknown"`, aviso, nunca bloqueio (regra já prevista na spec).

---

## 4. Sandbox e permissões

### 4.1 Modos [V]

`-s, --sandbox`: `read-only` | `workspace-write` | `danger-full-access`.
Padrão de `codex exec` é `read-only` (doc non-interactive-mode).
`-a, --ask-for-approval`: `on-request` | `never` — **só no comando interativo**; `untrusted` foi aposentado.
`approvals_reviewer`: `user` (padrão) | `auto_review` (agente revisor decide aprovações elegíveis).

Chaves de config equivalentes: `sandbox_mode`, `approval_policy`, `approvals_reviewer`,
`sandbox_workspace_write.writable_roots`, `.network_access` (bool), `.exclude_tmpdir_env_var`,
`.exclude_slash_tmp`. [V — Configuration Reference]

**Rede**: por padrão desligada dentro do sandbox; liga-se com `sandbox_workspace_write.network_access = true`.
`danger-full-access` remove fronteiras de FS **e** de rede. [V] O proxy de rede não filtra web search,
chamadas de app/connector, MCP, browser/Computer Use nem as requisições do próprio cliente. [V — agent-approvals-security]

### 4.2 Windows: sandbox nativo, sem WSL [V]

`learn.chatgpt.com/docs/windows/windows-sandbox.md`:

```toml
[windows]
sandbox = "elevated"   # ou "unelevated"
sandbox_private_desktop = true   # padrão; false volta ao Winsta0\Default
```

- `elevated` (preferido): usuários de sandbox dedicados de baixo privilégio, fronteiras de permissão de FS,
  regras de firewall e alterações de política local. Exige setup aprovado por administrador (UAC).
- `unelevated` (fallback): **restricted token** derivado do usuário atual, fronteiras por ACL, controles de
  offline por ambiente em vez da regra de firewall do usuário offline. Mais fraco, mas funciona sob política
  corporativa restritiva.
- Admin pode fixar em `requirements.toml`: `[windows] allowed_sandbox_implementations = ["elevated"]`.
- Em WSL2 o Codex usa a implementação Linux (bubblewrap/`bwrap`); nativo em PowerShell usa o sandbox Windows.
- Matriz: Windows 11 recomendado; Windows 10 ≥ 1809 "best effort" por causa do ConPTY.
- Log de diagnóstico: `CODEX_HOME/.sandbox/sandbox.log`. Nunca enviar `CODEX_HOME/.sandbox-secrets/`.
- Comando de sessão para liberar leitura: `/sandbox-add-read-dir C:\caminho\absoluto`.

Estado desta máquina [V]: `config.toml` tem `[windows] sandbox = "elevated"`; `codex doctor --summary`
reporta `sandbox restricted fs + restricted network · approval OnRequest`; existem
`~/.codex/.sandbox/` (logs diários) e `~/.codex/.sandbox-bin/codex-command-runner-*.exe`.
Flags de feature `experimental_windows_sandbox` e `elevated_windows_sandbox` estão **removed** (viraram
comportamento padrão); `windows_sandbox_service` está `under development`.

### 4.3 `codex sandbox` como primitiva reutilizável [V]

`codex sandbox [-P <perfil>] [-C <dir>] [--sandbox-state-json <JSON>] [--sandbox-state-readable-root <DIR>]
[--sandbox-state-disable-network] -- <COMANDO...>` roda **qualquer** comando dentro do sandbox do Codex
("Full command args to run under Windows restricted token sandbox" no help do Windows).

→ Oportunidade para a ADE: o step `contain` e os portões (`gates`) podem rodar **dentro** do sandbox do Codex
em vez de depender só de checagem de caminho no engine, sem inventar sandbox próprio. Custo: acopla a ADE ao
Codex instalado. [I]

Correlato: `codex execpolicy -r <arquivo.rules> -- <comando>` avalia se um comando seria allow/prompt/deny
sem executá-lo — material pronto para o portão de comandos. [V — doc developer-commands]

---

## 5. Extensibilidade

### 5.1 AGENTS.md — hierarquia exata [V — `agent-configuration/agents-md.md`]

1. Global: `$CODEX_HOME/AGENTS.override.md`, senão `$CODEX_HOME/AGENTS.md` (padrão `~/.codex`).
2. Projeto: da raiz do Git até o diretório atual, em cada diretório `AGENTS.override.md`, senão `AGENTS.md`
   (nomes alternativos por `project_doc_fallback_filenames`). No máximo um arquivo por diretório.
3. Concatenação da raiz para baixo; o mais próximo sobrescreve.
4. Teto de tamanho: `project_doc_max_bytes` (padrão 32 KiB); a descoberta para ao atingir o limite.
5. Cadeia reconstruída a cada execução; não há cache para limpar.

→ A ADE escreve `<worktree>/AGENTS.md` mínimo por story e pode usar `AGENTS.override.md` para substituir
regras do usuário sem apagá-las. [I]

### 5.2 Skills [V — `build-skills.md`]

| Escopo | Caminho |
| :--- | :--- |
| REPO | `$CWD/.agents/skills` |
| REPO | `$CWD/../.agents/skills` (acima do CWD, dentro do repo) |
| REPO | `$REPO_ROOT/.agents/skills` |
| USER | `$HOME/.agents/skills` |
| ADMIN | `/etc/codex/skills` |
| SYSTEM | embutidas pela OpenAI |

- `SKILL.md` com frontmatter YAML: `name`, `description` (a `description` é o que entra no contexto inicial e
  decide a invocação implícita). Corpo só carrega quando a skill ativa; `scripts/`, `references/`, `assets/`
  só quando referenciados.
- Metadados opcionais em `agents/openai.yaml`, incluindo `allow_implicit_invocation` (padrão `true`).
- Invocação: implícita por descrição, ou explícita com `$nome` / `/skills` na CLI.
- Colisão de nome não faz merge: ambas aparecem no seletor.
- `codex features list`: `skill_search` = stable/true, `skill_mcp_dependency_install` = stable/true,
  `skip_host_skill_discovery` = under development/false.
- **Override por config**, sem copiar arquivos: `skills.config[].path` (pasta com `SKILL.md`) +
  `skills.config[].enabled`; `skills.max_context_tokens` limita o catálogo apresentado (padrão 2% da janela,
  teto explícito de 10 000 tokens). [V — Configuration Reference]

Nesta máquina [V]: `~/.agents/skills/` tem as skills do usuário (caveman, adhd, ...) e
`~/.codex/skills/.system/` tem as embutidas (`imagegen`, `openai-docs`, `plugin-creator`, `review-agent`,
`skill-creator`, `skill-installer`). Ou seja, `$CODEX_HOME/skills` ainda é usado para system/bundled, mas o
caminho canônico de autor é `.agents/skills`.

→ **Decisão para a seção 9 da spec**: o catálogo `~/.ade/catalog/<fonte>/<skill>/` pode ser ligado ao Codex por
`-c 'skills.config=[{path="...", enabled=true}]'` por story, em vez de copiar SKILL.md para o worktree.
Isso preserva a regra "skill é leitura, não instalação" e mantém a seleção de no máximo 3 skills. [I]

### 5.3 Hooks [V — `hooks.md`, `config-file/config-reference.md`]

Feature `hooks` = **stable / true** (ligada por padrão). `codex_hooks` é alias depreciado.

Eventos (11): `SessionStart`, `SessionEnd`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `Stop`, `Interrupt`
(`Interrupt` e `SessionEnd` não rodam para subagentes).

Locais: `~/.codex/hooks.json`, `~/.codex/config.toml` (`[hooks]` inline), `<repo>/.codex/hooks.json`,
`<repo>/.codex/config.toml`; mais hooks empacotados em plugins e gerenciados por `requirements.toml`
(`hooks.managed_dir`, `hooks.windows_managed_dir`, `allow_managed_hooks_only`).
Hooks de projeto só carregam se o layer `.codex/` do projeto for confiável (`projects.<path>.trust_level`).
Todos os layers somam — o de maior precedência não substitui o de menor.

Handlers: `command` e `mcp_tool` (prompt/agent são parseados e ignorados). Campos por handler:
`async` (padrão false; `SessionEnd` é sempre síncrono), `additionalContextLimit` (padrão 2500 tokens),
`commandWindows` / `command_windows` (override de comando só no Windows).
Matchers: por nome de ferramenta em `PreToolUse`/`PostToolUse`/`PermissionRequest` (`Bash`, `apply_patch`,
`Edit`, `Write`, `mcp__<server>__<tool>`, `update_plan`, `Agent`); por gatilho `manual|auto` em
`PreCompact`/`PostCompact`; por `startup|resume|clear|compact` em `SessionStart`.
Ferramentas hospedadas (ex.: `WebSearch`) **não** passam por hook.
Segurança: hooks exigem "trust" persistido; `--dangerously-bypass-hook-trust` pula essa checagem.

→ A prática "saída filtrada" da seção 12 da spec tem implementação nativa: `PostToolUse` com matcher `Bash`
descartando saída que passou. E `commandWindows` resolve o problema de script POSIX em Windows. [I]

### 5.4 MCP [V]

`codex mcp list|get|add|remove|login|logout`.
`codex mcp add <NAME> (--url <URL> | -- <COMANDO...>)` com `--env KEY=VALUE` (só stdio),
`--bearer-token-env-var`, `--oauth-client-id`, `--oauth-client-registration auto|cimd|dcr`, `--oauth-resource`.
Config: `[mcp_servers.<id>]` com `command`, `args`, `env`, `startup_timeout_sec`, `required`,
`tools.<tool>.output_token_limit`. Se um servidor com `required = true` falhar ao iniciar,
`codex exec` sai com erro em vez de continuar sem ele. [V — non-interactive-mode]
O antigo `codex mcp-server` / binário `codex-mcp-server` foi **removido**; para embutir o Codex como serviço,
usa-se o `codex app-server`. [V — codex-sdk.md]

### 5.5 Plugins e marketplaces [V]

`codex plugin add|list|remove`, `codex plugin marketplace add|list|upgrade|remove` (fonte GitHub, Git URL,
SSH ou diretório local; `--ref`, `--sparse`). Config: `[marketplaces.<nome>]` com `source_type` (`git`/`local`)
e `source`; `[plugins."<plugin>@<marketplace>"] enabled = true`.
Features: `plugins` stable/true, `plugin_sharing` stable/true, `remote_plugin` stable/true,
`plugin_hooks` removed (hooks de plugin agora entram pelo caminho normal).

### 5.6 Subagentes / multi-agent [V — `agent-configuration/subagents.md`]

Feature `multi_agent` = stable / **true**; `multi_agent_v2` = stable / false.
Agentes embutidos: `default`, `worker`, `explorer`. Na CLI, `/agent` inspeciona e alterna threads de agente;
`codex agents` (top-level) navega as sessões de agente no daemon app-server local.

Agentes customizados: arquivos TOML **um por agente** em `~/.codex/agents/` (pessoal) ou `<repo>/.codex/agents/`
(projeto). Obrigatórios: `name`, `description`, `developer_instructions`. Aceitam também `model`,
`model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`. Nome do arquivo é convenção;
o campo `name` é a fonte da verdade; custom com nome de embutido tem precedência.
Globais em `[agents]`: `enabled` (padrão true), `max_concurrent_threads_per_session` (alias legado
`max_threads`), `default_subagent_model`, `default_subagent_reasoning_effort`, `interrupt_message`.
Herança: spawn explícito → default de `[agents]` → valor do pai; arquivo do agente sobrescreve.

→ Contradiz a linha "Advisor próprio / Sem advisor nativo das CLIs" da seção 12 da spec. Para revisão de PR,
o padrão oficial é um agente por eixo (segurança, testes, manutenibilidade) em paralelo. A ADE pode usar isso
dentro do papel Checker sem abrir mão da regra Maker ≠ Checker entre famílias. [I]

### 5.7 `codex review` [V]

Dois comandos com superfícies diferentes:

| | `codex review` | `codex exec review` |
| :--- | :--- | :--- |
| Alvos (exatamente um) | `--uncommitted`, `--base <BRANCH>`, `--commit <SHA>` (`--title` acompanha `--commit`) | idem |
| Prompt custom | `[PROMPT]` ou `-` (stdin) | idem |
| `-m/--model` | **não** | **sim** |
| `--json` | **não** | **sim** |
| `-o/--output-last-message` | **não** | **sim** |
| `--output-schema` | **não** | **sim** |
| `--ephemeral`, `--skip-git-repo-check`, `--ignore-user-config`, `--ignore-rules`, `--worktree`, `--thread-source` | **não** | **sim** |

O revisor lê o diff selecionado e devolve achados priorizados **sem alterar a árvore de trabalho**. [V — code-review.md]
Existe um modelo dedicado `codex-auto-review` no catálogo (oculto), usado pela revisão automática. [V]

→ **Decisão**: o Checker da ADE usa
`codex exec review --json --base <branch> --output-schema review.schema.json -o review.json`,
o que casa com a exigência de "revisão por agente de outra família com saída estruturada". [I]

### 5.8 Codex cloud / app [V]

`codex cloud [--env <ENV_ID>] [--attempts 1-4]`, `codex cloud list [--json] [--limit] [--cursor]`,
`codex apply <TASK_ID>` (aplica o diff da última tarefa cloud como `git apply`).
`codex app` abre o app desktop; `codex remote-control start|stop|pair` expõe o app-server local para
controle remoto (feature `remote_control` = removed como flag, virou subcomando).
Fora do escopo da v1 da ADE, mas `codex apply` é um caminho de integração barato se algum dia houver
execução em nuvem. [I]

---

## 6. Multimodal

### 6.1 Entrada de imagem [V]

`-i, --image <FILE>...` em `codex`, `codex exec`, `codex resume`, `codex exec resume`.
Também `codex debug prompt-input -i <FILE>` renderiza o input visível ao modelo em JSON — útil para
depurar o que a ADE está realmente enviando. Feature `view_image` = stable/true.
Leitura de screenshots (loop visual da seção 10 da spec): suportada pelo mesmo caminho. [V]

### 6.2 Geração de imagem [V — `image-generation.md` + skill local `~/.codex/skills/.system/imagegen/`]

- Invocação: incluir `$imagegen` no prompt para chamar a skill explicitamente; sem isso, a descrição da skill
  pode acioná-la implicitamente.
- **Dois caminhos**:
  1. Ferramenta embutida `image_gen` (preferida) — **não** requer `OPENAI_API_KEY`; conta contra os limites
     de uso normais do Codex; salva por padrão em `$CODEX_HOME/generated_images/...`.
  2. Fallback CLI `scripts/image_gen.py` (`generate` | `edit` | `generate-batch`) — **requer**
     `OPENAI_API_KEY` + rede; só usar quando o usuário pede controle de modelo/tamanho/qualidade.
- Modelo: `gpt-image-2` (fallback explícito `gpt-image-1.5` só com confirmação).
- Limites verificados no `references/image-api.md` da skill: **até 16 imagens de entrada** para modelos
  GPT Image; aresta máxima ≤ 3840 px; ambas as arestas múltiplas de 16; presets 4K `3840x2160` /
  `2160x3840`; `--quality low|medium|high|auto`; `--size auto` por padrão.
- Custo: "Image generations use included limits 3–5x faster on average than similar turns without image
  generation". Sem preço em USD. Feature `image_generation` = stable/true.

→ A spec v2 dizia "gpt-image-2, até 16 imagens de referência, 1K–4K": **confirmado**, com a correção de que
4K aqui é 3840×2160 (não 4096) e de que o caminho embutido não precisa de chave de API.

→ **Ponto aberto**: a doc descreve `$imagegen` em "interactive session". Em `codex exec` headless, incluir
`$imagegen` no prompt deve funcionar porque a invocação explícita é textual e a skill é descoberta em
qualquer superfície da CLI [I] — **não testado** (o smoke test permitido não gera imagens). Antes do
sub-projeto 5 da spec, rodar um teste dedicado com `--sandbox workspace-write`.

---

## 7. Telemetria

- **Por execução**: só o bloco `usage` do `turn.completed` (`input_tokens`, `cached_input_tokens`,
  `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`). [V — smoke test]
- **OTel** em `config.toml` [V — Configuration Reference]: `otel.environment` (padrão `dev`),
  `otel.exporter` (`none|otlp-http|otlp-grpc`), `otel.trace_exporter`, `otel.metrics_exporter`
  (`none|statsig|otlp-http|otlp-grpc`, padrão `statsig`), `otel.log_user_prompt` (bool),
  e por exportador `<id>.endpoint`, `.protocol`, `.headers`, `.tls.ca-certificate`,
  `.tls.client-certificate`, `.tls.client-private-key`.
- `codex usage` **não existe**. [V]
- `codex doctor [--summary|--all|--json|--no-color|--ascii]` dá um relatório de saúde redigido, com estado de
  sandbox, auth, MCP, bancos e threads. [V] → entra no `ade doctor` como sub-checagem do adapter Codex.
- Feature `runtime_metrics` = under development/false.

---

## 8. Windows

- Instalação nativa: binário em `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe`, pacotes versionados em
  `%USERPROFILE%\.codex\packages\standalone\releases\<versão>-x86_64-pc-windows-msvc\`, com `rg.exe` embutido
  em `codex-path\`. [V — `codex doctor`]
- `CODEX_HOME` = `%USERPROFILE%\.codex` por padrão; guarda `config.toml`, `auth.json`, `sessions/`,
  `skills/`, `plugins/`, `agents/`, `.sandbox/`, `.sandbox-secrets/`, `history.jsonl`,
  `session_index.jsonl` e SQLite (`thread_history_1`, `state_5`, `logs_2`, `goals_1`, `queue_1`, `memories_1`). [V]
- PTY: a matriz oficial diz que Codex depende de suporte moderno de console, **incluindo ConPTY**, e que na
  prática Windows 10 ≥ 1809 é o mínimo. [V] Casa com a exigência de `node-pty`/ConPTY da seção 3 da spec.
- Caminhos em `config.toml` aparecem em minúsculas nas chaves `[projects.'e:\...']` — a comparação de path do
  Codex é case-insensitive e normalizada. [V, observado no config local]
- `codex doctor` recomenda Dev Drive e alerta que o Microsoft Defender pode interferir. [V]
- `codex completion power-shell` gera completions. [V]
- `winget` é assumido disponível para o setup do sandbox. [V]

---

## 9. Contexto e compactação

- Janela: 272 000 tokens em todos os modelos do catálogo atual. [V — `models_cache.json`]
- Compactação automática: `model_auto_compact_token_limit` (não definido = padrão do modelo) e
  `model_auto_compact_token_limit_scope` = `total` (padrão) | `body_after_prefix`. [V]
- Prompt de compactação customizável: `compact_prompt` (inline) e `experimental_compact_prompt_file`. [V]
- Hooks `PreCompact`/`PostCompact` com matcher `manual|auto` — ou seja, `/compact` manual existe e é
  observável. [V]
- `features.context_management` (under development): em vez de comprimir tudo num sumário, usa notas e
  histórico pesquisável; exige login ChatGPT Plus/Pro/Pro Lite. [V]
- `tool_output_token_limit` limita o que cada saída de ferramenta ocupa no histórico. [V]
- `skills.max_context_tokens`: catálogo de skills ocupa por padrão 2% da janela (≈5 440 tokens), teto
  explícito 10 000. [V] Isso explica parte dos ~19,4k tokens de overhead medidos no smoke test. [I]

→ Para a ADE (contexto limpo por story), o caminho é sessão nova por story + `--ephemeral` quando não houver
takeover; compactação automática é rede de segurança, não estratégia. [I]

---

## 10. Codex SDK

Existe, em duas linguagens. [V — `codex-sdk.md`, README do repo]

**TypeScript — `@openai/codex-sdk`** (Node ≥ 18). Envolve o binário `codex` e troca **os mesmos eventos JSONL
por stdin/stdout**. API: `new Codex()` → `codex.startThread()` / `codex.resumeThread(threadId)` →
`thread.run(prompt)` (bufferiza até o fim do turno, devolve `result.finalResponse`) ou `thread.runStreamed()`
(async generator de eventos estruturados: tool calls, streaming, file changes). Structured output por JSON
Schema (objeto simples ou Zod via `zod-to-json-schema`). Suporta imagens por entradas estruturadas,
`workingDirectory`, bypass do check de repositório Git, variáveis de ambiente do CLI e overrides de config
(objeto `config` ou `configOverrides` TOML cru).

**Python — `openai-codex`** (Python ≥ 3.10). Controla o **app-server local por JSON-RPC** (não o JSONL do exec).
`Codex()` / `AsyncCodex()`, `codex.thread_start(model=..., sandbox=Sandbox.workspace_write)`,
`thread.run(prompt, sandbox=...)`, `result.final_response`. Presets `Sandbox.read_only`,
`Sandbox.workspace_write`, `Sandbox.full_access`; o sandbox passado num turno vale para os seguintes.

**Substituiria o parse de JSONL?** Para a ADE, **não**. Três razões: (1) o SDK TS é um wrapper do mesmo CLI e
dos mesmos eventos — não há informação nova, só uma dependência a mais e um ponto de versionamento
desalinhado; (2) a spec exige PTY real para espelhar o terminal no painel, e o SDK não entrega isso;
(3) o adapter precisa da mesma forma para `claude` e `gemini`, então o parser genérico de eventos é
inevitável. O SDK TS vale como **referência de tipos** dos eventos ao escrever o parser. [I]
O `codex app-server` (`--listen stdio://|ws://|unix://`, com autenticação por capability token ou bearer
assinado) é a alternativa séria se um dia a ADE quiser aprovações interativas programáticas e histórico de
conversa gerenciado — é o caminho oficial desde a remoção do `codex mcp-server`. [V + I]

---

## 11. Riscos específicos do adapter Codex

| Risco | Evidência | Mitigação |
| :--- | :--- | :--- |
| Doc oficial diverge do binário (`--full-auto`) | [V] | `ade doctor` valida flags contra `--help` do binário instalado e falha cedo |
| Slugs e efforts mudam rápido (releases alpha diárias: `rust-v0.155.0-alpha.10` em 2026-09-16) | [V — `gh api repos/openai/codex/releases`) | Capability Registry lê `codex debug models --bundled` em vez de hardcodar slugs |
| Campos novos em `usage` (`cache_write_input_tokens` não está na doc) | [V] | Parser tolerante a campos desconhecidos; nunca schema fechado na entrada |
| Overhead fixo de ~19,4k tokens por chamada headless | [V] | Podar AGENTS.md global, limitar `skills.max_context_tokens`, usar `--ignore-user-config` em chamadas de classificação |
| `--ephemeral` inviabiliza takeover | [V] | Adapter só usa `--ephemeral` em chamadas marcadas como descartáveis |
| Sandbox `elevated` pode falhar em máquina corporativa (erro 1385, criação de usuário bloqueada) | [V] | `ade doctor` lê `[windows] sandbox` e o resultado de `codex doctor`; degrada para `unelevated` com aviso |
| `codex review` sem `--json` | [V] | Sempre `codex exec review` |

---

## 12. CapabilitySet proposto (JSON)

```json
{
  "family": "codex",
  "binary": "codex",
  "binary_resolution": {
    "win32": "%LOCALAPPDATA%\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    "note": "no PATH resolve como 'codex' (exe nativo, nao .cmd); CODEX_HOME padrao %USERPROFILE%\\.codex"
  },
  "probed_version": "0.154.0",
  "probed_at": "2026-09-16",
  "headless": {
    "command": ["exec"],
    "prompt_via": ["argv", "stdin", "stdin-sentinel:-"],
    "stream_format": "jsonl",
    "stream_flag": "--json",
    "stdout_without_json": "final-message-only",
    "progress_stream": "stderr",
    "final_message_file": "-o",
    "structured_output": { "flag": "--output-schema", "input": "json-schema-file" },
    "cwd_flag": "-C",
    "extra_writable_dirs_flag": "--add-dir",
    "skip_git_check_flag": "--skip-git-repo-check",
    "ephemeral_flag": "--ephemeral",
    "worktree_flag": "--worktree",
    "ignore_user_config_flag": "--ignore-user-config",
    "ignore_rules_flag": "--ignore-rules",
    "no_approval_flag_in_exec": true,
    "removed_flags": ["--full-auto"]
  },
  "events": {
    "types": ["thread.started", "turn.started", "turn.completed", "turn.failed", "item.started", "item.completed", "error"],
    "item_types": ["agent_message", "reasoning", "command_execution", "file_change", "mcp_tool_call", "web_search", "plan_update"],
    "session_id_field": "thread_id",
    "usage_on": "turn.completed",
    "usage_fields": ["input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens", "reasoning_output_tokens"],
    "tolerant_parse": true
  },
  "cost": {
    "usd_reported": false,
    "tokens_reported": true,
    "report_as": "unknown-usd-with-tokens"
  },
  "session": {
    "persistent": true,
    "rollout_path": "$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ts>-<thread_id>.jsonl",
    "index": "$CODEX_HOME/session_index.jsonl",
    "resume_headless": ["exec", "resume", "<thread_id>"],
    "resume_headless_last": ["exec", "resume", "--last"],
    "resume_interactive": ["resume", "<thread_id>", "--include-non-interactive"],
    "fork": ["exec", "fork", "<thread_id>"],
    "queue_message": ["queue", "--thread", "<thread_id>", "--message", "<text>"],
    "takeover_supported": true,
    "takeover_requires": "nao usar --ephemeral na story"
  },
  "models": {
    "discovery_command": ["debug", "models", "--bundled"],
    "context_window_tokens": 272000,
    "catalog_2026_09_16": ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.2"],
    "model_flag": "-m",
    "effort_override": "-c model_reasoning_effort=\"<valor>\"",
    "effort_values_catalog": ["low", "medium", "high", "xhigh", "max", "ultra"],
    "effort_values_config_doc": ["minimal", "low", "medium", "high", "xhigh"],
    "roles": {
      "checker": { "model": "gpt-5.6-sol", "effort": "high" },
      "maker_engineering": { "model": "gpt-5.6-sol", "effort": "high" },
      "cheap_classify": { "model": "gpt-5.6-luna", "effort": "low" },
      "read_heavy_scan": { "model": "gpt-5.6-terra", "effort": "medium" }
    }
  },
  "sandbox": {
    "flag": "-s",
    "modes": ["read-only", "workspace-write", "danger-full-access"],
    "default_in_exec": "read-only",
    "network_default": "off",
    "network_enable": "-c sandbox_workspace_write.network_access=true",
    "writable_roots_key": "sandbox_workspace_write.writable_roots",
    "bypass_flag": "--dangerously-bypass-approvals-and-sandbox",
    "bypass_alias": "--yolo",
    "windows_native": true,
    "windows_modes": ["elevated", "unelevated"],
    "windows_config_key": "windows.sandbox",
    "windows_needs_wsl": false,
    "windows_log": "$CODEX_HOME/.sandbox/sandbox.log",
    "reusable_wrapper": ["sandbox", "--", "<comando>"],
    "policy_dryrun": ["execpolicy", "-r", "<rules>", "--", "<comando>"]
  },
  "approvals": {
    "interactive_flag": "-a",
    "values": ["on-request", "never"],
    "available_in_exec": false,
    "auto_review_flag": "--approve-for-me",
    "config_keys": ["approval_policy", "approvals_reviewer"]
  },
  "extensibility": {
    "project_instructions": {
      "files": ["AGENTS.override.md", "AGENTS.md"],
      "scopes": ["$CODEX_HOME", "git-root..cwd"],
      "merge": "root-to-leaf, closer overrides",
      "max_bytes_key": "project_doc_max_bytes"
    },
    "skills": {
      "format": "SKILL.md + frontmatter(name, description)",
      "paths": ["$CWD/.agents/skills", "$CWD/../.agents/skills", "$REPO_ROOT/.agents/skills", "$HOME/.agents/skills", "/etc/codex/skills"],
      "bundled_path": "$CODEX_HOME/skills/.system",
      "explicit_invocation": "$<nome>",
      "implicit_invocation": true,
      "implicit_toggle": "agents/openai.yaml: allow_implicit_invocation",
      "path_override_key": "skills.config[].path",
      "catalog_budget_key": "skills.max_context_tokens"
    },
    "hooks": {
      "enabled_by_default": true,
      "events": ["SessionStart", "SessionEnd", "SubagentStart", "SubagentStop", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "PreCompact", "PostCompact", "Stop", "Interrupt"],
      "locations": ["$CODEX_HOME/hooks.json", "$CODEX_HOME/config.toml", "<repo>/.codex/hooks.json", "<repo>/.codex/config.toml"],
      "handler_types": ["command", "mcp_tool"],
      "windows_command_key": "commandWindows",
      "requires_trust": true
    },
    "mcp": {
      "add": ["mcp", "add", "<nome>", "--", "<comando>"],
      "add_http": ["mcp", "add", "<nome>", "--url", "<url>"],
      "config_table": "mcp_servers.<id>",
      "required_server_fails_exec": true,
      "mcp_server_mode_removed": true,
      "replacement": "codex app-server"
    },
    "subagents": {
      "enabled_by_default": true,
      "builtin": ["default", "worker", "explorer"],
      "custom_agent_paths": ["$CODEX_HOME/agents/*.toml", "<repo>/.codex/agents/*.toml"],
      "required_fields": ["name", "description", "developer_instructions"],
      "global_table": "agents",
      "concurrency_key": "agents.max_concurrent_threads_per_session"
    },
    "plugins": {
      "commands": ["plugin add", "plugin list", "plugin remove", "plugin marketplace add|list|upgrade|remove"],
      "config_tables": ["marketplaces.<nome>", "plugins.\"<plugin>@<marketplace>\""]
    }
  },
  "review": {
    "preferred_command": ["exec", "review"],
    "targets": ["--uncommitted", "--base <branch>", "--commit <sha>"],
    "supports_json": true,
    "supports_output_schema": true,
    "supports_model_flag": true,
    "mutates_worktree": false,
    "top_level_review_supports_json": false
  },
  "multimodal": {
    "image_input_flag": "-i",
    "image_input_in": ["exec", "resume", "exec resume", "interactive"],
    "image_generation": {
      "skill": "$imagegen",
      "builtin_tool": "image_gen",
      "builtin_requires_api_key": false,
      "fallback_cli": "$CODEX_HOME/skills/.system/imagegen/scripts/image_gen.py",
      "fallback_requires_api_key": true,
      "model": "gpt-image-2",
      "max_reference_images": 16,
      "max_edge_px": 3840,
      "edge_multiple_px": 16,
      "presets_4k": ["3840x2160", "2160x3840"],
      "default_save_dir": "$CODEX_HOME/generated_images",
      "headless_invocation_verified": false
    }
  },
  "telemetry": {
    "per_run": "usage no turn.completed",
    "usage_command": null,
    "otel_table": "otel",
    "otel_exporters": ["none", "otlp-http", "otlp-grpc"],
    "otel_metrics_exporters": ["none", "statsig", "otlp-http", "otlp-grpc"],
    "health_command": ["doctor", "--json"]
  },
  "context": {
    "window_tokens": 272000,
    "auto_compact_key": "model_auto_compact_token_limit",
    "auto_compact_scope_key": "model_auto_compact_token_limit_scope",
    "manual_compact": "/compact",
    "compact_observable_via_hooks": ["PreCompact", "PostCompact"],
    "tool_output_limit_key": "tool_output_token_limit"
  },
  "budget": {
    "per_run_turn_limit": null,
    "per_run_cost_limit": null,
    "token_budget_keys": ["features.rollout_budget.enabled", "features.rollout_budget.limit_tokens"],
    "token_budget_stability": "under-development",
    "enforcement_owner": "ade-engine"
  },
  "sdk": {
    "typescript": { "package": "@openai/codex-sdk", "node_min": 18, "transport": "wraps codex CLI over JSONL" },
    "python": { "package": "openai-codex", "python_min": "3.10", "transport": "app-server JSON-RPC" },
    "app_server": { "command": ["app-server", "--listen", "stdio://|ws://|unix://"], "auth": ["capability-token", "signed-bearer-token"] },
    "ade_decision": "nao adotar; parser JSONL proprio + PTY"
  },
  "windows": {
    "native_install": true,
    "conpty_required": true,
    "min_windows_10_build": "1809",
    "recommended": "Windows 11",
    "shell_resolution_note": "codex.exe nativo; ao contrario de claude.cmd nao precisa de shim",
    "completion": ["completion", "power-shell"]
  },
  "unverified": [
    "fidelidade integral do transcript ao retomar sessao de exec na TUI",
    "$imagegen em codex exec headless",
    "alias de modelo 'gpt-5.6' sem sufixo sol/terra/luna",
    "aceitacao real de model_reasoning_effort=ultra pelo endpoint"
  ]
}
```

---

## 13. Fontes

Primárias — binário instalado (2026-09-16, `codex-cli 0.154.0`, windows-x86_64):
`codex --help`, `codex exec --help`, `codex exec -h`, `codex exec resume --help`, `codex exec review --help`,
`codex resume --help`, `codex review --help`, `codex mcp --help`, `codex mcp add --help`,
`codex plugin --help`, `codex sandbox --help`, `codex features --help`, `codex features list`,
`codex queue --help`, `codex debug models --bundled`, `codex doctor --summary`,
`codex exec --json --sandbox read-only --skip-git-repo-check -C . "responda apenas OK"`.

Arquivos locais inspecionados: `C:\Users\Erick\.codex\config.toml`, `models_cache.json`,
`session_index.jsonl`, `sessions/2026/09/16/rollout-*.jsonl`, `skills/.system/imagegen/SKILL.md`,
`skills/.system/imagegen/references/cli.md`, `skills/.system/imagegen/references/image-api.md`,
`.sandbox/`, `.sandbox-bin/`, `C:\Users\Erick\.agents\skills\`.

Documentação oficial (Markdown gêmeo, acessado 2026-09-16):

- https://learn.chatgpt.com/llms.txt (índice)
- https://learn.chatgpt.com/docs/developer-commands?surface=cli (ex-`developers.openai.com/codex/cli/reference`)
- https://learn.chatgpt.com/docs/non-interactive-mode.md
- https://learn.chatgpt.com/docs/agent-configuration/agents-md.md
- https://learn.chatgpt.com/docs/build-skills.md
- https://learn.chatgpt.com/docs/hooks.md
- https://learn.chatgpt.com/docs/agent-configuration/subagents.md
- https://learn.chatgpt.com/docs/sandboxing.md
- https://learn.chatgpt.com/docs/windows/windows-sandbox.md
- https://learn.chatgpt.com/docs/agent-approvals-security.md
- https://learn.chatgpt.com/docs/config-file/config-reference.md
- https://learn.chatgpt.com/docs/config-file/config-advanced
- https://learn.chatgpt.com/docs/code-review.md
- https://learn.chatgpt.com/docs/image-generation.md
- https://learn.chatgpt.com/docs/models.md
- https://learn.chatgpt.com/docs/codex-sdk.md

Repositório: https://github.com/openai/codex (docs/*.md são stubs que apontam para o site),
https://raw.githubusercontent.com/openai/codex/main/sdk/typescript/README.md,
https://github.com/openai/codex/tree/main/sdk/python,
`gh api repos/openai/codex/releases --paginate` (mais recente em 2026-09-16: `rust-v0.155.0-alpha.10`).

Comunidade (usada só para orientar a busca, nenhuma afirmação sustentada por ela):
agenticcontrolplane.com/blog/codex-cli-hooks-reference, codex.danielvaughan.com, agentskillshub.dev.
