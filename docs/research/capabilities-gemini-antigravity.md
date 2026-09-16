# Capacidades reais: Gemini CLI 0.59.0 e Antigravity CLI (`agy`) 1.2.3

Pesquisa para o Capability Registry da ADE. Data: 2026-09-16. Máquina: Windows 11 Pro 26200.
Classificação por afirmação: `[verificado: fonte]`, `[inferido]`, `[hipótese]`.

## 0. TL;DR — o que muda na spec v2

| Item da spec v2 | Situação | Correção |
| :--- | :--- | :--- |
| §5: "adapter detecta `gemini` ou `antigravity`" | **Errado no nome do binário** | O binário do Antigravity CLI chama-se **`agy`** (`agy.EXE`). Nunca existiu comando `antigravity`. |
| Premissa do prompt: "antigravity NÃO está instalado" | **Errado** | `agy` 1.2.3 está instalado e **autenticado** nesta máquina em `C:\Users\Erick\AppData\Local\agy\bin\agy.EXE` (195 MB, Go), já no PATH, com uso real registrado em 2026-09-15. |
| §5: "acesso consumidor do Gemini CLI acabou em 2026-06-18" | **Verdadeiro, com ressalvas** | Data e fato confirmados em blog oficial. Mas o projeto OSS `gemini-cli` **não morreu**: v0.60.0 estável em 2026-09-15, nightly diária até 2026-09-16, 107k estrelas, não arquivado. Quem tem Code Assist Standard/Enterprise, `GEMINI_API_KEY` ou Vertex AI continua usando `gemini`. |
| §13: "Gemini/Antigravity: contexto 1M" | Verificado só para o **Gemini CLI** | `DEFAULT_TOKEN_LIMIT = 1_048_576` no código. Para o `agy` não há número publicado. |
| §13: "Gemini = terceira família" | **Risco novo** | O `agy` serve `claude-sonnet-4-6`, `claude-opus-4-6-thinking` e `gpt-oss-120b-medium` além dos Gemini. A regra Maker ≠ Checker precisa comparar **model id**, não binário. |

## 1. A migração é verdadeira? (decisão 1)

### 1.1 Fatos

| Fato | Classificação |
| :--- | :--- |
| Anúncio em 2026-05-19 (Google I/O), no Google Developers Blog: "An important update: Transitioning Gemini CLI to Antigravity CLI" | [verificado: developers.googleblog.com, post datado MAY 19, 2026] |
| "On June 18, 2026, Gemini CLI and Gemini Code Assist IDE extensions will stop serving requests" | [verificado: citação literal do post] |
| Perdem acesso: "Google AI Pro and Ultra, as well as those using it free of charge using Gemini Code Assist for individuals" | [verificado: citação literal] |
| Mantêm acesso: organizações com "Gemini Code Assist Standard or Enterprise license" e quem usa "paid Gemini and Gemini Enterprise Agent Platform API keys" | [verificado: citação literal] |
| Antigravity CLI: "brand-new terminal experience", "built in Go", "shares the same agent harness as Antigravity 2.0, the new Antigravity desktop application" | [verificado: citação literal] |
| Sem período de graça anunciado | [inferido: o post não menciona nenhum; blogs secundários afirmam "no grace period"] |

### 1.2 Evidência de que o Gemini CLI segue vivo como projeto

| Evidência | Fonte |
| :--- | :--- |
| `v0.60.0` estável publicada em 2026-09-15T20:31Z; `v0.59.0` em 2026-09-08; nightly `v0.62.0-nightly.20260916` | [verificado: `gh api repos/google-gemini/gemini-cli/releases`, 2026-09-16] |
| Repositório não arquivado, `pushedAt` 2026-09-16T01:28Z, 107.009 estrelas | [verificado: `gh repo view google-gemini/gemini-cli`] |
| `docs/get-started/authentication.mdx` (main, hoje) **ainda documenta** "Sign in with Google" para contas individuais, incluindo "free tier accounts such as Gemini Code Assist for individuals, as well as paid subscriptions for Google AI Pro and Ultra" | [verificado: conteúdo via `gh api contents`] |
| `docs/resources/quota-and-pricing.md` ainda lista 1.000 req/dia (Code Assist Individual), 1.500 (AI Pro), 2.000 (AI Ultra) | [verificado: mesma fonte] |

**Conflito real, registrado e não resolvido:** o blog oficial diz que Pro/Ultra/free perderam acesso em 2026-06-18; a documentação oficial do mesmo produto, viva e atualizada diariamente, continua instruindo esse mesmo público a entrar com conta pessoal. Hierarquia de fontes empata (ambas são oficiais e primárias). A hipótese mais econômica é **documentação desatualizada nesses dois arquivos**, porque o código do próprio CLI implementa a migração (§1.3) — mas isso é `[hipótese]`, não fato.

### 1.3 O código do Gemini CLI implementa a migração (prova primária)

`packages/cli/src/ui/hooks/useBanner.ts` (main, hoje):

- banners normalmente somem após 5 exibições (`DEFAULT_MAX_BANNER_SHOWN_COUNT = 5`), **exceto** se o texto contiver `Antigravity`: `activeText.includes('Antigravity')` faz o banner ser mostrado para sempre;
- quando o banner é de Antigravity, o CLI **anexa o comando de instalação** do `agy` via `getAntigravityInstallInfo()`.

`packages/cli/src/ui/utils/antigravityUtils.ts` define os comandos exatos por plataforma (§1.5). Há ainda uma skill embutida `packages/core/src/skills/builtin/antigravity-support/SKILL.md` — uma das **duas** skills built-in do produto (a outra é `skill-creator`) — cuja única função é ensinar a instalar e migrar para o Antigravity CLI. [verificado: `gh api contents`, 2026-09-16]

