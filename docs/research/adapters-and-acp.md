# Adapter genérico da ADE: ACP vs. bespoke, e o 4º provider

Pesquisa de 2026-09-16. Fontes primárias: `agentclientprotocol.com`, repositório
`agentclientprotocol/agent-client-protocol` (schema em Rust), registry oficial em CDN, READMEs dos
adapters oficiais, docs do OpenCode, e `--help` das CLIs instaladas nesta máquina
(claude 2.1.271, codex-cli 0.154.0, gemini 0.59.0).

## 0. Respostas

| # | Decisão | Resposta |
| :--- | :--- | :--- |
| 1 | Forma do adapter | **Híbrido com ACP como transporte primário** e bespoke apenas para (a) PTY de takeover e (b) structured output do tradutor. Não é "ACP quando disponível": é ACP sempre, porque os três providers da v1 já têm servidor ACP oficial. |
| 2 | 4º provider | **OpenCode** (`anomalyco/opencode`, MIT, 1.18.30). Único candidato que é aberto, provider-agnóstico de verdade (75+ providers) e reporta **custo em USD real** por mensagem. |
| 3 | CapabilitySet | 12 chaves, seção 7. Some `spawn/parseEvents/costOf` da spec §5 — vira `launch` + normalizador único de eventos ACP. |

Três coisas na spec v2 estão desatualizadas e mudam a arquitetura: ACP cobre muito mais do que o
prompt supunha (§8), o "assumir o terminal" não precisa de checkpoint + relançamento (§4.3), e o
registry oficial elimina a detecção manual de binários do `ade doctor` (§3.4).

---

## 1. ACP — o que é, hoje

| Item | Valor | Confiança |
| :--- | :--- | :--- |
| Repositório | `agentclientprotocol/agent-client-protocol` (o `zed-industries/...` do prompt **redireciona**; o projeto saiu da Zed para org própria, com GOVERNANCE.md, MAINTAINERS.md, processo de RFD e lead maintainer nomeado) | [verificado: `gh repo view`, 2026-09-16] |
| Licença / estrelas / atividade | Apache-2.0, 4.251 estrelas, criado 2025-06-23, último push 2026-09-15 | [verificado: GitHub API] |
| Transporte | JSON-RPC 2.0 sobre stdio (subprocesso). HTTP/WebSocket em working group, ainda WIP | [verificado: docs/get-started, docs/protocol/v1/transports] |
| Versão do schema | **v1.21.0** (2026-08-20) estável; crate Rust v1.7.0; **v2.0.0-alpha.3** em draft | [verificado: releases do repo] |
| SDK TypeScript | `@agentclientprotocol/sdk` **1.4.0**, Apache-2.0, **zero dependências**, APIs `agent()` e `client()` (as classes `AgentSideConnection`/`ClientSideConnection` estão deprecadas) | [verificado: registry.npmjs.org + docs/libraries/typescript] |
| Registry | `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` — **41 entradas** com `id`, `version`, `license`, `distribution` (npx/uvx/binário por plataforma com sha256), ícone | [verificado: baixado 2026-09-16] |

Nota de divergência: a página `get-started/registry` diz "60+ agents"; o JSON servido tem 41. Use o
JSON, não a página. [verificado: ambos]

### 1.1 O que o protocolo padroniza (v1 estável)

- **Métodos do agente:** `initialize`, `authenticate`, `session/new`, `session/prompt` (baseline);
  `session/load`, `session/resume`, `session/list`, `session/delete`, `session/fork`,
  `session/close`, `session/set_mode`, `session/set_config_option`, `logout` (opcionais, por
  capability). Notificação `session/cancel`.
- **Métodos do cliente:** `session/request_permission` (baseline); `fs/read_text_file`,
  `fs/write_text_file`, `terminal/create|output|wait_for_exit|kill|release`, `elicitation/create`
  (opcionais). Notificação `session/update`.
- **Negociação de capacidades** no `initialize`, em ambos os sentidos. `AgentCapabilities` traz
  `loadSession`, `promptCapabilities`, `mcpCapabilities`, `sessionCapabilities` (com `list`,
  `delete`, `additionalDirectories`, `resume`, `close`, `fork`), `auth`.
  [verificado: `agent-client-protocol-schema/src/v1/agent.rs`]
- **Conteúdo:** blocos `text`, `image`, `audio`, `resource` (embutido) e `resource_link`, nos dois
  sentidos. Gates: `promptCapabilities.image`, `.audio`, `.embeddedContext`.
  [verificado: `src/v1/agent.rs` + docs/protocol/v1/content]
- **Tool calls:** `toolCallId`, `title`, `kind` (`read|edit|delete|move|search|execute|think|fetch|other`),
  `status` (`pending|in_progress|completed|failed`), `content` (incluindo diff e referência a
  terminal), `locations`, `rawInput`, `rawOutput`.
- **Permissões:** `session/request_permission` com opções `allow_once|allow_always|reject_once|reject_always`.
- **File system:** o **cliente** implementa `fs/*`; o agente chama. Motivo declarado: estado não
  salvo do editor, rastreio de modificações e sandboxing pelo cliente.
- **Terminais:** o **agente** pede (`terminal/create`), o **cliente executa** no seu ambiente e
  devolve saída (com `outputByteLimit`). É execução remota de comando — **não** há canal de entrada
  humana. [verificado: docs/protocol/v1/terminals]
