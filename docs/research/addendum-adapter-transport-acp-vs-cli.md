# Addendum: transporte primário dos adapters — ACP vs. bespoke, medido

Pesquisa de 2026-09-16. Fecha a lacuna entre `adapters-and-acp.md` (propõe ACP primário) e
`capabilities-claude-code.md` / `capabilities-codex.md` / `capabilities-gemini-antigravity.md` /
`landscape-harnesses.md` / `landscape-routing-skills-terminal.md` (construídos sobre flags de CLI).
Este documento não repete afirmação de nenhum dos dois lados sem verificação de fonte primária —
ver §1 para o que foi efetivamente medido nesta rodada (sessão ACP real, não apenas leitura de doc).

## 0. Veredito

**Híbrido, com ACP como transporte primário para sessão de agente, e três exceções bespoke
nomeadas.** Não muda a decisão do `adapters-and-acp.md` — a mede e a corrige em três pontos que a
medição virou de [hipótese]/contraditório para [verificado], e em um ponto (cunhagem de
`sessionId`) onde a medição descobre uma perda que nenhum dos dois documentos originais havia
verificado.

Exceções bespoke, nomeadas (não "ACP quando dá"):

1. **Tradutor de intenção / structured output** — `codex exec --output-schema` ou
   `claude -p --json-schema`. Confirmado por leitura de schema (§3.1): ACP v1 não tem equivalente;
   não é uma lacuna de implementação de adapter, é ausência no protocolo.
2. **Cunhagem de `sessionId` antes do spawn** — bespoke (`--session-id`/`--session-file`), porque
   `session/new` do ACP **não aceita id do cliente** (verificado no schema, §3.5): o id só existe
   depois que o agente responde. Write-ahead do journal por id pré-cunhado não é possível em ACP.
3. **Modo de escape PTY** — quando o operador quer a TUI nativa da CLI (ex.: revisar um diff com
   syntax highlighting que o painel da ADE não replica). Aqui o achado de §3.4 muda o *porquê*: não
   é porque ACP não suporta takeover — é porque a TUI simplesmente não existe no processo ACP (o
   `claude-agent-acp`/`codex-acp` não têm UI própria) e a ADE não vai reimplementar uma.

**Condição que muda o veredito:** se a RFD `session/inject` (§3.4) estabilizar em v2 com paridade
de `_session/steering`, e se `codex-acp` passar a emitir `usage_update.cost` (hoje não emite,
§3.2), a exceção 2 continua (é estrutural ao protocolo), mas a análise de custo por provider em §4
muda de "claude sim, codex não" para "os dois sim" — sem mudar o veredito do transporte.

---

## 1. O que foi medido nesta rodada (não apenas lido)