### 1.4 Estado local desta máquina (evidência de campo)

| Observação | Comando / arquivo |
| :--- | :--- |
| Smoke test autorizado devolveu, sem chamar modelo: `Opening authentication page in your browser. Do you want to continue? [Y/n]:` | `gemini -p "responda apenas OK" --output-format json` (timeout 120 s, exit 0) |
| `~/.gemini/google_accounts.json` → `{"active": null, "old": ["erickluan.net8@gmail.com"]}` | conta consumidora **desativada**, nenhuma ativa |
| `~/.gemini/settings.json` → `security.auth.selectedType: "oauth-personal"` | o tipo escolhido é justamente o que foi descontinuado |
| Nenhum arquivo de credencial OAuth em `~/.gemini` | `find ~/.gemini -maxdepth 2 -iname "*creds*"` vazio |
| `agy models` responde com catálogo completo, sem pedir login | `agy` está autenticado e falando com `daily-cloudcode-pa.googleapis.com` |
| `~/.gemini/antigravity-cli/cli.log` com tráfego real em 2026-09-15 02:53 | uso ativo do `agy` |

Leitura: nesta máquina o `gemini` **não tem credencial consumidora válida** e o caminho de auth que ele oferece é o `oauth-personal`. Não foi possível provar se o login completaria (exigiria browser interativo — fora do escopo e do limite de um smoke test). `[verificado: execução local]` para o estado; `[hipótese]` para o resultado de um login novo.

### 1.5 Antigravity CLI: instalação, binário, auth

| Item | Valor | Fonte |
| :--- | :--- | :--- |
| Binário | `agy` (`agy.EXE` no Windows) | [verificado: local + antigravity-support SKILL.md] |
| Windows PowerShell | `irm https://antigravity.google/cli/install.ps1 \| iex` | [verificado: antigravityUtils.ts + docs oficiais] |
| Windows CMD | `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd` | [verificado: antigravityUtils.ts] |
| macOS/Linux | `curl -fsSL https://antigravity.google/cli/install.sh \| bash` | [verificado: idem] |
| Local de instalação (Windows) | `C:\Users\<user>\AppData\Local\agy\bin` (registrado no PATH pelo instalador) | [verificado: docs `/docs/cli/getting-started` + filesystem local] |
| Local de instalação (macOS/Linux) | `~/.local/bin/agy` | [verificado: docs] |
| Config | `~/.gemini/antigravity-cli/settings.json` (+ `~/.gemini/config/config.json` compartilhado com o desktop) | [verificado: docs `/docs/cli/install` + filesystem local] |
| Auth conta | OAuth Google com credencial no keyring do SO (Windows Credential Manager) | [verificado: docs `/docs/cli/install`] |
| Auth API key | `modelProvider: "gemini"` + `GEMINI_API_KEY`; "the CLI never establishes an account session" | [verificado: citação literal, docs] |
| Endpoint custom | `GOOGLE_GEMINI_BASE_URL` | [verificado: docs] |
| SSH remoto | fluxo manual: URL no browser + código alfanumérico | [verificado: docs] |

**Modelos oferecidos hoje a esta conta** (`agy models`, 2026-09-16) [verificado: execução local]:

```
gemini-3.8-flash-high / -medium / -low
gemini-3.7-flash-high / -medium / -low
gemini-3.6-flash-high / -medium / -low
gemini-3.1-pro-high   / -low          (sem "medium")
claude-sonnet-4-6                      (Claude Sonnet 4.6 Thinking)
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

O sufixo `-high|-medium|-low` é o **reasoning effort embutido no id**; `--effort low|medium|high` faz a mesma seleção por flag (o changelog 1.1.28 chama isso de "`--effort` variant selection"). [verificado: `agy models`, `agy --help`, changelog 1.1.28]

Planos e cota: Pro/Ultra têm "High, generous quota, refreshed every five hours until weekly limit reached"; os demais, "Meaningful quota, refreshed weekly". Modelos de terceiros (Claude/GPT-OSS) são **exclusivos de Ultra**. Créditos G1 cobrem estouro de cota, com chave `useG1Credits` (on/off) e painel `/credits`. Números exatos de requisições por dia **não são publicados**: "The baseline rate limits are primarily determined to the degree we have capacity". [verificado: antigravity.google/docs/plans, /docs/cli/credits] — preços por tier ($20 Pro / $100 / $200–250 Ultra) só aparecem em blogs terceiros, portanto `[hipótese]` e irrelevante para a decisão.

## 2. Modo headless (decisão 2)

### 2.1 Gemini CLI 0.59.0 — flags reais do binário instalado

`gemini --help` (execução local, 2026-09-16) [verificado]:

| Flag | Valor | Nota |
| :--- | :--- | :--- |
| `-p, --prompt <str>` | headless; **anexado ao stdin se houver** | stdin funciona: `cat logs.txt \| gemini` |
| `-i, --prompt-interactive` | executa e continua interativo | ponte headless → interativo |
| `-o, --output-format` | `text` \| `json` \| `stream-json` | |
| `-m, --model` | string | aliases `auto`, `pro`, `flash`, `flash-lite`; ids `gemini-3-pro-preview`, `gemini-3-flash-preview`, `gemini-3.1-pro-preview`, `gemini-2.5-pro/flash/flash-lite` |
| `--approval-mode` | `default` \| `auto_edit` \| `yolo` \| `plan` | **usar este** |
| `-y, --yolo` | boolean | **deprecado** em favor de `--approval-mode=yolo` |
| `--policy` / `--admin-policy` | array de arquivos/diretórios | Policy Engine — substituto de `--allowed-tools` (deprecado) |
| `--include-directories` | array | workspace multi-raiz |
| `-s, --sandbox` | boolean | §4 |
| `--skip-trust` | boolean | pula o folder-trust; **necessário em CI/worktree novo** |
| `-w, --worktree [nome]` | string | exige `experimental.worktrees: true` no settings |
| `--acp` | boolean | ACP; `--experimental-acp` ainda aceito, deprecado |
| `--raw-output` / `--accept-raw-output-risk` | boolean | desliga sanitização ANSI |
| `-e, --extensions`, `-l, --list-extensions` | array/bool | |
| `--allowed-mcp-server-names` | array | |
| `--screen-reader` | boolean | |

**Ausências confirmadas no 0.59.0** (existiam em versões antigas e **não** devem entrar no adapter): `--all-files`, `--telemetry*`, `--checkpointing`. `--checkpointing` foi removido na 0.11.0 [verificado: docs/cli/checkpointing.md, nota literal]. `--all-files` não aparece no help nem na referência; o substituto é `--include-directories` + `@`/`read_many_files` [inferido].

Divergência a registrar: `docs/cli/cli-reference.md` está **atrasado** em relação ao binário (não lista `--acp`, `--policy`, `--session-file`, `--session-id`, `--raw-output`, e ainda descreve aliases de modelo apontando para `gemini-2.5-pro`). Fonte de verdade para o adapter = `gemini --help` da versão instalada. [verificado: comparação direta]

### 2.2 Formato JSON — campos exatos (`packages/core/src/output/types.ts`, main)

```ts
interface JsonOutput {                 // --output-format json
  session_id?: string;
  response?: string;
  stats?: SessionMetrics;
  error?: { type: string; message: string; code?: string | number };
  warnings?: string[];
}
```

`--output-format stream-json` → NDJSON, `type` ∈ `init | message | tool_use | tool_result | error | result`, todos com `timestamp`:

| Evento | Campos |
| :--- | :--- |
| `init` | `session_id`, `model` |
| `message` | `role: "user"\|"assistant"`, `content`, `delta?` |
| `tool_use` | `tool_name`, `tool_id`, `parameters` |
| `tool_result` | `tool_id`, `status: "success"\|"error"`, `output?`, `error?` |
| `error` | `severity: "warning"\|"error"`, `message` |
| `result` | `status`, `error?`, `stats?` |

`StreamStats`: `total_tokens`, `input_tokens`, `output_tokens`, `cached`, `input`, `duration_ms`, `tool_calls`, `models: Record<modelId, {total_tokens, input_tokens, output_tokens, cached, input}>`.

**Não existe campo de custo em USD.** `costOf()` do adapter devolve `{ usd: "unknown", tokens }` — exatamente o caso previsto na §5 da spec. [verificado: types.ts]

Exit codes headless: `0` sucesso, `1` erro geral/API, `42` erro de entrada, `53` limite de turnos excedido. [verificado: docs/cli/headless.md]

### 2.3 Antigravity CLI (`agy --help`, 1.2.3) [verificado: execução local]

| Flag | Valor |
| :--- | :--- |
| `-p, --print` (alias `--prompt`) | prompt único não-interativo |
| `-i, --prompt-interactive` | executa e continua interativo |
| `--output-format` | `text` \| `json` \| `stream-json` (default `text`) |
| `--input-format` | `text` \| `stream-json` — **NDJSON no stdin, um turno por linha**; exige `--output-format stream-json` |
| `--json-schema` | string ou caminho de arquivo — **força saída estruturada** (em stream-json, aplica só ao resultado final) |
| `--print-timeout` | default `5m0s`; ao estourar devolve **saída parcial e exit 0** com aviso em stderr (mudança da 1.1.28) |
| `--model` | ids do §1.5 |
| `--effort` | `low` \| `medium` \| `high` |
| `--mode` | `accept-edits` \| `plan` |
| `--dangerously-skip-permissions` | auto-aprova tudo (equivalente ao yolo) |
| `--agent` | escolhe agente/persona da sessão |
| `--add-dir` | repetível — workspace multi-raiz |
| `-c, --continue` | continua a conversa mais recente |
| `--conversation <ID>` | retoma por ID |
| `--project` / `--new-project` | agrupamento por projeto |
| `--sandbox` | §4 |
| `--disable-slash-commands` | desliga expansão de slash/skill em print mode |
| `--log-file` | redireciona `cli.log` |

Subcomandos: `agent(s)`, `models`, `mcp`, `plugin(s)`, `changelog`, `install`, `update`, `remote-control`, `mic-serve`, `help`.

Vantagens objetivas do `agy` sobre o `gemini` para a ADE: `--json-schema` (saída estruturada nativa — serve direto ao `research-finding.schema.json` e ao `visual-eval.schema.json` da spec), `--input-format stream-json` (multi-turno headless sem relançar processo), `--print-timeout` com saída parcial em vez de falha, e `denied_actions` no JSON quando o agente foi impedido de agir (1.1.27). [verificado: `agy --help` + `agy changelog`]

## 3. Sessões e fidelidade headless → interativo (decisão 3)

### Gemini CLI

| Recurso | Como |
| :--- | :--- |
| Resume | `-r/--resume latest` \| `--resume <índice>` \| `--resume <UUID>`; `--list-sessions`; `--delete-session <n>` |
| Retomar com prompt novo | `gemini -r "latest" "Check for type errors"` — **exatamente o gesto "assumir terminal" da spec §5** |
| Sessão explícita | `--session-id <UUID>` (nasce com id escolhido pelo engine) e `--session-file <json>` |
| Onde | `~/.gemini/tmp/<project_hash>/chats/`; sessões são **por diretório de projeto** |
| O que persiste | prompts, respostas, execuções de ferramenta (entrada e saída), tokens (input/output/cached), thoughts |
| Checkpointing | snapshot Git em repo-sombra `~/.gemini/history/<project_hash>` antes de toda escrita; restaura com `/restore`. **Desabilitado por default**, só via `settings.json` — a flag `--checkpointing` foi removida na 0.11.0 |
| Rewind | `/rewind` (ou `Esc Esc`) volta a um turno anterior e opcionalmente reverte arquivos |

`--session-id` é o achado que mais importa: o engine da ADE pode **cunhar o UUID** e gravá-lo no journal antes do `step_intent`, em vez de descobri-lo depois pelo `session_id` do JSON. [verificado: `gemini --help` + docs/cli/session-management.md]

O checkpointing nativo do Gemini **não substitui** o `tree_before`/`tree_after` do runtime da ADE (repo-sombra separado, granularidade por tool call, restauração interativa). Recomendação: deixar desligado e manter o checkpoint da ADE como única fonte. [inferido]

### Antigravity CLI

`-c/--continue` (conversa mais recente do workspace, com fallback para pai/filho depois da correção 1.2.1) e `--conversation <ID>`. Conversas em SQLite (`conversation_summaries.db`) sob `~/.gemini/antigravity-cli/`. Não expõe `--session-id` para cunhar id previamente; o id sai no `init`/`result`. [verificado: help + filesystem + changelog 1.2.1]

## 4. Sandbox (decisão 4)

**Gemini CLI**: precedência (1) `-s/--sandbox`, (2) env `GEMINI_SANDBOX=true|docker|podman|sandbox-exec|runsc|lxc`, (3) `settings.json` → `{"tools": {"sandbox": "docker"}}`. A flag é booleana; **quem escolhe o motor é a env var ou o settings**. macOS Seatbelt via `sandbox-exec` (perfil default `permissive-open`). [verificado: docs/cli/sandbox.md + `gemini --help`]

**Windows: sem sandbox nativo.** Não há Seatbelt; sobra Docker/Podman, que exige Desktop rodando e quebra o modelo de worktrees locais da ADE. `[inferido: a lista de motores não contém nenhuma opção nativa de Windows]`

**Antigravity CLI**: `--sandbox` = "Run in a sandbox with terminal restrictions enabled"; também `enableTerminalSandbox` no `config.json` (nesta máquina está `false`) e o preset `proceed-in-sandbox` em `toolPermission`. É restrição de terminal no próprio processo, não container. [verificado: `agy --help`, docs/cli/reference, `~/.gemini/config/config.json` local]

Consequência para a ADE: o isolamento em Windows continua sendo **`contain` + worktree**, como a spec já define. Nenhuma das duas CLIs entrega sandbox de SO utilizável aqui. [inferido]

## 5. Extensibilidade (decisão 5)

| Recurso | Gemini CLI 0.59.0 | Antigravity CLI 1.2.3 |
| :--- | :--- | :--- |
| Contexto de projeto | `GEMINI.md` (+ `/memory reload`); `.gemini/` e alias `.agents/` | herda `~/.gemini/`; `AGENTS.md`/`GEMINI.md` não confirmado `[hipótese]` |
| **Agent Skills** | **Sim, padrão `SKILL.md` de agentskills.io.** Tiers (menor→maior precedência): built-in → extensões → user (`~/.gemini/skills/` ou `~/.agents/skills/`) → workspace (`.gemini/skills/` ou `.agents/skills/`). Ativação pelo tool `activate_skill`, com consentimento. CLI: `gemini skills list/install/link/enable/disable/uninstall [--scope user\|workspace] [--consent]` | Sim: `/skills`, skills "ambient", frontmatter `skills` em agentes custom; correção específica de path `\` no Windows na 1.1.25 |
| Hooks | **Sim.** Eventos: `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeModel`, `AfterModel`, `BeforeToolSelection`, `BeforeTool`, `AfterTool`, `PreCompress`, `Notification`. JSON estrito por stdin/stdout, log só em stderr. `gemini hooks migrate` importa hooks do **Claude Code** | Sim: `/hooks`, `hooks.json`, hooks embutidos em plugins, prompt hooks e post-invocation hooks |
| Extensões / plugins | `gemini extensions install/uninstall/list/update/enable/disable/link/new/validate/config`, `--ref <branch\|tag\|commit>`, `--auto-update` | `agy plugin install/uninstall/list/enable/disable/validate/link` + **`agy plugin import gemini\|claude`** (importa plugins do Gemini CLI e do Claude Code) |
| MCP | `gemini mcp add <nome> <cmd\|url> [--transport http] [--env K=V] [--scope user] [--include-tools a,b]`, `remove/list/enable/disable`; `--allowed-mcp-server-names` | `agy mcp add/remove/list/enable/disable`; `mcp_config.json` com JSONC (comentários e trailing commas aceitos desde 1.1.24); MCP de plugin é namespaced `<plugin>_<server>` |
| Subagentes | **Sim**, nativos. Expostos ao agente principal como tool de mesmo nome; delegação automática ou forçada com `@nome`. Built-in: `codebase_investigator`. Override em `settings.json` → `agents.overrides`. Contexto próprio | **Sim**, mais completos: agentes custom em Markdown com frontmatter (`skills`, `agents`, `enable_mcp_tools`, `excludeDefaultComponents`), **git worktrees automáticas** em `.system_generated/worktrees`, painel `/agents`, `/teamwork-preview` |
| Slash commands custom | Sim (`/commands list`, `/commands reload`, `docs/cli/custom-commands.md`) | Sim (`--disable-slash-commands` desliga em print mode) |
| ACP | **Sim**: `--acp` (`--experimental-acp` deprecado). JSON-RPC 2.0 sobre stdio; Gemini CLI está no ACP Agent Registry; MCP pode ser exposto pelo cliente ACP | Não documentado `[hipótese: ausente]` |
| Policy Engine | `--policy` / `--admin-policy` (arquivos ou diretórios); substitui `--allowed-tools` | `/permissions`, `toolPermission` (`request-review`, `proceed-in-sandbox`, `always-proceed`, `strict`), regras `command(...)`, `read_file(...)`, `read_url(...)` |
| Worktrees | `-w/--worktree` com `experimental.worktrees: true` | automáticas por subagente |
| Extra | roteamento local: `gemini gemma setup/start/stop/status/logs` (LiteRT-LM) | `remote-control start/status/stop` (daemon de serviço do SO), `mic-serve`, `/voice` |

O ponto mais relevante para a ADE: **as duas CLIs consomem `SKILL.md`**. O catálogo da §9 da spec (`~/.ade/catalog/`) serve às três famílias sem tradução, e o `agy plugin import claude` mostra que a Google assume compatibilidade com o ecossistema do Claude Code. [verificado]

## 6. Multimodal (decisão 6)

| Capacidade | Situação |
| :--- | :--- |
| Imagem/PDF/áudio de **entrada** | Sim no Gemini CLI: `read_file` "Supports text, images, audio, and PDF"; `@arquivo` dispara `read_many_files` [verificado: docs/reference/tools.md] |
| Colar mídia | `Ctrl+V` "Paste media" no `agy` [verificado: docs/cli/reference] |
| **Geração** de imagem (Nano Banana / gemini-image) | **Não existe tool nativa em nenhuma das duas.** Busca de código no repo `gemini-cli` por `generate_image` e `nano-banana`: 0 resultados. Nenhuma tool de geração na lista oficial de tools [verificado: `gh api search/code`, docs/reference/tools.md] |
| Vídeo | Nenhuma tool. Existe `webm_encoder.exe` em `~/.gemini/antigravity*/bin` — é gravação de trajetória/telemetria, não geração [inferido: nome + contexto do diretório] |

Conclusão: a decisão da spec §10 de usar `$imagegen` do **Codex** para assets fica de pé. Gemini/Antigravity entram só como **leitores** de imagem — o que é exatamente o que o avaliador do loop visual precisa (receber screenshots e devolver JSON com rubrica). [inferido]

## 7. Telemetria e tokens (decisão 7)

**Gemini CLI**: OpenTelemetry embutido (logs, métricas, traces), configurado **só por `settings.json` + env**, sem flag `--telemetry` na 0.59.0:

| Setting | Env | Default |
| :--- | :--- | :--- |
| `enabled` | `GEMINI_TELEMETRY_ENABLED` | `false` |
| `traces` | `GEMINI_TELEMETRY_TRACES_ENABLED` | `false` |
| `target` | `GEMINI_TELEMETRY_TARGET` | `local` (`gcp` opcional) |
| `otlpEndpoint` | `GEMINI_TELEMETRY_OTLP_ENDPOINT` | `http://localhost:4317` |
| `otlpProtocol` | `GEMINI_TELEMETRY_OTLP_PROTOCOL` | `grpc` (ou `http`) |
| `outfile` | `GEMINI_TELEMETRY_OUTFILE` | — (sobrepõe o endpoint) |
| `logPrompts` | `GEMINI_TELEMETRY_LOG_PROMPTS` | `true` |
| `useCollector` | `GEMINI_TELEMETRY_USE_COLLECTOR` | `false` |
| `useCliAuth` | `GEMINI_TELEMETRY_USE_CLI_AUTH` | `false` |
| — | `GEMINI_CLI_SURFACE` | rótulo de tráfego |