- **Uso/custo:** notificação `usage_update` com `used` (tokens em contexto), `size` (janela) e
  `cost` opcional `{ amount: f64, currency: ISO-4217 }`. Estável desde 2026-06-05.
  [verificado: `src/v1/client.rs`, structs `UsageUpdate` e `Cost`]
- **Config de sessão:** lista arbitrária de opções com `id`, `name`, `type` (`select|boolean`),
  `currentValue`, `options` e **`category`** — sendo as categorias relevantes `model`, `model_config`
  e **`thought_level`** (nível de raciocínio/effort). Set pelo cliente via `session/set_config_option`;
  mudança do agente vem por `session/update` → `config_option_update`.
  [verificado: `SessionConfigOptionCategory` em `src/v1/agent.rs:2294`]
- **Stop reasons:** `end_turn`, `max_tokens`, `max_turn_requests`, `refusal`, `cancelled`.
- **Extensibilidade:** campo `_meta` em praticamente todo objeto, reservado para extensões de
  fornecedor — é a válvula de escape oficial do protocolo.

### 1.2 O que o ACP **não** cobre

Grep no schema v1 confirma ausência total de:

| Ausente | Evidência | Consequência para a ADE |
| :--- | :--- | :--- |
| **Allowlist/denylist de ferramentas** | zero ocorrências de `allowed_tools`/`allowlist` no schema | A política de ferramentas vira `session/request_permission` respondido automaticamente pelo cliente (a ADE decide) ou modo de sessão. `--allowedTools` do Claude só passa por `_meta`. |
| **Sandbox** | zero ocorrências de `sandbox` no schema | Expresso como *session mode* definido pelo agente (`read-only`/`agent`/`agent-full-access` no codex-acp). Não é portável: os ids de modo são do fornecedor. |
| **Structured output (schema da resposta final)** | nada equivalente a `--output-schema`; `elicitation` é o inverso (estrutura pedida ao **usuário**) | O tradutor de intenção não pode exigir `plan.schema.json` pelo protocolo. |
| **Breakdown de tokens por tipo** | struct `Usage` (`total/input/output/thought/cached_read/cached_write`) está marcada **UNSTABLE** no schema; só `UsageUpdate` (contexto + custo) é estável | Ranking "o que drena tokens" (spec §12) fica parcial no caminho ACP. |
| **PTY / entrada humana em terminal** | docs de terminals; terminal é agente→cliente | "Assumir o terminal" não sai do protocolo — mas há saída melhor (§4.3). |
| **Custo garantido** | `cost` é `Option<Cost>` | Mantém-se a regra do runtime: custo desconhecido avisa, não bloqueia. |

### 1.3 Quem implementa

A página `get-started/agents` lista **36 agentes com ACP nativo** e **4 via adapter**.
[verificado: agentclientprotocol.com/get-started/agents, 2026-09-16]

Para os providers que interessam, com o comando de lançamento exato do registry:

| Provider | Nativo? | Como se lança (registry) | Versão | Licença (registry) |
| :--- | :--- | :--- | :--- | :--- |
| Gemini CLI | **nativo** | `npx @google/gemini-cli --acp` | 0.59.0 | Apache-2.0 |
| Claude | adapter | `npx @agentclientprotocol/claude-agent-acp` | 0.78.0 | proprietary¹ |
| Codex | adapter | `npx @agentclientprotocol/codex-acp` | 1.12.0 | Apache-2.0 |
| **Google Antigravity** | adapter binário | `agy_acp_server.par` (inclui windows-x86_64 e aarch64) | 1.1.1 | proprietary |
| OpenCode | **nativo** | `opencode acp` | 1.18.30 | MIT |
| goose | **nativo** | `goose acp` | 1.50.0 | Apache-2.0 |
| Cursor | **nativo** | `cursor-agent acp` | 2026.09.10 | proprietary |
| GitHub Copilot CLI | **nativo** | `npx @github/copilot --acp` | 1.0.83 | proprietary |
| Amp (Sourcegraph) | adapter binário | `amp-acp` | 0.9.0 | Apache-2.0 |
| Kimi CLI | **nativo** | `kimi acp` | 1.50.0 | MIT |
| Qwen Code | **nativo** | `npx @qwen-code/qwen-code --acp --experimental-skills` | 0.23.3 | Apache-2.0 |
| Mistral Vibe | **nativo** | `vibe-acp` | 2.24.1 | Apache-2.0 |
| Cline | **nativo** | `npx cline --acp` | 3.0.61 | Apache-2.0 |
| Factory Droid | **nativo** | `npx droid exec --output-format acp-daemon` | 0.218.1 | proprietary |
| Kiro CLI | nativo (doc) | — (fora do registry) | — | proprietary |
| Pi | adapter | `npx pi-acp` | 0.0.33 | MIT |
| Aider | **não** | — | — | Apache-2.0 (repo sem push desde 2026-05-22) | 

¹ O npm publica `@agentclientprotocol/claude-agent-acp` sob **Apache-2.0**; o registry marca
`proprietary` — o adapter é Apache, o agente por trás (Claude Code / Agent SDK) não é.
[verificado: registry.npmjs.org + registry.json — divergência real, não erro de leitura]