Todas as afirmações abaixo vêm de sessão ACP real, rodada em `E:\...\scratchpad\acp-test\`, SDK
`@agentclientprotocol/sdk` 1.4.0 (TypeScript, Apache-2.0, zero deps), prompt trivial
`"Reply with exactly the word: pong"`, cwd descartável. Script: `probe.mjs` (spawna o adapter via
`npx -y <pacote>`, faz `initialize` → `session/new` → `session/prompt`, loga literalmente todo
`session/update` e a resposta final).

| Alvo | Comando real | Resultado |
| :--- | :--- | :--- |
| `claude-agent-acp` | `npx -y @agentclientprotocol/claude-agent-acp` 0.78.0 (resolvido do registry) | sessão completa, `initialize` + `session/new` + `session/prompt` capturados literalmente |
| `codex-acp` | `npx -y @agentclientprotocol/codex-acp` 1.12.0 | idem |
| `registry.json` | `curl` direto do CDN, 2026-09-16 | 41 entradas, inspecionado programaticamente |
| Resume | `claude -p --resume <session-id-do-ACP> --output-format json "..."` na mesma cwd | confirmado |
| RFD de steering | `gh api search/issues` no repo do protocolo | confirmado |

**Nota de ambiente:** em Windows 11 + Node 24.16.0, `child_process.spawn("npx.cmd", …)` sem
`shell: true` falha com `EINVAL` (reproduzido em Bash e PowerShell, fora de qualquer sandbox de
ferramenta — é um comportamento do binding nativo do Node com `.cmd`). O `ade doctor`/launcher
precisa disso: **`spawn` de qualquer entrada `npx` do registry no Windows exige `shell: true`** (ou
resolver o caminho completo do `.cmd` e invocar via `cmd.exe /c`). Isto não está documentado em
nenhum dos research docs existentes e é um achado novo, relevante para o `launch` do
`CapabilitySet` (§4).

Gemini (`--acp` nativo) e o binário `agy_acp_server` do registry **não foram executados nesta
rodada** — fora do escopo pedido (que nomeou claude-agent-acp e codex-acp). Os valores de gemini/
antigravity em §4 permanecem como estavam nos docs de origem, com a classificação de confiança
original preservada (não promovidos a [verificado] por mim).

---

## 2. Registry: `antigravity-acp` existe, mas sem sha256 — correção parcial

Baixado `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` em 2026-09-16
(HTTP 200, 56.558 bytes, 41 agentes).

- **`antigravity-acp` existe**, confirma `adapters-and-acp.md` §1.3/§8.4: `id: "antigravity-acp"`,
  `version: "1.1.1"`, `license: "proprietary"`, distribuição binária com `windows-x86_64` (cmd
  `./agy_acp_server.exe`, archive `agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip`) e
  `windows-aarch64`. [verificado: registry.json, 2026-09-16]
- **Correção**: a entrada `antigravity-acp` **não tem campo `sha256`** em nenhuma plataforma. O
  registry tem sha256 em **10 de 41 entradas** (`amp-acp`, `goose`, `harn`, `kilo`, `kimchi`,
  `kimi`, `mistral-vibe`, `opencode`, `poolside`, `sigit`) — todas com distribuição binária via
  GitHub Releases. `antigravity-acp` (distribuição via `dl.google.com`) e `claude-acp`/`codex-acp`
  (distribuição via `npx`, sem checksum de pacote no registry) **não têm**. A afirmação "registry
  com sha256 por plataforma" de `adapters-and-acp.md` §1 é verdadeira só para uma fração das
  entradas — o `ade doctor` **não pode** verificar integridade do binário do Antigravity via
  registry; precisa doutra fonte (ex.: hash do próprio download, se o Google publicar um).
  [verificado: inspeção programática do JSON, 2026-09-16]
- **Não reconciliação, não contradição real** entre os dois docs sobre "agy tem ACP": são binários
  diferentes. `agy.EXE` (o CLI que `capabilities-gemini-antigravity.md` inspecionou com
  `agy --help`, 1.2.3, instalado localmente) **não tem** flag `--acp` — isso continua
  `[verificado: ausência no --help]`. `agy_acp_server.exe`/`.par` (a entrada do registry, versão
  1.1.1, **não instalada nesta máquina, não testada nesta rodada**) é um processo servidor ACP
  **separado** que o Google distribui para esse fim. Os dois fatos são compatíveis: o produto
  Antigravity tem ACP, mas não embutido no binário `agy` que o usuário roda no terminal — é download
  à parte. `capabilities-gemini-antigravity.md` deveria marcar "agy (CLI) não tem ACP embutido
  [verificado]" em vez de "agy tem ACP [hipótese: ausente]", porque a hipótese vira certeza ao
  notar que existe um binário irmão para isso.

---

## 3. As quatro contradições, resolvidas

### 3.1 `structuredOutput` — não é contradição, é conflação de camada

`adapters-and-acp.md` §7 fala do **CapabilitySet da ACP** (a chave que decide se o protocolo
garante schema na resposta final via `session/prompt`). `capabilities-claude-code.md` e
`capabilities-gemini-antigravity.md` falam da **CLI bespoke** (`claude -p --json-schema`,
`agy --json-schema`). São camadas diferentes, ambas corretas em seu próprio frame:

- **Schema ACP v1** (`@agentclientprotocol/sdk` 1.4.0, `schema/schema.json`): `PromptResponse` tem
  `stopReason`, `usage` (UNSTABLE) e `_meta`. **Nenhum campo de schema de saída.** `NewSessionRequest`
  também não tem. Confirmado por leitura direta do JSON Schema baixado com o pacote — não é uma
  omissão do adapter, é ausência no protocolo. [verificado: schema.json local, pacote 1.4.0]
- **CLI bespoke `claude` 2.1.271**: `--json-schema` existe, confirmado em `capabilities-claude-code.md`
  com prova de execução (`claude -p --json-schema ...` → campo `structured_output`). Continua
  verdade — e continua **inacessível pelo caminho ACP**, porque `claude-agent-acp` fala `session/prompt`
  sem esse parâmetro (não testei enviar structured output via `_meta` — nenhum campo documentado
  para isso no README do adapter).
- **CLI bespoke `agy` 1.2.3** (Antigravity, não Gemini CLI): `--json-schema` existe, confirmado por
  `capabilities-gemini-antigravity.md`. **Não é o Gemini CLI** — o Gemini CLI 0.59.0 (`gemini --help`)
  não lista `--json-schema` no help capturado por aquele mesmo documento (§2.1 da fonte). A tabela de
  `adapters-and-acp.md` dizendo "gemini: nao" para `structuredOutput` está certa para o **Gemini
  CLI**; está ausente de contexto (mas não errada) sobre o Antigravity, que é outro provider.

**Correção de nomenclatura para o CapabilitySet**: `gemini` e `antigravity` precisam ser **entradas
separadas** no CapabilitySet (a spec v2 já cogita isso em `family`), porque hoje eles divergem em
`structuredOutput` (antigravity bespoke = sim, gemini bespoke = não) e a tabela de
`adapters-and-acp.md` §7 os funde numa coluna "gemini" só.

### 3.2 `model.effort` — medido, e a tabela original estava errada nos dois providers

Isto **é** uma contradição real, e a medição resolve a favor do valor completo, não do
`[low,medium,high]` que `adapters-and-acp.md` §7 hipotetizou.

**`claude-agent-acp` 0.78.0**, `session/new` response, `configOptions[].category === "thought_level"`
(medido literalmente, sessão real):

```json
{
  "id": "effort", "category": "thought_level", "currentValue": "xhigh",
  "options": [
    {"value": "default"}, {"value": "low"}, {"value": "medium"},
    {"value": "high"}, {"value": "xhigh"}, {"value": "max"}
  ]
}
```

Valores reais: **`default, low, medium, high, xhigh, max`** (6, não 3). Bate com
`capabilities-claude-code.md` (`low, medium, high, xhigh, max` via probe do `--help`/`--effort
bogus`), **exceto** que `ultracode` — que aquele documento trata como o 6º valor — **não aparece**
como opção de `thought_level` na ACP. Isso resolve uma ambiguidade que nenhum dos dois docs tinha
notado: `ultracode` não é um nível de esforço, é um **modo de orquestração** (dynamic workflows) que
a CLI aceita na mesma flag `--effort` por conveniência de UX, mas que o protocolo ACP — que só
expõe o eixo `thought_level` — corretamente não lista como opção de esforço. **Ação para o
CapabilitySet:** `model.effort.values = ["default","low","medium","high","xhigh","max"]` lido do
`configOptions` no `initialize`/`session/new`, e um campo separado
`model.orchestrationModes = ["ultracode"]` só acessível via CLI bespoke, nunca via ACP.

**`codex-acp` 1.12.0**, mesmo mecanismo, `configOptions[].id === "reasoning_effort"`,
`category: "thought_level"` (medido):

```json
{
  "id": "reasoning_effort", "category": "thought_level", "currentValue": "xhigh",
  "options": [
    {"value": "low"}, {"value": "medium"}, {"value": "high"},
    {"value": "xhigh"}, {"value": "max"}, {"value": "ultra"}
  ]
}
```

Valores reais: **`low, medium, high, xhigh, max, ultra`** — bate **exatamente** com o
`effort_values_catalog` que `capabilities-codex.md` já tinha capturado via `codex debug models
--bundled` (linha 583 daquele doc), e **diverge** do `effort_values_config_doc`
(`minimal, low, medium, high, xhigh`) da Configuration Reference oficial, que está desatualizada.
A medição ACP é uma segunda fonte independente que corrobora o catálogo embutido sobre a doc.
[verificado: sessão ACP real + cross-check com `capabilities-codex.md` §linha 583]

**Conclusão:** a ADE deve ler `thought_level` do `configOptions` do handshake em runtime — nunca
hardcodar —, e isso vale tanto pelo caminho ACP quanto pelo bespoke (`codex debug models
--bundled`). Os dois caminhos concordam quando medidos; só a doc estática do Codex diverge.

### 3.3 `antigravity-acp` no registry — ver §2 (resolvido, existe, sem sha256)

### 3.4 Takeover sem kill+resume — os dois docs estão certos, em transportes diferentes

`landscape-routing-skills-terminal.md` §4.3 item 4 (**[V]**, "transição de modo no mesmo processo é
impossível") descreve o **bespoke**: `claude -p`, `codex exec`, `gemini -p` são processos headless
que **não têm TUI embutida acessível em runtime** — para dar o terminal ao humano é preciso matar o
processo headless e relançar o binário em modo interativo. Isso é verdade e continua sendo a
realidade de quem fala com essas três CLIs por linha de comando pura. Não há nada a corrigir ali.

`adapters-and-acp.md` §3.4a (takeover sem kill+resume) descreve o **ACP**: aqui não existe "modo
headless" vs. "modo interativo" como dois binários diferentes — existe **um processo agente, uma
conexão JSON-RPC viva**, e a "interatividade" é inteiramente do lado do cliente (a ADE). Medição
confirma: `_meta.steering.supported: true` veio no `initialize` de **ambos** `claude-agent-acp` e
`codex-acp` (capturado literalmente nesta rodada, não só lido do README). O documento estava certo
sobre a mecânica — só a chamada `_session/steering` propriamente dita eu não exercitei (o SDK usado
não expõe um método de alto nível para isso; exigiria montar a requisição JSON-RPC crua com
`method: "_session/steering"`, fora do escopo desta rodada).

**Não são contradição — são descrições corretas de dois transportes diferentes.** A pergunta que
importa para a decisão de arquitetura não é "qual documento está certo", é "qual transporte a ADE
usa": com ACP como primário (§0), a pergunta do `landscape-routing-skills-terminal.md` (como
relançar a TUI) só se aplica à exceção 3 do veredito (modo de escape), não ao caminho principal.

**RFD upstream de `_session/steering`** — pergunta em aberto #4 do prompt, resolvida:
`gh api search/issues` no repo `agentclientprotocol/agent-client-protocol` encontra
**PR #1261** `docs(rfd): mid-turn input via session/inject (queue and steer)`, aberto por
`kennethsinder` em 2026-05-19, **ainda aberto** (`state: open`), última atividade 2026-08-26,
elevando a discussão #1220. Texto do PR (capturado via `gh api`):

> "One method (`session/inject`), two modes (`queue`, `steer`)... Specifies the protocol shape for
> queue/steer behavior already present across Cursor, Codex CLI, Claude Code, Windsurf Cascade,
> Gemini CLI, and others."

Isto **existe**, mas: (1) está no **bucket v2** (draft, instável — ver `adapters-and-acp.md` §1.4
sobre não tocar v2 em produção); (2) a forma proposta (`session/inject` com `mode: steer|queue`) é
**diferente** do método hoje usado pelo `claude-agent-acp` (`_session/steering`, `_meta`); (3) não
há indicação de merge iminente. **Custo real de depender de `_session/steering` hoje:** é uma
extensão `_meta` de um único fornecedor (Claude), sem contrato estável, que a ADE trataria como
"funciona se `_meta.steering.supported === true` no `initialize`, senão cai para `session/prompt`
sem `sessionId` novo" — exatamente o fallback que `adapters-and-acp.md` já previa, agora com prova
de que não há alternativa padronizada em v1 e a de v2 ainda não fechou.
[verificado: `gh api repos/agentclientprotocol/agent-client-protocol/pulls/1261`, 2026-09-16]

---

## 4. CapabilitySet corrigido

Regra de proveniência: `[medido: sessão ACP real, 2026-09-16]` = rodei eu, nesta rodada.
`[verificado: <doc>]` = já verificado alhures, não re-executado por mim. `[inferido]`/`[hipótese]`
preservados quando nada mudou.

| Chave | `claude` (via `claude-agent-acp` 0.78.0) | `codex` (via `codex-acp` 1.12.0) | `gemini` (via `--acp` nativo, Gemini CLI 0.59.0) | `antigravity` (via `agy_acp_server` 1.1.1, registry) |
| :--- | :--- | :--- | :--- | :--- |
| `launch` | `npx @agentclientprotocol/claude-agent-acp@0.78.0`; no Windows exige `shell:true` no spawn | `npx @agentclientprotocol/codex-acp@1.12.0`; idem | `npx @google/gemini-cli --acp` [verificado: `adapters-and-acp.md` §1.3] | binário `agy_acp_server.exe` baixado do registry; **não testado** |
| `resume` | `reconnect` — **e confirmado equivalente a `claude --resume <id>`** (mesma sessão, mesmo cache: `cache_read_input_tokens=52750` bate com `cachedWriteTokens=52750` da sessão ACP) [medido: sessão ACP + `claude --resume`, 2026-09-16] | `reconnect` — não testado o resume cruzado com `codex resume <id>`; `agentCapabilities.sessionCapabilities.resume: {}` presente no `initialize` [medido: initialize apenas] | `reconnect`, com ressalva já conhecida: **CLI bespoke** não retoma por id (só `latest`/índice) [verificado: `landscape-routing-skills-terminal.md` §4.3]; comportamento do caminho ACP não testado | não testado |
| `sessionId` cunhado pelo cliente | **não** — `session/new` não tem campo de id de entrada; id só existe na resposta do agente [medido: schema `NewSessionRequest`, 2026-09-16] | **não**, mesmo schema | **não**, mesmo schema (protocolo, não por provider) | idem |
| `model.effort` (`thought_level`) | `["default","low","medium","high","xhigh","max"]`, lido de `configOptions` no `session/new` [medido: sessão ACP real] | `["low","medium","high","xhigh","max","ultra"]`, idem [medido: sessão ACP real; cruza com `capabilities-codex.md` linha 583] | não medido nesta rodada; Gemini CLI bespoke não tem flag de effort [verificado: `capabilities-gemini-antigravity.md` §2.1] | `agy` bespoke: `low\|medium\|high` [verificado: `capabilities-gemini-antigravity.md`]; via ACP não testado |
| `model.select` / ids reais | sim; ids medidos: `opus[1m]` (default), `claude-fable-5-1[1m]`, `sonnet`, `haiku` [medido] | sim; ids medidos: família `gpt-6-astra`/`gpt-5.6-{sol,terra,luna}`/`gpt-5.5`, cada um com sufixo `[effort]` compondo o id (ex. `gpt-5.6-terra[xhigh]`) [medido] | `bare`, aliases `auto/pro/flash/flash-lite` [verificado] | não medido |
| `policy.kind` / modos reais | `modes`: ids medidos `default, acceptEdits, plan, auto, bypassPermissions` (default atual: `auto`) [medido] — **diferente** do vocabulário `--permission-mode` da CLI bespoke, que usa outro conjunto de nomes | `modes`: ids medidos `read-only, agent, agent-full-access` (default atual: `agent`) [medido] — bate com `INITIAL_AGENT_MODE` citado em `adapters-and-acp.md` §1.5 | `modes` (Policy Engine bespoke); ACP não medido | `modes`? não medido |
| `usage.tokens` | **`breakdown`**, não `context` — `PromptResponse.usage` (UNSTABLE no schema, mas **populado**: `inputTokens/outputTokens/cachedReadTokens/cachedWriteTokens/totalTokens`) **e** `_meta.quota.model_usage[]` com breakdown por modelo (`reasoningOutputTokens` incl.) [medido: resposta final real] | **`breakdown`**, mesmo padrão: `inputTokens/cachedReadTokens/outputTokens/thoughtTokens/totalTokens` + `_meta.quota.model_usage[]` [medido] | `usage_update` estável (`used`/`size`); breakdown por tipo não medido | não medido |
| `usage.cost` | **`usd`** — `usage_update` real trouxe `"cost":{"amount":0.52761,"currency":"USD"}` [medido: sessão ACP real, campo literal capturado] | **`unknown`** — nenhuma notificação `usage_update` trouxe `cost` em toda a sessão (múltiplos `usage_update` capturados, nenhum com o campo) [medido: ausência confirmada, não suposição] | `unknown` [verificado: `capabilities-gemini-antigravity.md`, `costOf()` do adapter bespoke] | não medido via ACP; bespoke `agy` também `unknown` [verificado] |
| `steering` | **sim**, `_meta.steering.supported: true` no `initialize` [medido, campo literal] | **sim**, mesmo campo [medido] | não documentado | não documentado |
| `structuredOutput` (ACP) | **não** — ausente do schema ACP v1 inteiro, não é limitação do adapter [verificado: schema.json 1.4.0] | **não**, mesmo motivo | **não**, mesmo motivo | **não**, mesmo motivo — é do protocolo, não do provider |
| `structuredOutput` (CLI bespoke, fora do transporte ACP) | sim, `--json-schema` [verificado: `capabilities-claude-code.md`] | sim, `--output-schema` [verificado: `adapters-and-acp.md` §2] | **não** (Gemini CLI) [verificado: `capabilities-gemini-antigravity.md` §2.1] | sim, `agy --json-schema` [verificado: `capabilities-gemini-antigravity.md`] — **é o Antigravity, não o Gemini CLI** |
| `imagegen` | não | sim (`$imagegen`) [verificado: `adapters-and-acp.md`] | não | não confirmado |
| `pty` (TUI própria) | não — o processo ACP não tem UI; a TUI é a do binário `claude` separado | não — idem, TUI é do `codex` separado | idem | idem |
| RFD de `_session/steering`/steering genérico | PR #1261 aberto, v2-bucket, forma diferente (`session/inject`) [verificado: `gh api`, 2026-09-16] | mesma RFD (cross-provider) | mesma RFD | mesma RFD |
| sha256 no registry | n/a (dist. npx) | n/a (dist. npx) | n/a (dist. npx) | **ausente** apesar de dist. binária [verificado: registry.json] |

---

## 5. `human_takeover` / `human_release` — decisão final

**Decisão:** o caminho principal é **ACP vivo + steering**, não kill+resume. O PTY físico só entra
como modo de escape nomeado (exceção 3, §0). Dois caminhos possíveis no runtime, e o journal grava
diferente em cada um:

### Caminho A — steering em turno vivo (`_meta.steering.supported === true`, hoje só `claude-agent-acp` e `codex-acp` confirmados)

1. Operador digita no painel enquanto o agente está em turno.
2. ADE chama a requisição crua `_session/steering` (fora da API tipada do SDK — precisa do
   transporte JSON-RPC bruto, já que `@agentclientprotocol/sdk` 1.4.0 não expõe um método de alto
   nível para isso nesta versão) com `{sessionId, prompt}`.
3. Resposta traz `outcome`: `injected` (entrou no turno atual), `startedNewTurn` (o agente decidiu
   tratar como novo turno) ou `promptRequired` (não deu para injetar; a ADE cai para o passo do
   Caminho B).
4. **Journal grava**: um step `human_takeover` com `outcome` do steering, **sem matar o processo
   nem trocar `sessionId`** — o `tree_before`/`tree_after` do runtime continua sendo a fonte de
   verdade sobre o que mudou, como já é hoje (RUNTIME.md). `human_release` é só o próximo evento
   `session/update` que volta a ser gerado pelo agente sem intervenção — não há relançamento a
   registrar.

### Caminho B — sem steering (fallback, gemini/antigravity hoje; ou `promptRequired` em qualquer provider)

1. Checkpoint de árvore antes de soltar (igual ao que a spec v2 já desenha).
2. ADE espera o turno atual terminar (`stopReason`) ou cancela (`session/cancel`).
3. Novo `session/prompt` **no mesmo `sessionId`** (a sessão ACP continua viva — isto não precisa de
   `session/resume`, porque o processo nunca foi morto) com o texto do operador.
4. **Journal grava**: step `human_takeover` com `mode: "queued"` (esperou o turno fechar, não
   injetou), `human_release` no próximo `session/update` do agente. Ainda **sem matar processo**.

### Caminho C — modo de escape PTY (exceção 3, nomeada)

Só quando o operador pede explicitamente a TUI nativa. Aqui sim: checkpoint de árvore, mata a
sessão ACP (`session/close` se suportado, senão SIGTERM no processo), relança o binário interativo
(`claude`/`codex`/`gemini`) com `--resume <sessionId>` **no mesmo cwd**. Confirmado nesta rodada que
para `claude` isso preserva contexto real (§1, teste de resume). Não testado para `codex`/`gemini`.
**Journal grava**: `human_takeover` com `mode: "pty_escape"`, `resume_fidelity: "verified"` para
claude, `"unverified"` para os outros dois até serem testados — nunca confiar no conteúdo restaurado
para decidir portão (regra já existente em `landscape-routing-skills-terminal.md` §4.3, mantida).

**O que isso corrige na spec v2 (§5):** a sequência "pausa no checkpoint → mata processo → relança
com `--resume`" deixa de ser o caminho único; vira o Caminho C, reservado a pedido explícito do
operador. Os Caminhos A/B são o padrão e não matam processo nunca.

---

## 6. O que fica sem cobertura em cada opção

### Indo por ACP (primário, conforme §0)

- **Structured output garantido** na resposta final — confirmado ausente do protocolo (§3.1), não
  só do adapter. Mitigação: exceção 1 do veredito (tradutor bespoke).
- **Teto de orçamento a priori** (`--max-budget-usd` do `claude`, verificado em
  `capabilities-claude-code.md` linha 587) — ACP não tem conceito de orçamento antes do spawn; o
  `usage_update.cost` é *pós-fato*, por notificação, e só existe (medido) para `claude`, não para
  `codex`. Um budget hard-stop via ACP teria que ser a ADE observando `usage_update` e chamando
  `session/cancel` reativamente — não é preventivo, é reativo com janela de estouro.
- **`--session-id` cunhado a priori** — confirmado impossível no schema (§3.5); quebra write-ahead
  puro do journal (a ADE grava o step de intenção **antes** de saber o `sessionId` real, e
  atualiza depois que a resposta de `session/new` chega — muda a ordem de escrita do journal em
  relação ao desenho que supõe id conhecido no `step_intent`).
- **`codex exec review --output-schema`** e outras subcapacidades de subcomando (`codex exec
  resume`, `--last`, `--fork`) — o `codex-acp` inicia o **App Server**, não `codex exec`; comandos
  de subcomando exclusivos de `exec` não têm equivalente ACP confirmado nesta rodada.
  [inferido — não testei `slash commands` do `codex-acp` que possam expor `/review`]
- **`--ephemeral`** (não gravar sessão em disco) — sem equivalente no schema ACP inspecionado; toda
  sessão que passei tinha `.jsonl` persistido em `~/.claude/projects/...` (confirmado para claude).
- **`--safe-mode`** e flags de sandbox de SO — confirmado ausente do protocolo (`adapters-and-acp.md`
  §1.2, já verificado); a ADE depende de `contain` próprio nos dois transportes de qualquer forma.
- **Custo em USD do Codex** — hoje **zero**, não "desconhecido pendente de medição": medido e
  ausente. Um painel de custo unificado nos três providers via ACP puro **não é possível hoje** para
  Codex; ou o painel mostra USD só para claude e "—" para codex, ou a ADE cai para o JSON bespoke do
  `codex exec --json` (que também não expõe USD diretamente, é estimativa por preço de tabela — teria
  que ser calculado pela ADE a partir de `usage.*` e uma tabela própria de preços).

### Indo por bespoke puro (não escolhido, ver §0)

- Três parsers de evento, três semânticas de resume (`gemini` sem resume por id — real, verificado),
  três vocabulários de permissão que mudam a cada release sem aviso — risco já quantificado em
  `adapters-and-acp.md` §2 e não alterado por esta rodada.
- Nenhum handshake de capacidade — a ADE teria que manter `--help` parseado e versionado por CLI,
  ou reintroduzir o probing frágil que `capabilities-claude-code.md`/`capabilities-codex.md` já
  fizeram manualmente (`claude -p --effort bogus` etc.) como parte do `ade doctor` em vez de um
  handshake declarativo.
- **Steering** não existe no bespoke de forma alguma — só ACP (`_session/steering`) oferece injeção
  em turno vivo; bespoke sempre precisa do Caminho B ou C de §5.

---

## 7. Fontes

Medição própria (2026-09-16)
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\...\scratchpad\acp-test\probe.mjs` (script) e
  `claude-probe2.log` / `codex-probe.log` (saída literal capturada) — arquivos no scratchpad da
  sessão, não versionados no repo.