[verificado: docs/cli/telemetry.md]

Para a ADE, **OTel é excesso**: os campos de `StreamStats` (§2.2) já dão tokens por modelo, `duration_ms` e `tool_calls` diretamente no stdout, sem coletor. Usar OTel só se algum dia o painel precisar de traces distribuídos. `logPrompts: true` por default é um risco de vazamento se alguém ligar telemetria com `target: gcp` — o `ade doctor` deve checar. [inferido]

`/stats` mostra uso e economia de cache na sessão interativa. **Token caching não funciona com OAuth** (Code Assist API não suporta cached content) — só com `GEMINI_API_KEY` ou Vertex AI. [verificado: docs/cli/token-caching.md]

**Antigravity CLI**: sem OTel documentado; telemetria própria para `daily-cloudcode-pa.googleapis.com` (`recordTrajectoryAnalytics`, visível no `cli.log` local). Métricas de token aparecem na "token metrics table" da verbosidade. `/credits` mostra consumo. [verificado: cli.log local + docs/cli/reference]

## 8. Contexto e custo (decisão 8)

| Item | Valor |
| :--- | :--- |
| Janela de contexto Gemini CLI | **1.048.576 tokens** (`DEFAULT_TOKEN_LIMIT = 1_048_576`) para `gemini-2.5-pro/flash/flash-lite`, os preview de Gemini 3 e os Gemma listados; o `default` do switch é o mesmo valor [verificado: `packages/core/src/core/tokenLimits.ts`] |
| Janela do `agy` | **Não publicada** [hipótese: igual ou maior, herdado do mesmo backend] |
| Compactação | Existe: hook `PreCompress` dispara "Before context compression" [verificado: docs/hooks/index.md]. Parâmetros de threshold não documentados nos arquivos lidos |
| Fallback por cota | Ao estourar o limite diário de Gemini 3 Pro, o CLI oferece trocar para 2.5 Pro, fazer upgrade ou parar; 2.5 Pro → 2.5 Flash. Em sobrecarga de capacidade, oferece "Keep trying" com backoff exponencial [verificado: docs/get-started/gemini-3.md] |
| Cota Gemini CLI (doc viva, ver conflito §1.2) | Code Assist Individual 1.000 req/dia; AI Pro 1.500; AI Ultra 2.000; API key free 250 (só Flash); Code Assist Standard 1.500; Enterprise 2.000 |
| Cota Antigravity | Pro/Ultra: "refreshed every five hours until weekly limit reached"; demais: "refreshed weekly". Números não publicados. Créditos G1 como fallback (`useG1Credits`) |
| Custo em USD | **Nenhuma das duas reporta.** Contabilidade da ADE fica em tokens + aviso de custo desconhecido |