**Claude Code não tem modo ACP nativo.** `claude --help` de 2.1.271 não expõe `--acp` nem
subcomando `acp`. [verificado: CLI local]

### 1.4 Maturidade — sinais concretos

A favor: schema em v1.21.0 com governança formal e processo de RFD; ~20 RFDs já estabilizados
(session resume, session list/delete, session usage, model config, logout, additional directories,
request cancellation, elicitation, registry, message id); SDKs 1.0 em cinco linguagens; registry com
sha256 por plataforma; adapters oficiais para Claude e Codex hospedados na própria org do protocolo.

Contra: **v2 em draft desde 2026-07-20** (alpha.3), com mudança de modelo (notificações fora do
turno, patch uniforme de mensagens, diffs estruturados no lugar de `oldText`/`newText`, permissões
com título obrigatório). O aviso do mantenedor é explícito: *"Don't ship it by default in production
until we are closer to stabilization"*, e *"v1-only peers will remain common for some time"*. Sem
data de deprecação da v1. [verificado: announcements/acp-v2-draft]

→ **Para a ADE: implementar v1, negociar versão no `initialize`, não tocar em v2 na v1 do produto.**

### 1.5 O que os adapters oficiais entregam além do papel

`codex-acp` (README): auth por ChatGPT **ou** API key **ou** gateway; configuração de **modelo,
reasoning effort, fast mode, approval e sandbox mode**; imagens, resource links, diretórios extras;
eventos de shell, mudança de arquivo, permissão, MCP, saída de terminal, reasoning, plano, web
search, **image generation**, **token usage** e review; subagentes ACP nativos; tarefas de terminal
em background; slash commands (`/review`, `/compact`, `/skills`, …). Env: `INITIAL_AGENT_MODE` =
`read-only|agent|agent-full-access`. Ele inicia o **Codex App Server**, não o `codex exec`.

`claude-agent-acp` (README + código): construído sobre o **Claude Agent SDK**; imagens, @-mentions,
permissões com opções editáveis, TODO lists, transcrições de subagente aninhadas, **terminais
interativos e em background**, slash commands, MCP do cliente; extensões `_meta` para goal,
falha de sessão, **valores recomendados de modelo e effort**, e apresentação de permissão.
Dois achados relevantes:

- **`_auth/status_update`**: o adapter sonda `claude auth status --json` e reporta a identidade em
  uso — `kind: "account" | "api_key" | "gateway" | "external" | "none"`, com `label` do tipo
  `"Claude Max"`. Ou seja, **o caminho ACP usa a assinatura local do usuário**, não exige chave de
  API. [verificado: `src/auth-status.ts`]
- **`_session/steering`**: request `{ sessionId, prompt }` que injeta uma mensagem **num turno em
  andamento**, com `outcome` `injected | startedNewTurn | promptRequired`. É exatamente o "usuário
  digitou enquanto o agente trabalhava". [verificado: `examples/steering.ts`]
- Opções específicas do Claude Code passam por `_meta.claudeCode.options.settings`, com precedência
  sobre a env `CLAUDE_MODEL_CONFIG`. [verificado: `docs/model-configuration.md`]

Isto é a prova de que o padrão "ACP + `_meta`" já é o modo como os próprios fornecedores resolvem
capacidade fora do protocolo. A ADE não estaria inventando um híbrido; estaria usando o previsto.

---

## 2. A alternativa bespoke: o que cada CLI dá hoje

Verificado nos binários instalados nesta máquina.

| Necessidade | `claude` 2.1.271 | `codex` 0.154.0 | `gemini` 0.59.0 |
| :--- | :--- | :--- | :--- |
| Headless | `-p/--print` | `codex exec` | `-p/--prompt` |
| Eventos JSON | `--output-format text\|json\|stream-json` + `--include-partial-messages` | `codex exec --json` (JSONL) | `-o text\|json\|stream-json` |
| Entrada streaming | `--input-format stream-json` | stdin / `-` | stdin |
| Resume | `-r/--resume [id]`, `--continue`, `--fork-session`, `--session-id <uuid>`, `--from-pr` | `codex exec resume <id>\|--last`, `codex exec fork`, `codex resume` | `-r/--resume latest\|N`, `--session-id`, `--session-file`, `--list-sessions` |
| Modelo | `--model` | `-m/--model`, `--oss`, `--local-provider` | `-m/--model` |
| Effort | **`--effort <level>`** | `-c model_reasoning_effort=...` | (sem flag) |
| Allowlist | `--allowedTools`, `--disallowed-tools`, `--permission-mode` | `-s read-only\|workspace-write\|danger-full-access`, `--approve-for-me` | `--approval-mode default\|auto_edit\|yolo\|plan`, `--policy` (Policy Engine; `--allowed-tools` **deprecado**) |
| Imagem in | via prompt/@path | **`-i/--image <FILE>...`** | via prompt |
| Structured output | não | **`--output-schema <FILE>`** | não |
| Worktree nativo | `--bg`/`claude agents` | `--worktree` | `-w/--worktree` |
| Sandbox | `--allow-dangerously-skip-permissions`, sandbox de SO | `codex sandbox`, `-s` | `-s/--sandbox` |
| Protocolo próprio | (nenhum público) | **`codex app-server`** (+ `generate-ts`, `generate-json-schema`) | `--acp` |