- `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (baixado, 2026-09-16, 41
  agentes, 56.558 bytes)
- `npm install @agentclientprotocol/sdk@1.4.0` → `schema/schema.json`, `dist/acp.d.ts`,
  `dist/examples/client.js` (inspecionados localmente)
- `claude -p --resume <session-id-do-ACP> --output-format json "..."` (comando local, output
  literal com `cache_read_input_tokens=52750`)
- `gh api repos/agentclientprotocol/agent-client-protocol/pulls/1261`
- `gh api "search/issues?q=steering+repo:agentclientprotocol/agent-client-protocol"`

Docs internos citados (não re-verificados nesta rodada, citação de segunda mão marcada como tal)
- `docs/research/adapters-and-acp.md`
- `docs/research/capabilities-claude-code.md`
- `docs/research/capabilities-codex.md`
- `docs/research/capabilities-gemini-antigravity.md`
- `docs/research/landscape-harnesses.md`
- `docs/research/landscape-routing-skills-terminal.md`
- `docs/specs/2026-09-16-ade-design.md` §5, §6, §13

Protocolo (herdado, já citado em `adapters-and-acp.md`, não re-fetched nesta rodada)
- https://agentclientprotocol.com
- https://github.com/agentclientprotocol/agent-client-protocol
- https://github.com/agentclientprotocol/claude-agent-acp
- https://github.com/agentclientprotocol/codex-acp

---

## 8. Perguntas que continuam abertas

1. `_session/steering` bruto (fora do SDK tipado) não foi exercitado — só confirmei
   `_meta.steering.supported: true` no handshake. Próxima rodada: montar a requisição JSON-RPC crua
   e capturar o `outcome` real.
2. Resume cruzado `codex-acp` ↔ `codex resume <id>` e `gemini --acp` ↔ `gemini --resume` não foi
   testado (só claude). É o teste de maior valor para fechar §5 Caminho C com confiança nos três
   providers, não só um.
3. `agy_acp_server` (registry, 1.1.1) nunca foi baixado nem executado — todo o CapabilitySet de
   `antigravity` via ACP nesta tabela é lacuna, não estimativa.
4. Não testei se `codex-acp` expõe slash commands equivalentes a `codex exec review
   --output-schema` — a coluna "structured output via ACP" para Codex fica em "não, mas não
   exaustivamente checado por slash command".