Ponto de atenção: fallback automático de modelo significa que o `model` do evento `init` pode **não** ser o modelo que respondeu. O adapter deve ler o breakdown `stats.models` do evento `result`, que é por-modelo, e registrar o modelo efetivo no journal. [verificado: types.ts + model.md, que avisa que `--model` não sobrepõe o modelo dos subagentes]

## 9. Pesquisa: `google_web_search` vale alguma coisa? (decisão 9)

Tool nativa `google_web_search(query)`. Comportamento declarado: **grounding** — "Returns a generated summary based on search results", com "source URIs and titles for factual grounding", e "The Gemini API processes the search results before returning a synthesized response to the agent". Complementa `web_fetch(url)`, que valida a URL contra faixas de IP privadas/reservadas e exige confirmação explícita em Plan Mode. [verificado: docs/tools/web-search.md, docs/tools/web-fetch.md, docs/reference/tools.md]

Vantagem real para o papel de pesquisa da ADE (§8):

1. **Grounding com citação vem de fábrica**, no mesmo formato que o `research-finding.schema.json` pede (evidência com URL). Claude Code e Codex também pesquisam, mas o caminho Google→Gemini é o único em que o provedor do modelo é o dono do índice. [inferido]
2. **Custo baixo**: `gemini-3.8-flash-low` / `flash-lite` para varredura, `pro` só para síntese.
3. **Contexto de 1M** permite despejar páginas inteiras sem compactar.
4. `web_fetch` já bloqueia SSRF contra IP privado — alinhado com a regra da §8 de tratar achado como conteúdo não confiável. [verificado]