O bespoke funciona — é o que o tl-orchestrator faz. O custo é: três parsers de evento distintos,
três semânticas de resume, três vocabulários de permissão, e um contrato que muda a cada release de
CLI (o `--allowed-tools` do Gemini já está deprecado em favor do Policy Engine; o Codex trocou o eixo
para `app-server`). Cada quebra é silenciosa: JSONL continua parseando, só que sem os campos.

**O que só o bespoke dá:** `--output-schema` (Codex), `--effort` como flag direta, allowlist
declarativa por padrão de comando, e — decisivo — o processo rodando **dentro de um PTY que um humano
pode digitar**.

---

## 3. Decisão 1 — híbrido, com ACP como transporte primário

### 3.1 Cobertura, necessidade por necessidade

| Necessidade da ADE | ACP | Bespoke JSON | Veredito |
| :--- | :--- | :--- | :--- |
| Spawn headless | `initialize` + `session/new` + `session/prompt`; comando vem do registry | 3 formas diferentes | **ACP** |
| Prompt com anexos | blocos `image`/`audio`/`resource`/`resource_link`, com capability | só Codex tem `-i`; resto é @path | **ACP** |
| Eventos de ferramenta | `session/update` com `kind`, `status`, `locations`, diff | 3 esquemas | **ACP** |
| Resume | `session/load` (replay) **ou** `session/resume` (sem replay), por capability | 3 sintaxes; `codex exec resume`, `--fork-session` | **ACP**, com fallback |
| Custo/tokens | `usage_update`: contexto + custo opcional; breakdown UNSTABLE | Claude e Codex trazem usage no JSONL | **Empate** — ACP para o painel, bespoke para o ranking de tokens |
| Modelo / effort | config options `model` / `model_config` / `thought_level` + `session/set_config_option` | flags diretas | **ACP** (mas os *valores* são do fornecedor; ver §7) |
| Allowlist de ferramentas | ausente; substituído por `request_permission` que o cliente responde | flags declarativas | **Bespoke** no conceito, **ACP** na prática (a ADE decide a resposta e ainda ganha o log) |
| Sandbox | ausente; via *session mode* com ids do fornecedor | flags declarativas | **Bespoke** |
| Imagens in/out | sim, nos dois sentidos | irregular | **ACP** |
| Structured output | **ausente** | `--output-schema` (Codex) | **Bespoke** |
| Cancelamento | `session/cancel` + stop reason `cancelled` | SIGINT e torcer | **ACP** |
| PTY para "assumir" | **ausente** | nativo | **Bespoke** — ou dispensável (§3.3) |

Placar: ACP vence ou empata em 9 de 12. Perde em 3: structured output, sandbox declarativo e PTY.

### 3.2 Por que não bespoke puro

1. Os três providers da v1 **já têm servidor ACP oficial** — dois deles mantidos na org do próprio
   protocolo. Bespoke é reimplementar o que o fornecedor já mantém.
2. O 4º provider entra por configuração, não por código: três linhas no registry contra um parser
   novo. Isso é o teste de generalidade que o prompt pede.
3. `@agentclientprotocol/sdk` tem **zero dependências** — não há custo de supply chain.
4. Superfície de quebra: hoje a ADE dependeria de 3 formatos de JSONL não versionados; com ACP,
   depende de um schema versionado com negociação no handshake.

### 3.3 Por que não ACP puro

1. **Structured output.** O tradutor de intenção precisa de `plan.schema.json` garantido. Sem
   `--output-schema`, sobra prompt + ajv + retry. Solução: o tradutor é a **única** chamada que usa
   caminho bespoke (`codex exec --output-schema` ou `claude -p --output-format json` + ajv), porque é
   uma chamada de modelo, não uma sessão de agente. Nem precisa das capacidades de agente.
2. **Sandbox.** `contain` da ADE é regra própria (bloqueia escrita fora do escopo) e continua
   valendo. O sandbox do provider é reforço: passa por `_meta` (`INITIAL_AGENT_MODE` no codex-acp)
   ou é declarado ausente.
3. **PTY.** Ver a seguir.

### 3.4 Três consequências arquiteturais

**(a) "Assumir o terminal" não precisa mais de checkpoint + relançamento.**
A spec §5 desenha: pausa no checkpoint → relança a CLI interativa no mesmo worktree com `--resume`
→ `human_takeover` → ao soltar, `human_release`. O risco §16 ("`--resume` infiel") é consequência
desse desenho.

Com ACP a ADE **é** o cliente: a sessão está viva, o operador digita no chat do painel e a ADE manda
`session/prompt` no mesmo `sessionId` — ou, melhor, `_session/steering` para injetar no turno em
andamento sem sequer esperar o checkpoint. Sem matar processo, sem resume, sem risco de perder
contexto. O journal ganha os mesmos steps (`human_takeover`/`human_release`), agora sem efeito
colateral no processo.

O PTY com `node-pty`/xterm continua existindo — mas como **espelho** (o painel mostra os terminais
que o agente pede via `terminal/create`, executados pela ADE) e como **modo de escape** para quando
o operador quer mesmo a TUI da CLI. Degradação, não caminho principal.

*Correção ao prompt do usuário: o PTY não é requisito do adapter; é requisito do painel.*