Contra: a resposta é **sintetizada pela API antes de chegar ao agente**, ou seja, há uma camada de sumarização não auditável entre a página e o achado. Para pesquisa que decide arquitetura, o adapter deve exigir que o agente traga **URL + trecho literal**, não só o resumo. [inferido]

## 10. CapabilitySet proposto (JSON)

```json
{
  "gemini": {
    "family": "gemini",
    "binary": "gemini",
    "binaryWindows": "gemini.cmd",
    "version": "0.59.0",
    "verifiedAt": "2026-09-16",
    "status": "degraded",
    "statusReason": "Acesso consumidor (AI Pro/Ultra/Code Assist for individuals) encerrado em 2026-06-18. Só utilizável com GEMINI_API_KEY, Vertex AI ou licenca Code Assist Standard/Enterprise.",
    "auth": {
      "methods": ["gemini-api-key", "vertex-ai", "code-assist-standard", "code-assist-enterprise"],
      "deprecated": ["oauth-personal"],
      "envVars": ["GEMINI_API_KEY", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
      "settingsPath": "~/.gemini/settings.json",
      "detect": "~/.gemini/google_accounts.json .active === null => sem conta consumidora ativa"
    },
    "headless": {
      "promptFlag": "-p",
      "stdin": true,
      "stdinAppendsToPrompt": true,
      "outputFormats": ["text", "json", "stream-json"],
      "outputFormatFlag": "--output-format",
      "approvalFlag": "--approval-mode",
      "approvalValues": ["default", "auto_edit", "yolo", "plan"],
      "yoloFlagDeprecated": "-y",
      "modelFlag": "-m",
      "workspaceFlags": ["--include-directories"],
      "trustFlag": "--skip-trust",
      "policyFlags": ["--policy", "--admin-policy"],
      "removedFlags": ["--all-files", "--telemetry", "--checkpointing"],
      "exitCodes": { "0": "ok", "1": "erro", "42": "entrada invalida", "53": "limite de turnos" }
    },
    "streamEvents": ["init", "message", "tool_use", "tool_result", "error", "result"],
    "usageFields": {
      "json": ["session_id", "response", "stats", "error", "warnings"],
      "streamResult": ["total_tokens", "input_tokens", "output_tokens", "cached", "input", "duration_ms", "tool_calls", "models"]
    },
    "cost": { "usd": "unknown", "tokens": true, "cacheWithOAuth": false },
    "session": {
      "resumeFlags": ["--resume", "-r"],
      "resumeValues": ["latest", "<indice>", "<uuid>"],
      "presetIdFlag": "--session-id",
      "loadFileFlag": "--session-file",
      "listFlag": "--list-sessions",
      "deleteFlag": "--delete-session",
      "store": "~/.gemini/tmp/<project_hash>/chats/",
      "resumeWithNewPrompt": true,
      "checkpointing": { "flag": null, "settingsOnly": true, "shadowGit": "~/.gemini/history/<project_hash>" }
    },
    "sandbox": {
      "flag": "-s",
      "engineEnv": "GEMINI_SANDBOX",
      "engines": ["docker", "podman", "sandbox-exec", "runsc", "lxc"],
      "windowsNative": false
    },
    "extensibility": {
      "contextFile": "GEMINI.md",
      "skills": true,
      "skillFormat": "SKILL.md",
      "skillDirs": ["~/.gemini/skills", "~/.agents/skills", ".gemini/skills", ".agents/skills"],
      "skillsCli": "gemini skills install|link|list|enable|disable|uninstall",
      "hooks": true,
      "hookEvents": ["SessionStart", "SessionEnd", "BeforeAgent", "AfterAgent", "BeforeModel", "AfterModel", "BeforeToolSelection", "BeforeTool", "AfterTool", "PreCompress", "Notification"],
      "hookMigrateFromClaude": "gemini hooks migrate",
      "mcp": { "cli": "gemini mcp add|remove|list|enable|disable", "transports": ["stdio", "http"] },
      "subagents": { "builtin": ["codebase_investigator"], "forceSyntax": "@nome", "override": "settings.json agents.overrides" },
      "acp": "--acp",
      "customCommands": true,
      "worktree": { "flag": "-w", "requires": "experimental.worktrees=true" },
      "localModels": "gemini gemma (LiteRT-LM)"
    },
    "multimodal": { "imageInput": true, "pdfInput": true, "audioInput": true, "imageGeneration": false, "video": false },
    "context": { "tokens": 1048576, "compaction": true, "compactionHook": "PreCompress" },
    "research": { "webSearchTool": "google_web_search", "grounded": true, "citations": true, "webFetchTool": "web_fetch", "ssrfGuard": true },
    "telemetry": { "otel": true, "flag": null, "settingsKey": "telemetry", "envPrefix": "GEMINI_TELEMETRY_" },
    "models": ["auto", "pro", "flash", "flash-lite", "gemini-3.1-pro-preview", "gemini-3-pro-preview", "gemini-3-flash-preview", "gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
    "roles": ["research", "large-context-read", "third-opinion"]
  },

  "antigravity": {
    "family": "gemini",
    "binary": "agy",
    "binaryWindows": "agy.EXE",
    "version": "1.2.3",
    "verifiedAt": "2026-09-16",
    "status": "available",
    "installPathWindows": "C:\\Users\\<user>\\AppData\\Local\\agy\\bin",
    "installPathUnix": "~/.local/bin/agy",
    "install": {
      "windowsPowershell": "irm https://antigravity.google/cli/install.ps1 | iex",
      "windowsCmd": "curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd",
      "unix": "curl -fsSL https://antigravity.google/cli/install.sh | bash",
      "pathSetup": "agy install"
    },
    "auth": {
      "methods": ["google-account-keyring", "gemini-api-key"],
      "apiKeySettings": { "modelProvider": "gemini", "env": "GEMINI_API_KEY" },
      "baseUrlEnv": "GOOGLE_GEMINI_BASE_URL",
      "settingsPath": "~/.gemini/antigravity-cli/settings.json",
      "sharedConfig": "~/.gemini/config/config.json"
    },
    "headless": {
      "promptFlag": "-p",
      "promptAliases": ["--print", "--prompt"],
      "stdin": true,
      "outputFormats": ["text", "json", "stream-json"],
      "inputFormats": ["text", "stream-json"],
      "inputFormatFlag": "--input-format",
      "structuredOutputFlag": "--json-schema",
      "timeoutFlag": "--print-timeout",
      "timeoutDefault": "5m0s",
      "timeoutReturnsPartial": true,
      "yoloFlag": "--dangerously-skip-permissions",
      "modeFlag": "--mode",
      "modeValues": ["accept-edits", "plan"],
      "effortFlag": "--effort",
      "effortValues": ["low", "medium", "high"],
      "workspaceFlags": ["--add-dir"],
      "agentFlag": "--agent",
      "deniedActionsInJson": true
    },
    "cost": { "usd": "unknown", "tokens": true, "credits": "G1", "creditsSetting": "useG1Credits", "creditsPanel": "/credits" },
    "session": {
      "continueFlag": "-c",
      "resumeFlag": "--conversation",
      "presetIdFlag": null,
      "projectFlags": ["--project", "--new-project"],
      "store": "~/.gemini/antigravity-cli/conversations + conversation_summaries.db"
    },
    "sandbox": { "flag": "--sandbox", "type": "terminal-restrictions", "settingsKey": "enableTerminalSandbox", "permissionPreset": "proceed-in-sandbox", "containers": false },
    "extensibility": {
      "skills": true,
      "skillFormat": "SKILL.md",
      "hooks": true,
      "hooksFile": "hooks.json",
      "plugins": "agy plugin install|uninstall|list|enable|disable|validate",
      "pluginImport": ["gemini", "claude"],
      "mcp": { "cli": "agy mcp add|remove|list|enable|disable", "configFile": "mcp_config.json", "jsonc": true, "pluginNamespacing": "<plugin>_<server>" },
      "subagents": { "markdownFrontmatter": ["skills", "agents", "enable_mcp_tools", "excludeDefaultComponents"], "autoWorktrees": ".system_generated/worktrees", "panel": "/agents" },
      "acp": false,
      "remoteControl": "agy remote-control start|status|stop"
    },
    "multimodal": { "imageInput": true, "pasteMedia": "Ctrl+V", "imageGeneration": false, "video": false, "voiceInput": "/voice" },
    "context": { "tokens": null, "compaction": true },
    "telemetry": { "otel": false, "vendor": "daily-cloudcode-pa.googleapis.com" },
    "models": [
      "gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low",
      "gemini-3.7-flash-high", "gemini-3.7-flash-medium", "gemini-3.7-flash-low",
      "gemini-3.6-flash-high", "gemini-3.6-flash-medium", "gemini-3.6-flash-low",
      "gemini-3.1-pro-high", "gemini-3.1-pro-low",
      "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"
    ],
    "foreignModels": ["claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"],
    "foreignModelsRequireUltra": true,
    "roles": ["research", "large-context-read", "third-opinion", "visual-evaluator"]
  }
}
```

Regra derivada para o engine: `familyOf(run) = familyOfModel(model_id)`, **não** `familyOfBinary`. Um `agy --model claude-opus-4-6-thinking` como Checker de um Maker Claude viola Maker ≠ Checker. O adapter deve recusar ids em `foreignModels` quando o papel exigir família distinta. [inferido, mas é bug garantido se ignorado]

## 11. Veredito

**A família Gemini entra na v1 da ADE: SIM, condicional.** Condições:

1. **O binário é `agy`, não `gemini` nem `antigravity`.** O `ade doctor` procura, em ordem: `agy` no PATH → `gemini` com auth não-consumidora (`GEMINI_API_KEY`/Vertex/Code Assist) → família indisponível. Nunca procurar `antigravity`.
2. **Papel restrito ao que a spec §13 já previa**: time de pesquisa (§8), leitura de base grande, terceira opinião. Não é Maker padrão nem Checker padrão.
3. **Roteamento por model id**, não por binário (§10), sob pena de quebrar Maker ≠ Checker.
4. **Custo sempre `unknown`** — nenhuma das duas reporta USD; a ADE contabiliza tokens e emite aviso, como a §5 já manda.
5. **Degradação obrigatória**: com Gemini indisponível (sem `agy`, sem API key), o roteamento cai para Claude + Codex mantendo Maker ≠ Checker. A §16 já prevê; a mudança é que o risco é **menor** do que a spec supõe, porque o `agy` está instalado e funcionando.