**(b) O `ade doctor` deixa de detectar binário.**
`registry.json` traz `distribution` com `npx`/`uvx`/binário por plataforma (**incluindo
windows-x86_64 e windows-aarch64** para opencode, kimi, goose, mistral-vibe, amp, cursor,
antigravity) com sha256. O doctor baixa/verifica o registry e sabe lançar qualquer provider. O caso
`gemini` vs `antigravity` da spec §5 some: **existe `antigravity-acp` no registry, com binário
Windows**, e é só outra entrada.

**(c) Um normalizador em vez de três parsers.**
`parseEvents(chunk)` e `costOf(events)` da spec §5 desaparecem. Sobra um mapeador
`session/update` → `AgentEvent` do journal, mais um shim por provider apenas para o que vem em
`_meta`.

### 3.5 Forma do adapter

```ts
// Um adapter ACP genérico + um arquivo de capacidades por provider.
interface Provider {
  readonly caps: CapabilitySet;          // §7
  // tudo abaixo é implementado UMA vez, sobre @agentclientprotocol/sdk:
  //   connect() -> initialize + negociação
  //   session(cwd, opts) -> session/new | session/resume
  //   prompt(blocks) -> session/prompt, eventos via session/update
  //   steer(text) / cancel()
  // o cliente (a ADE) implementa: fs/*, terminal/*, session/request_permission,
  //   elicitation/create, e o gate `contain`.
}
```

O `request_permission` implementado pela ADE é onde a allowlist volta a existir: a ADE decide
`allow_once`/`reject_once` pela política da story, **e** grava cada decisão no journal. Isso é
melhor do que a allowlist declarativa do bespoke, que é invisível depois do fato.

---

## 4. Decisão 2 — o 4º provider

### 4.1 Candidatos abertos e provider-agnósticos

| Candidato | Licença | Estrelas | ACP | Provider-agnóstico | Headless+JSON | Resume | Custo USD |
| :--- | :--- | ---: | :--- | :--- | :--- | :--- | :--- |
| **OpenCode** | MIT | 207.7k | nativo (`opencode acp`) | **75+ via AI SDK + models.dev** | `run --format json`, `serve` HTTP+SSE | `-c/--continue`, `-s/--session`, `--fork` | **sim, por mensagem** |
| goose (Block) | Apache-2.0 | 54.3k | nativo (`goose acp`) | sim (multi-provider) | sim | sim | parcial |
| Cline | Apache-2.0 | 68.1k | nativo (`cline --acp`) | sim | sim | sim | sim (extensão) |
| Kimi CLI | MIT | 11.4k | nativo (`kimi acp`) | não (Moonshot) | sim | sim | — |
| Qwen Code | Apache-2.0 | 27.9k | nativo | parcial (OpenAI-compatível) | sim | sim | — |
| Mistral Vibe | Apache-2.0 | 5.0k | nativo (`vibe-acp`) | não (Mistral) | sim | sim | — |
| Amp | Apache-2.0 (só o adapter) | — | adapter | não (créditos Amp) | sim | threads | créditos próprios |
| Aider | Apache-2.0 | 49.0k | **não** | sim | sim | sim | sim |
| Cursor / Copilot / Droid / Kiro | proprietary | — | nativo | não | sim | sim | — |

Aider está fora: sem ACP e **sem push desde 2026-05-22** (todos os outros aqui tiveram push em
setembro/2026). [verificado: GitHub API]

### 4.2 Recomendação: OpenCode

Motivos, em ordem:

1. **É o teste real de generalidade.** É o único candidato cujo "modelo" não é uma família: o
   `--model` é `provider/model`. Se o CapabilitySet aguenta OpenCode, aguenta qualquer coisa.
2. **Custo em USD de verdade.** O schema de mensagem tem `cost: Finite` e
   `tokens: { input, output, reasoning, cache: { read, write } }`.
   [verificado: `packages/opencode/src/session/message.ts`] Com models.dev por trás, o custo é
   calculado, não estimado. Nenhum dos três providers atuais dá isso de forma confiável fora da API.
3. **ACP nativo e completo.** Doc própria: *"All features are supported"* — ferramentas built-in,
   tools/slash commands custom, MCP do config, regras de `AGENTS.md`, formatters/linters, sistema de
   agentes e permissões. Só `/undo` e `/redo` ficam de fora.
4. **Permissões declarativas melhores que as das três CLIs atuais:** resolução `allow|ask|deny` por
   tipo (`read`, `edit`, `glob`, `grep`, `bash`, `task`, `skill`, `lsp`, `question`, `webfetch`,
   `websearch`, `external_directory`, `doom_loop`) **com glob por padrão de comando**
   (`"bash": {"*":"ask","git *":"allow","rm *":"deny"}`) e override por agente. Isso encaixa direto
   no `contain` da ADE.
5. **Saída de emergência não-ACP:** `opencode serve` expõe HTTP + SSE + OpenAPI 3.1 em `/doc` e SDK
   `@opencode-ai/sdk` (MIT, 1.18.31). Se o ACP quebrar, há um segundo caminho oficial.
6. MIT, 207k estrelas, push diário, binário Windows x64 e arm64 no registry.

**Ressalva obrigatória:** a doc do OpenCode declara, sobre plugins de login Claude Pro/Max:
*"Anthropic explicitly prohibits this"*, e que *"Previous versions of OpenCode came bundled with
these plugins but that is no longer the case as of 1.3.0"*. [verificado: opencode.ai/docs/providers]
Portanto o OpenCode na ADE **não** roda na assinatura Claude — roda em OpenCode Zen, chave própria,
Copilot ou modelo local. Isso **quebra parcialmente o princípio "sem chave de API obrigatória"** da
spec §2. É o preço do 4º provider, e deve ser decisão consciente: ou o 4º provider é opcional
(ligado só se o usuário configurar), ou o princípio vira "as três famílias principais rodam em
assinatura; o 4º é opt-in".

Alternativa se o custo em USD não valer a chave: **goose** (Apache-2.0, Block, `goose acp`,
multi-provider) fica na mesma casa sem a vantagem de custo.

### 4.3 O que o OpenCode exige do CapabilitySet

| Exigência | Por quê | Chave afetada |
| :--- | :--- | :--- |
| Id de modelo composto `provider/model` | `--model anthropic/claude-...` | `model.idFormat` |
| Effort pode não existir como eixo | não há flag de reasoning effort; é config por modelo | `model.effort: null` |
| Política por regra `allow/ask/deny` com glob, não por lista de ferramentas | forma diferente das três CLIs | `policy.kind: "rules"` |
| Sem sandbox de SO | usa permissões, não jaula | `policy.sandbox: false` |
| Custo confiável | ao contrário dos outros | `usage.cost: "usd"` |
| Sem `$imagegen` | geração de imagem continua exclusiva do Codex | `imagegen: false` |

Nenhuma dessas exige caso especial no workflow — todas são leitura de capacidade antes de montar a
chamada. Que é o teste que o prompt pede.

---

## 5. Agent SDKs — quando valem, e o que se perde

| SDK | Pacote / versão | Linguagens | Auth |
| :--- | :--- | :--- | :--- |
| Claude Agent SDK | `@anthropic-ai/claude-agent-sdk` 0.3.273 (licença "SEE LICENSE IN README") | TS, Python | **Chave de API exigida para terceiros** |
| Codex SDK | `@openai/codex-sdk` 0.154.0 (Apache-2.0), `openai-codex` (Python ≥3.10) | TS (Node ≥18), Python | usa a instalação local do Codex |
| Gemini | não há SDK de agente separado; o **Gemini CLI é o produto** e expõe `--acp` | — | login do CLI |
| OpenCode | `@opencode-ai/sdk` 1.18.31 (MIT) | TS | auth do CLI |

**O ponto que decide.** A doc do Claude Agent SDK diz, textualmente:

> *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai
> login or rate limits for their products, including agents built on the Claude Agent SDK. Use the
> API key authentication methods described in the Quickstart instead."*
> [verificado: code.claude.com/docs/en/agent-sdk/overview, 2026-09-16]

Ou seja: construir a ADE **em cima do Agent SDK** obrigaria chave de API, matando o princípio da
spec §2 ("uma autenticação, usa assinaturas existentes"). Já **dirigir o `claude` CLI local** —
seja por `-p`, seja pelo `claude-agent-acp`, que sonda `claude auth status --json` e reporta
`kind: "account"` / `"Claude Max"` — usa a credencial que o usuário já tem. A distinção é entre
*oferecer login* (proibido) e *usar a CLI já logada do próprio usuário* (o que qualquer cliente ACP
faz).

**Quando um SDK é melhor que a CLI:** quando o produto tem servidor e chave de API própria
(multiusuário, CI hospedado, produto SaaS). Ganha-se tipagem, hooks in-process e controle fino de
permissão sem parsing. Perde-se a assinatura do usuário, e no caso do Codex perde-se pouco porque o
SDK fala com a instalação local.

**Para a ADE (local, monousuário, assinaturas do Erick): CLI/ACP, sempre.** O SDK direto fica onde a
spec §14 já colocou: backlog v2.

---

## 6. Impacto na spec v2

| Seção | Estado | Ação |
| :--- | :--- | :--- |
| §5 `AgentAdapter` (`spawn`/`parseEvents`/`costOf`) | superado | Trocar por cliente ACP único + `CapabilitySet` + `launch` do registry |
| §5 "assumir o terminal" (checkpoint → relança com resume) | superado | `session/prompt` no `sessionId` vivo, ou `_session/steering` no turno |
| §5 "Gemini/Antigravity: detecta qual binário existe" | superado | `antigravity-acp` está no registry com binário Windows; é outra entrada, não um caso especial |
| §13 matriz por família (3 linhas) | insuficiente | Vira o CapabilitySet de §7, com 4 entradas e leitura por capacidade |
| §16 risco "`--resume` infiel em alguma CLI" | reduzido | Resume deixa de ser o caminho do takeover; vira `session/resume` negociado |
| §3 stack | adicionar | `@agentclientprotocol/sdk` (Apache-2.0, zero deps) |
| §2 "sem chave de API obrigatória" | tensionado | O 4º provider (OpenCode) precisa de chave/Zen/Copilot. Decidir: opt-in |
| §17 "Por que tudo por CLI e não pela API?" | reforçado | Agora com citação da doc do Agent SDK |

---

## 7. Decisão 3 — CapabilitySet mínimo comum

Regra de corte: **o que é verdade nos quatro não vira chave.** São uniformes e portanto ficam de
fora: headless, cancelamento, MCP, arquivo de regras do projeto (CLAUDE.md/AGENTS.md), eventos de
tool call, pedido de permissão, `fs/*` pelo cliente. Sobram 12 chaves — as que o workflow precisa
ler antes de montar uma chamada.