Por quê "sim": o `agy` entrega, hoje, coisas que os outros dois não entregam de graça — `--json-schema` (saída estruturada nativa, que mata o parser frágil de JSON dos achados de pesquisa), `--input-format stream-json` (multi-turno headless num processo só), `google_web_search` com grounding do dono do índice, contexto de 1M no lado Gemini CLI, e um catálogo de modelos que inclui GPT-OSS e Claude como quarta opinião barata. Por quê "condicional": é closed-source, com cota não publicada, sem ACP, sem custo em USD, e com histórico documentado de cortar limite do tier gratuito sem aviso — dependência frágil demais para carregar papel crítico do pipeline.

## 12. Riscos novos para a §16 da spec

| Risco | Evidência | Mitigação |
| :--- | :--- | :--- |
| Adapter procura binário `antigravity` e nunca acha | `which antigravity` falha; o binário é `agy` | Corrigir §5; detectar `agy` |
| Cross-review falso (agy servindo Claude/GPT) | `agy models` lista `claude-opus-4-6-thinking` | Família por model id |
| Cota do `agy` não publicada e historicamente cortada | "primarily determined to the degree we have capacity" | Orçamento por lote + escalação quando a cota estourar; nunca pôr o Gemini no caminho crítico |
| Doc do Gemini CLI contradiz o blog oficial sobre acesso consumidor | §1.2 | `ade doctor` testa auth de verdade em vez de confiar em doc |
| `cli-reference.md` atrasado em relação ao binário | §2.1 | Adapter valida flags contra `--help` da versão instalada; teste de fixture quebra quando o help muda |
| `logPrompts: true` por default se alguém ligar telemetria GCP | §7 | Passe do `ade doctor` |
| Fallback silencioso de modelo por cota | §8 | Registrar `stats.models` (modelo efetivo) no journal, não o modelo pedido |

## Fontes

**Primárias — execução local (2026-09-16)**
- `gemini --version` → `0.59.0`; `gemini --help`; `gemini skills|hooks|extensions|mcp|gemma --help`
- `gemini -p "responda apenas OK" --output-format json` → `Opening authentication page in your browser. Do you want to continue? [Y/n]:` (exit 0, sem chamada de modelo)
- `agy --version` → `1.2.3`; `agy --help`; `agy help mcp|plugin|install|update|remote-control|changelog`; `agy models`; `agy agents`; `agy plugin list`; `agy mcp list`; `agy changelog`
- `C:\Users\Erick\AppData\Local\agy\bin\agy.EXE` (195.186.840 bytes, 2026-09-15)
- `C:\Users\Erick\.gemini\settings.json`, `google_accounts.json`, `config\config.json`, `antigravity-cli\settings.json`, `antigravity-cli\cli.log`

**Primárias — código e docs do repositório (main, 2026-09-16, via `gh api`)**
- https://github.com/google-gemini/gemini-cli
- `packages/cli/src/ui/utils/antigravityUtils.ts`, `packages/cli/src/ui/hooks/useBanner.ts`
- `packages/core/src/output/types.ts`, `packages/core/src/core/tokenLimits.ts`
- `packages/core/src/skills/builtin/antigravity-support/SKILL.md`
- `docs/get-started/authentication.mdx`, `docs/get-started/gemini-3.md`
- `docs/cli/cli-reference.md`, `headless.md`, `sandbox.md`, `session-management.md`, `checkpointing.md`, `rewind.md`, `skills.md`, `telemetry.md`, `model.md`, `token-caching.md`, `acp-mode.md`
- `docs/core/subagents.md`, `docs/hooks/index.md`, `docs/reference/tools.md`, `docs/tools/web-search.md`, `docs/tools/web-fetch.md`, `docs/resources/quota-and-pricing.md`, `docs/changelogs/index.md`

**Primárias — web oficial**
- https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/ (2026-05-19)
- https://antigravity.google/
- https://antigravity.google/docs/cli/getting-started
- https://antigravity.google/docs/cli/install
- https://antigravity.google/docs/cli/reference
- https://antigravity.google/docs/plans/
- https://antigravity.google/docs/cli/credits/
- https://agentskills.io (padrão Agent Skills citado pela doc do Gemini CLI)
- https://agentclientprotocol.com/get-started/introduction e /registry

**Secundárias (usadas só para localizar o anúncio; nenhuma afirmação deste documento se apoia nelas)**
- https://www.theregister.com/ai-ml/2026/05/20/bye-bye-gemini-cli-google-nudges-devs-toward-antigravity/5243605
- https://github.com/google-gemini/gemini-cli/discussions/22970