```ts
type ProviderId = "claude" | "codex" | "gemini" | "opencode";

interface CapabilitySet {
  id: ProviderId;
  family: string;                 // regra Maker != Checker; "gemini" cobre gemini+antigravity
  launch: {                       // vem de registry.json; sobrescrevível no config
    cmd: string; args: string[]; env?: Record<string, string>;
  };

  // 1. sessão — como retomar
  resume: "reconnect" | "replay" | "reprompt" | "none";
  //   reconnect = session/resume (sem replay) · replay = session/load
  //   reprompt  = sem suporte: sessão nova + "continue do checkpoint"
  fork: boolean;                  // session/fork | --fork-session | --fork

  // 2. entrada
  attach: ("image" | "audio" | "resource")[];   // promptCapabilities

  // 3. modelo
  model: {
    select: boolean;
    idFormat: "bare" | "provider/model";        // opencode é o segundo
    effort: string[] | null;                    // valores do config option `thought_level`
  };

  // 4. política de efeito
  policy: {
    kind: "modes" | "rules" | "flags";
    modes?: string[];             // ids do fornecedor: read-only|agent|agent-full-access
    sandbox: boolean;             // jaula de SO real, não política de aprovação
    autoApprove: boolean;         // cliente pode responder request_permission sem humano
  };

  // 5. observabilidade
  usage: {
    tokens: "context" | "breakdown" | "none";   // context = usage_update estável
    cost: "usd" | "unknown";
  };

  // 6. capacidades que mudam o roteamento de papéis
  steering: boolean;              // injeta mensagem no turno em andamento
  structuredOutput: boolean;      // schema garantido na resposta final (só Codex)
  imagegen: boolean;              // $imagegen / gpt-image-2 (só Codex)
  pty: boolean;                   // existe TUI interativa para o modo de escape

  // 7. escotilha por fornecedor — o que não é ACP passa aqui
  meta?: Record<string, unknown>; // ex.: { claudeCode: { options: { settings } } }
}
```

Valores medidos:

| Chave | claude | codex | gemini | opencode |
| :--- | :--- | :--- | :--- | :--- |
| `resume` | `reconnect` | `reconnect` | `reconnect` | `reconnect` |
| `fork` | sim | sim | — | sim |
| `attach` | image, resource | image, resource | image | image, resource |
| `model.idFormat` | `bare` | `bare` | `bare` | **`provider/model`** |
| `model.effort` | `["low","medium","high"]`¹ | reasoning effort do Codex | `null` | `null` |
| `policy.kind` | `modes` | `modes` (`read-only\|agent\|agent-full-access`) | `modes` | **`rules`** |
| `policy.sandbox` | sim | sim | sim | **não** |
| `usage.tokens` | `context` | `context` | `context` | `breakdown` |
| `usage.cost` | `unknown`² | `unknown`² | `unknown` | **`usd`** |
| `steering` | **sim** (`_session/steering`) | — | — | — |
| `structuredOutput` | não | **sim** | não | não |
| `imagegen` | não | **sim** | não | não |
| `pty` | sim | sim | sim | sim |

¹ Valores exatos vêm do config option `thought_level` no `initialize`, não de constante no código —
**a ADE deve ler, não hardcodar**. O `--effort <level>` existe na CLI 2.1.271 mas o vocabulário é do
fornecedor. [inferido do schema + flag do CLI local]
² `Cost` é opcional no `usage_update`; vale `unknown` até medição com o adapter real rodando.
[hipótese — verificar na primeira integração]

**Como o workflow usa, sem caso especial:**

- `research` → filtra por `usage.cost === "usd"` quando há orçamento apertado, senão por família.
- tradutor/plano → exige `structuredOutput`, senão cai no caminho bespoke (uma única exceção, §3.3).
- story de UI → etapa de assets exige `imagegen`; etapa de design exige `attach` com `image`.
- `human_takeover` → `steering ? inject : prompt-no-sessionId`; `pty` só no modo de escape.
- `prepare` → `model.effort ? set_config_option : ignorar` (nunca erro).
- `contain` → `policy.kind` decide a forma; a política própria da ADE vale nos quatro de qualquer
  jeito, porque a ADE responde `request_permission`.

---

## 8. Achados que contradizem a spec v2 ou o prompt

1. **O repositório do ACP não é mais da Zed.** `zed-industries/agent-client-protocol` redireciona
   para `agentclientprotocol/agent-client-protocol`, com governança própria. Os adapters de Claude e
   Codex também estão na org do protocolo (`agentclientprotocol/claude-agent-acp`,
   `agentclientprotocol/codex-acp`), não nas orgs dos fornecedores nem na Zed.
2. **O prompt supõe que ACP talvez não cubra custo, modelo/effort, imagens e resume. Cobre os
   quatro** — `usage_update` com custo ISO-4217, config options categoria `model`/`model_config`/
   `thought_level`, blocos `image`/`audio`, e `session/resume` + `session/load` + `session/fork`.
   O que **não** cobre é allowlist, sandbox, structured output e PTY humano.
3. **"Assumir o terminal" da spec §5 é mais complicado do que precisa ser.** Com ACP a sessão fica
   viva e o operador fala nela; `_session/steering` já injeta no turno em andamento.
4. **A spec §5 trata `gemini` vs `antigravity` como detecção de binário.** O Antigravity tem entrada
   própria no registry (`antigravity-acp` 1.1.1, binários Windows x64 e arm64). Vira config.
5. **Aider saiu do jogo:** sem ACP e sem commits desde maio/2026.
6. **`sst/opencode` virou `anomalyco/opencode`** — o repositório mudou de org e está em 207k
   estrelas.
7. **O Claude Agent SDK proíbe login claude.ai para terceiros**, o que confirma a decisão §17 da
   spec (tudo por CLI) com fonte primária — mas com nuance: o `claude-agent-acp` usa a conta local
   já logada, e reporta isso (`kind: "account"`, label `"Claude Max"`).
8. **O 4º provider custa o princípio "sem chave de API".** OpenCode não pode usar assinatura Claude
   (Anthropic proíbe os plugins que faziam isso; removidos na 1.3.0).
9. **Registry vs. doc divergem** no número de agentes (41 no JSON, "60+" na página) e na licença do
   `claude-agent-acp` (Apache-2.0 no npm, `proprietary` no registry).

---

## 9. Perguntas em aberto

1. `claude-agent-acp` e `codex-acp` emitem `usage_update.cost`, ou só `used`/`size`? Decide se o
   painel mostra USD nos três providers. **Medir com uma sessão real de cada, antes de codar o
   painel.**
2. A sessão criada pelo `claude-agent-acp` (Agent SDK) é a mesma que `claude --resume <id>` abre? Se
   sim, o modo de escape PTY preserva o contexto; se não, o escape degrada para "sessão nova no
   worktree".
3. Vale suportar `session/list`+`session/delete` para o painel listar sessões órfãs de lote
   interrompido, ou o journal já basta?
4. `_session/steering` é extensão do `claude-agent-acp`. Existe RFD upstream? Se não, a ADE depende
   de `_meta` de um fornecedor para o takeover ideal — aceitável com fallback para `session/prompt`.
5. Quanto do `contain` pode ser delegado a `policy.rules` do OpenCode (glob por comando) em vez de
   verificação pós-hoc na árvore?
6. O `codex app-server` (que o `codex-acp` usa) tem `generate-json-schema` — vale usar direto no
   lugar do adapter ACP para o Codex, ganhando `--output-schema`? Provavelmente não: um caminho a
   menos vale mais.

---

## Fontes

Protocolo e SDK
- https://agentclientprotocol.com
- https://agentclientprotocol.com/llms.txt
- https://agentclientprotocol.com/get-started/agents.md
- https://agentclientprotocol.com/get-started/registry.md
- https://agentclientprotocol.com/protocol/v1/overview.md
- https://agentclientprotocol.com/protocol/v1/session-setup.md
- https://agentclientprotocol.com/protocol/v1/prompt-turn.md
- https://agentclientprotocol.com/protocol/v1/content.md
- https://agentclientprotocol.com/protocol/v1/tool-calls.md
- https://agentclientprotocol.com/protocol/v1/terminals.md
- https://agentclientprotocol.com/protocol/v1/file-system.md
- https://agentclientprotocol.com/protocol/v1/session-config-options.md
- https://agentclientprotocol.com/protocol/v2/overview.md
- https://agentclientprotocol.com/announcements/acp-v2-draft.md
- https://agentclientprotocol.com/announcements/session-usage-stabilized.md
- https://agentclientprotocol.com/libraries/typescript.md
- https://github.com/agentclientprotocol/agent-client-protocol
- https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/agent-client-protocol-schema/src/v1/agent.rs
- https://raw.githubusercontent.com/agentclientprotocol/agent-client-protocol/main/agent-client-protocol-schema/src/v1/client.rs
- https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- https://registry.npmjs.org/@agentclientprotocol/sdk

Adapters oficiais
- https://github.com/agentclientprotocol/claude-agent-acp
- https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/main/src/auth-status.ts
- https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/main/examples/steering.ts
- https://raw.githubusercontent.com/agentclientprotocol/claude-agent-acp/main/docs/model-configuration.md
- https://github.com/agentclientprotocol/codex-acp

SDKs
- https://code.claude.com/docs/en/agent-sdk/overview
- https://learn.chatgpt.com/docs/codex-sdk
- https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk
- https://registry.npmjs.org/@openai/codex-sdk

OpenCode
- https://opencode.ai/docs/
- https://opencode.ai/docs/cli/
- https://opencode.ai/docs/acp/
- https://opencode.ai/docs/providers/
- https://opencode.ai/docs/permissions/
- https://opencode.ai/docs/server/
- https://github.com/anomalyco/opencode
- https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/message.ts

Outros candidatos
- https://ampcode.com/manual
- https://github.com/aaif-goose/goose
- https://github.com/cline/cline
- https://github.com/MoonshotAI/kimi-cli
- https://github.com/QwenLM/qwen-code
- https://github.com/mistralai/mistral-vibe
- https://github.com/Aider-AI/aider
- https://github.com/github/copilot-cli

CLIs locais (inspeção direta em 2026-09-16)
- `claude --help` (2.1.271), `codex --help` / `codex exec --help` / `codex app-server --help`
  (0.154.0), `gemini --help` (0.59.0)
