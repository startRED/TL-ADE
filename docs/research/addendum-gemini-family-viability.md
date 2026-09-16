# Addendum: viabilidade real da família Gemini (`agy` + `gemini`) na ADE v1

Pesquisa de fechamento de lacuna. Data: 2026-09-16. Máquina: Windows 11 Pro 26200.
Complementa `docs/research/capabilities-gemini-antigravity.md` (doc-base) e resolve a contradição com
`docs/research/landscape-routing-skills-terminal.md` §0.2/§5.3. Todas as evidências abaixo são
**chamadas reais** executadas nesta sessão (não `--help`), com saída literal colada. Classificação:
`[verificado: execução local, 2026-09-16]` / `[inferido]` / `[hipótese]` / `[não verificável]`.

## 0. Correção de versão

`agy --version` → **`1.2.4`**, não `1.2.3` como registrado no doc-base (o binário se auto-atualizou
entre as duas sessões de pesquisa, sem ação do usuário). `[verificado: execução local]`. Risco novo: se
o `agy` se auto-atualiza silenciosamente, o `ade doctor` não pode assumir versão fixa entre execuções —
precisa reler `agy --version` a cada lote, não cachear.

## 1. `agy -p --output-format json` — campos exatos (item 1)

Comando: `agy -p "Responda apenas com a palavra OK, sem mais nada." --output-format json`

```json
{"conversation_id":"42d4ec6f-03e6-4923-9696-3250434a7260","status":"SUCCESS","response":"OK\n","duration_seconds":2.9443745,"num_turns":1,"usage":{"input_tokens":13535,"output_tokens":171,"thinking_tokens":170,"cache_read_tokens":0,"total_tokens":13706}}
```

Campos: `conversation_id`, `status` (`"SUCCESS"` observado; outros valores não exercitados),
`response`, `duration_seconds`, `num_turns`, `usage.{input_tokens,output_tokens,thinking_tokens,cache_read_tokens,total_tokens}`.
**Sem campo de custo em USD** — confirma o doc-base. **Sem campo `model`** no nível raiz do resultado em
`json` simples. `[verificado]`

### 1.1 `id` de conversa: nasce no processo, não é cunhável antes

`conversation_id` é gerado pelo próprio `agy` e aparece **já no evento `init`** do `stream-json` (abaixo),
antes de qualquer resposta. Diferente do Gemini CLI (`--session-id` deixa o chamador escolher o UUID),
o `agy --help` não tem flag equivalente — `--conversation <ID>` só **retoma** um id existente, nunca
predefine um novo. `[verificado: help + execução]`. Consequência para o engine: o journal só pode gravar
o `conversation_id` **depois** de ler o evento `init` (ou o resultado final em modo `json`), nunca antes
do `step_intent` como é possível com `gemini --session-id`.

### 1.2 `stream-json` — evento por evento

Comando: mesmo prompt, `--output-format stream-json`.

```json
{"event":"init","conversation_id":"69581cf8-ba85-423f-bc22-3b9255f20f5f","init":{"cwd":"...","tools":["ask_custom_permission","ask_permission","ask_question","browser_click_element", "...(35 tools)...","view_file","wait","wait_5_seconds","write_to_file"],"permission_mode":"request-review"}}
{"event":"step_update","step_update":{"conversation_id":"69581cf8-...","step_index":0,"state":"DONE","step_type":"user_input"}}
{"event":"step_update","step_update":{"conversation_id":"69581cf8-...","step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"OK"}}
{"event":"step_update","step_update":{"conversation_id":"69581cf8-...","step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":1.85,"usage":{"input_tokens":13531,"output_tokens":182,"thinking_tokens":181,"cache_read_tokens":0,"total_tokens":13713}}}
{"event":"result","result":{"conversation_id":"69581cf8-...","status":"SUCCESS","response":"OK\n","duration_seconds":2.0033022,"num_turns":1,"usage":{"input_tokens":13531,"output_tokens":182,"thinking_tokens":181,"cache_read_tokens":0,"total_tokens":13713}}}
```

`event` ∈ `init | step_update | result` (vocabulário fechado observado; o doc-base citava
`tool_info`/`subagent_info` só por changelog, não exercitados aqui). `init.tools` lista as 35 tools do
agente (inclui `browser_*`, `generate_image`, `search_web`, `run_command`, `view_file`, `write_to_file`,
`invoke_subagent`, `schedule`, `send_message`). `init.permission_mode` = `"request-review"` (default local,
de `~/.gemini/antigravity-cli/settings.json`). **`init` só ganha a chave `"model"` quando `--model` é
passado explicitamente** — sem a flag, o campo simplesmente não existe no JSON (ver §6). `[verificado]`

### 1.3 `--print-timeout`

Comando: `agy -p "<prompt longo>" --output-format json --print-timeout 5s`

stderr: `[agy] print timeout after 5s with turn in progress; returning partial output`
stdout: `{"conversation_id":"0b9db81c-...","status":"SUCCESS","response":"","duration_seconds":0,"num_turns":1,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}`
Exit code: `0`.

Confirma o doc-base: timeout devolve **exit 0**, aviso só em stderr, `status` continua `"SUCCESS"` (não
existe `"PARTIAL"` ou `"TIMEOUT"` como valor de status observado), e o corpo vem zerado/vazio quando o
turno não tinha produzido nada ainda — ou seja, "saída parcial" pode ser **saída vazia**, não
necessariamente um fragmento útil. `[verificado]`. Risco para o engine: **não dá para distinguir
"terminou rápido e não disse nada" de "estourou o timeout" olhando só `status`** — é preciso checar
stderr ou medir `duration_seconds` contra o timeout pedido.

## 2. `--json-schema` — validação real, não cosmética (item 2)

Schema usado (formato próximo de `research-finding.schema.json`):

```json
{"type":"object","properties":{"recommendation":{"type":"string"},"alternatives":{"type":"array","items":{"type":"string"}},"evidence":{"type":"array","items":{"type":"object","properties":{"url":{"type":"string"},"quote":{"type":"string"}},"required":["url","quote"]}},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["recommendation","alternatives","evidence","confidence"]}
```

**Teste A** (prompt pedindo para preencher corretamente):

```json
{"conversation_id":"23287013-...","status":"SUCCESS","response":"{...}\n","duration_seconds":13.26,"num_turns":2,
 "structured_output":{"alternatives":["Bash","Perl"],"confidence":0.8,"evidence":[{"quote":"Python provides superior readability and extensive library support for general-purpose scripting.","url":"https://example.com/docs"}],"recommendation":"Python"},
 "json_schema":{...eco do schema enviado...},
 "usage":{"input_tokens":29064,"output_tokens":1458,"thinking_tokens":1321,"cache_read_tokens":0,"total_tokens":30522}}
```

**Teste B** (prompt instruindo o modelo a **desobedecer** o schema e responder texto livre "nao-json"):

```json
{"conversation_id":"bc135af7-...","status":"SUCCESS",
 "response":"nao-json\n{\"alternatives\":[],\"confidence\":1,\"evidence\":[],\"recommendation\":\"nao-json\",...}\n",
 "structured_output":{"alternatives":[],"confidence":1,"evidence":[],"recommendation":"nao-json"},
 "usage":{"input_tokens":27938,"output_tokens":665,"thinking_tokens":665,"cache_read_tokens":0,"total_tokens":28603}}
```

**Achado central**: existe um campo `structured_output` **separado** de `response` — `response` é o
texto livre do agente (pode conter prosa + o JSON bruto que ele gerou), `structured_output` é o objeto
**já parseado e conforme o schema** que o adapter deve consumir, nunca `response`. Quando instruído a
desobedecer, o modelo ainda produz um `structured_output` com a forma certa (tipos e chaves corretos,
arrays vazios em vez de ausentes) — ou seja, **há coerção estrutural real do lado do `agy`**, não é só
"o modelo geralmente obedece". `json_schema` vem ecoado de volta no resultado, útil para auditoria.
`[verificado: execução local, 2 chamadas]`. Isto confirma a vantagem apontada no doc-base: o adapter de
pesquisa da ADE deve usar `--json-schema` com `research-finding.schema.json` e ler `structured_output`,
descartando parsers de JSON livres.

## 3. Janela de contexto do `agy` (item 3)

**Não há flag, subcomando ou campo de saída que publique um número.** `agy --help | grep -i context` →
vazio. `[verificado: ausência]`.

Evidência indireta 1 — limite por chamada de `view_file` (tool-level, não é o context window do modelo):
pedi para o agente ler com `view_file` um arquivo de 1.562.742 bytes / 18.990 linhas
(`tl-orchestrator-release/_tl-orc/project/evidence/T024-r01/review/checker-stderr.txt`). Resposta
(1 única chamada de `view_file`, conteúdo colado literalmente pelo agente):

> "Content truncated: showing bytes 0-46080 of 59752. To see more, call this tool again with the same
> line range and ContentOffset=46080." ... `<truncated 886 bytes>` ... 652 linhas vistas de 18.990.

`[verificado: execução local]`. Ou seja, `view_file` corta em **~46 KB ou 800 linhas por chamada**
(o que vier primeiro), com paginação via `ContentOffset` — isso é um limite de *tool*, imposto para não
estourar o contexto do modelo em uma única inserção, **não** o tamanho real da janela do modelo. Para ler
um arquivo grande o agente precisa de múltiplas chamadas de `view_file` encadeadas na própria sessão, e
o que sobra de espaço para acumular esse conteúdo na conversa **é** o context window real — que continua
desconhecido.

Evidência indireta 2 — changelog (1.2.x, `agy changelog`): "Fixed `view_file` attempting to parse
non-UTF-8 binary files as text or loading files larger than 100 MB into the model context; unsupported
binary formats and oversized files are now rejected with a clear error before overflowing the context
window." `[verificado: agy changelog]` — confirma que **existe** um teto de contexto que pode "overflow"
(portanto é finito e gerenciado ativamente), mas não publica o número.

**Veredito do item**: `[não verificável]` o número exato. Efeito na spec §13 (papel "leitura de base
grande"): o `agy` não pode ser tratado como tendo janela equivalente ao Gemini CLI (1.048.576 tokens
publicados) só por herdar o mesmo backend — essa é uma inferência do doc-base, não um fato. O adapter
deve tratar a janela do `agy` como **desconhecida e possivelmente menor**, e usar chunking próprio
(offset explícito) em vez de confiar em "manda o arquivo inteiro que ele resolve".

## 4. `gemini` 0.59.0 — auth sem login e viabilidade com API key (item 4)

Estado sem tocar em nada: `~/.gemini/google_accounts.json` → `{"active": null, "old": [...]}`,
`~/.gemini/settings.json` → `security.auth.selectedType: "oauth-personal"`. Nenhuma env var
`GEMINI_*`/`GOOGLE_*` setada nesta sessão. `[verificado]` — mesmo estado do doc-base, confirmado de novo.

**Teste sem trocar o tipo de auth** (`GEMINI_API_KEY` de teste, settings inalterado):

```
GEMINI_API_KEY="test-invalid-key-000" gemini -p "responda apenas OK" --output-format json
→ Opening authentication page in your browser. Do you want to continue? [Y/n]:
```

Confirma o doc-base: **a presença da env var sozinha não muda o método de auth** — quem decide é
`security.auth.selectedType` em `settings.json`, e localmente está fixado em `oauth-personal`. Não existe
flag `--auth-type` (`gemini --help` não lista; testei `--auth-type`/`--authType` → `Unknown arguments`).
`[verificado]`

**Teste isolado** (HOME/USERPROFILE apontando para um diretório descartável do scratchpad, com
`settings.json` mínimo `{"security":{"auth":{"selectedType":"gemini-api-key"}}}`, sem tocar no
`~/.gemini` real do usuário, `GEMINI_API_KEY` ainda inválida de propósito — só para provar o caminho de
código, nunca autenticar de fato):

```
Error generating content via API. ... _ApiError: {"error":{"code":400,"message":"API key not valid.
Please pass a valid API key.","status":"INVALID_ARGUMENT", ...}}
{
  "session_id": "d820b401-7688-490a-8fee-107e690abbaa",
  "error": {"type":"Error","message":"...API key not valid...","code":400}
}
```

**Achado decisivo**: com `selectedType: "gemini-api-key"`, o `gemini` **não abre browser** — vai direto
para `generativelanguage.googleapis.com`, envia a chave, e recebe um erro estruturado 400
`API_KEY_INVALID` da API real do Google. Isso prova que o caminho de código do adapter por API key
**funciona de ponta a ponta nesta máquina hoje**; só falta uma chave válida. `[verificado: execução
local, chamada real ao endpoint alcançada]`. Também confirma o formato de erro do `JsonOutput` do
doc-base (`session_id` + `error.{type,message,code}`) com um caso real, não só o `types.ts` lido no
código-fonte.

**Bloqueio registrado**: não havia `GEMINI_API_KEY` real disponível nesta máquina/sessão e a tarefa
proíbe autorizar login interativo — então não foi possível completar uma chamada de modelo bem-sucedida
com o `gemini`. **Não infiro nada sobre a data do blog** para esta conclusão: o veredito é só sobre o
mecanismo local. `[verificado]` que o mecanismo funciona; `[bloqueio]` para uma chamada 200 OK real —
depende só de Erick fornecer uma `GEMINI_API_KEY` válida (Vertex AI ou AI Studio) e testar de novo; não é
um problema de código ou de instalação.

**Resposta direta ao item 4**: o adapter `gemini` é **viável nesta máquina hoje**, mas só pela via
`GEMINI_API_KEY`/Vertex — a via OAuth pessoal está confirmada morta localmente (sem conta ativa, tipo
depreciado). Isso é mecanismo comprovado, não inferência da data do post do blog.

## 5. ACP: a contradição é falsa — as duas fontes estavam certas sobre coisas diferentes (item 5)

Baixado `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (HTTP 200,
`"version": "1.0.0"`). **`antigravity-acp` existe**, confirmando `adapters-and-acp.md`:

```json
{
  "id": "antigravity-acp", "name": "Google Antigravity", "version": "1.1.1",
  "license": "proprietary",
  "distribution": {"binary": {
    "windows-x86_64": {"archive": "https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip", "cmd": "./agy_acp_server.exe"},
    "windows-aarch64": {"archive": ".../agy-acp-server-agy_acp_server_1.1.1-windows-arm64.zip", "cmd": "./agy_acp_server.exe"},
    "linux-x86_64": {"...": "...", "args": ["--uid="]}, "linux-aarch64": {...}, "darwin-aarch64": {...}
  }}
}
```

E **`gemini` também está no registry** (`"id":"gemini"`, versão `0.59.0`, distribuído via
`npx @google/gemini-cli@0.59.0 --acp`), o que bate com `agy --help`/`gemini --help` locais: `gemini` tem
flag `--acp` própria; `agy` **não tem** (`agy --help | grep -i acp` → vazio, confirmado de novo nesta
sessão). `[verificado]`

**A contradição do doc-base era sobre o binário errado.** `capabilities-gemini-antigravity.md` dizia
"agy não tem ACP" — verdade, e continua verdade: o CLI `agy.EXE` (Go) não fala ACP. Mas `antigravity-acp`
**não é o `agy` CLI** — é um binário **separado**, `agy_acp_server`, distribuído por download direto do
Google (`dl.google.com/agy-extensions`), não pelo instalador do `agy`. `adapters-and-acp.md` estava certo
sobre a existência da entrada no registry; o doc-base estava certo sobre o `agy` CLI não ter `--acp`.
Não há erro factual em nenhum dos dois — era ambiguidade de "o Antigravity" (produto) vs "`agy`" (um dos
binários do produto).

**Testei lançá-lo** (baixei o zip Windows x86_64, 468.238.392 bytes, `HTTP 200`; extraí
`agy_acp_server.exe`, 430.801.616 bytes + `localharness_external.exe`, 130.971.800 bytes — removidos do
scratchpad ao final do teste):

```
agy_acp_server.exe > out.log 2> err.log   # sem --help, sem args: bloqueia esperando stdin, não crasha
```

`err.log` (glog, capturado após matar o processo):

```
google\api_core\_python_version_support.py:261: FutureWarning: ... Python version (3.10.4) ...
I0916 03:52:59.939079 35348 main.py:80] Starting AGY ACP Server...
I0916 03:52:59.939079 35348 main.py:81] Gemini home resolved to C:\Users\Erick\.gemini (default; $GEMINI_HOME is unset)
I0916 03:52:59.940080 35348 settings.py:302] settings: path=C:\Users\Erick\.gemini\antigravity-acp\settings.json status=missing
```

Três achados novos, nenhum documentado antes:

1. **`agy_acp_server` é Python** (`google.api_core`, `main.py`, `settings.py` — stack trace de
   `warnings.warn`), não Go. O `agy` CLI é Go (doc-base, confirmado por tamanho/strings do binário); o
   servidor ACP é outro runtime dentro do mesmo produto. `[verificado: stderr real do processo]`
2. **Config própria e separada**: procura `~/.gemini/antigravity-acp/settings.json` (**`antigravity-acp`**,
   com hífen, pasta nova) — diferente de `~/.gemini/antigravity-cli/settings.json` que o `agy` CLI usa.
   Nesta máquina esse arquivo **não existe** (`status=missing`). `[verificado]`
3. Não abriu porta TCP nova (`netstat` antes/depois idêntico) e não respondeu a duas tentativas de
   handshake `initialize` via stdio (JSON-RPC newline-delimited e framing `Content-Length` estilo LSP,
   ambas sem retorno em 5–8s) — plausível que, sem `settings.json` preenchido (provavelmente escrito pela
   extensão IDE do Antigravity no primeiro uso), o servidor fique em um estado de espera que não avança
   com uma sondagem crua. **Não caracterizo isso como "não funciona"** — só que **o lançamento isolado
   sem a extensão IDE associada não foi suficiente para completar um handshake ACP nesta sessão**.
   `[verificado: teste local]` para o comportamento observado; `[não verificável neste teste]` para se o
   protocolo funcionaria com o `settings.json` correto.

Custo operacional relevante para a ADE: **468 MB de download** por plataforma só para o servidor ACP —
se o `ade doctor` for baixar isso automaticamente, é o maior artefato de todos os adapters por uma ordem
de magnitude; entra no orçamento de instalação/CI. `[verificado]`

## 6. Maker ≠ Checker por model id — confirmado com chamada real, não só `agy models` (item 6)

`agy models` (`[verificado]`, idêntico ao doc-base, reconfirmado nesta sessão):

```
gemini-3.8-flash-high/-medium/-low   gemini-3.7-flash-*   gemini-3.6-flash-*
gemini-3.1-pro-high/-low
claude-sonnet-4-6        (Claude Sonnet 4.6 Thinking)
claude-opus-4-6-thinking
gpt-oss-120b-medium
```

**O doc-base nunca tinha provado que esses ids realmente servem o modelo alheio** (só viu a lista).
Testei os dois "estrangeiros" com uma pergunta de auto-identificação:

```
agy -p "Diga em uma frase curta qual modelo de IA voce e..." --model claude-sonnet-4-6
→ {"response":"Sou o **Claude Sonnet 4.6**, desenvolvido pela **Anthropic**.\n", ...}

agy -p "Diga em uma frase curta qual modelo de IA voce e..." --model gpt-oss-120b-medium --output-format stream-json
→ init.model = "gpt-oss-120b-medium"
→ result.response = "Sou o modelo **GPT‑OSS 120B** da **OpenAI**.\n"
```

**Confirmado por chamada real**: `agy --model claude-sonnet-4-6` serve Claude de verdade (o modelo se
autoidentifica corretamente como Anthropic), e `--model gpt-oss-120b-medium` serve o GPT-OSS real
(autoidentifica como OpenAI). O risco do doc-base deixa de ser hipótese: **é fato demonstrado**.
`[verificado: 2 chamadas, resposta do próprio modelo]`

**Achado novo e mais sério que o previsto**: quando `--model` é passado, `init.model` ecoa exatamente o
que foi pedido — mas **nenhum evento (`init`, `step_update`, `result`) reporta o modelo que *de fato*
respondeu quando ele diverge do pedido**. Não existe `usage.models` (breakdown por modelo, como o Gemini
CLI tem em `stats.models`) na saída do `agy` — `usage` é um único objeto agregado, sem chave de modelo.
Ou seja: **se houver fallback silencioso de cota no `agy` (comportamento não documentado, mas o padrão
do produto — ver §8 do doc-base sobre o Gemini CLI trocar de modelo sozinho), o JSON não dá nenhum jeito
de detectar isso.** `[verificado: ausência do campo em 4 execuções distintas]` para o fato de o campo não
existir; `[hipótese]` para se o fallback de cota do `agy` realmente troca de modelo silenciosamente (não
testado — exigiria estourar cota de propósito).

**Regra exata para o engine** (correção da regra do doc-base):

```
familyOf(run) := familyOfModel(request.model ?? DEFAULT_MODEL)
```

onde `familyOfModel` mapeia todo id com prefixo `claude-*` → família `claude`, `gpt-*` → família `openai`,
`gemini-*` → família `gemini`, **independente do binário que fez a chamada**. Como o JSON não confirma o
modelo efetivo, o engine **deve tratar `request.model` como contrato, não como fato observado** — ou
seja, se o papel exige Checker de família diferente do Maker, o adapter **precisa fixar `--model`
explicitamente em todo `spawn()`** (nunca deixar o default do `agy` decidir), e o `ade doctor` deve
registrar como risco aberto que uma troca de modelo por cota, se existir, é invisível ao journal hoje.
Mitigação prática: pedir ao próprio agente, no prompt de sistema do papel de Checker, para **declarar seu
próprio nome de modelo na primeira linha da resposta** (como fiz no teste acima) e o adapter validar essa
declaração contra `request.model` — não é criptograficamente forte, mas é o único sinal disponível além
de confiar no id pedido.

## 7. `google_web_search`/`search_web`: grounding vale a pena? (item 7)

Teste real (não hipotético): pedi para o agente usar a ferramenta de busca para achar a versão LTS atual
do Node.js e exigir URL + trecho literal.

```
agy -p "Use sua ferramenta de busca web (search_web) para descobrir a versao estavel mais recente do
Node.js LTS em 2026-09. Responda com: versao, URL da fonte, e um trecho literal curto..." --output-format json --dangerously-skip-permissions

→ {"response":"- **Versão:** `v24.21.0` (LTS)\n- **URL da fonte:** https://nodejs.org/en/blog/release/v24.21.0\n- **Trecho literal:**\n  > \"2026-09-08, Version 24.21.0 'Krypton' (LTS)\"\n",
   "duration_seconds":108.82,
   "usage":{"input_tokens":273834,"output_tokens":5664,"thinking_tokens":3823,"cache_read_tokens":1274731,"total_tokens":279498}}
```

**A regra proposta funciona e é verificável**: pedir explicitamente URL + trecho literal produz os dois,
e o trecho ("2026-09-08, Version 24.21.0 'Krypton' (LTS)") é checável contra a página real — exatamente o
padrão que `research-finding.schema.json` exige. `[verificado: execução local]`. Continua valendo o ponto
do doc-base — a síntese acontece antes do agente ver a página crua, então "trecho literal" é uma âncora
de auditoria, não prova de que não houve paráfrase da ferramenta de busca; a regra do adapter deve ser
**exigir os dois campos como obrigatórios no schema** (já são, em `evidence[].{url,quote}`) e o Checker
de pesquisa deve, quando o orçamento permitir, buscar a URL para confirmar o trecho — o que o próprio
`agy` já tem via `read_url_content` no seu próprio toolset.

**Achado colateral sério**: `cache_read_tokens` (1.274.731) é **maior que `total_tokens`** (279.498) na
mesma resposta — aritmeticamente impossível se `total_tokens` fosse a soma de todos os campos de `usage`.
`[verificado: dado bruto acima]`. Conclusão: **`cache_read_tokens` não está escopado à chamada atual**
(parece ser um contador cumulativo de sessão/processo, não resetado por request) e **`total_tokens` não é
`input+output+thinking+cache_read`** — é outra coisa (mais próximo de `input+output+thinking` nos outros
testes desta sessão, mas não teria como confirmar sem mais amostras). `[verificado: anomalia]` `[hipótese]`
para a causa exata. Risco novo para a §7 do doc-base ("Contabilidade da ADE fica em tokens"): **os campos
de `usage` do `agy` não são confiáveis para orçamento por chamada sem normalização** — o engine deve
tratar `total_tokens`/`cache_read_tokens` como aproximados e logar o JSON bruto para auditoria, nunca
somar ingenuamente através de múltiplas chamadas achando que dá o total da sessão.

## 8. CapabilitySet corrigido (só o que foi medido nesta rodada)

Chaves abaixo **sobrescrevem** o CapabilitySet do doc-base (§10 de `capabilities-gemini-antigravity.md`)
onde há divergência; chaves não listadas aqui permanecem como no doc-base, agora marcadas `[herdado,
não remedido nesta rodada]`.

```json
{
  "agy": {
    "version": "1.2.4",
    "versionNote": "auto-atualizou de 1.2.3 para 1.2.4 entre as duas rodadas de pesquisa sem ação do usuário; ade doctor deve reler a cada lote, nunca cachear",
    "verifiedAt": "2026-09-16T2",
    "json": {
      "fields": ["conversation_id", "status", "response", "duration_seconds", "num_turns", "usage", "structured_output?", "json_schema?", "denied_actions?"],
      "usageFields": ["input_tokens", "output_tokens", "thinking_tokens", "cache_read_tokens", "total_tokens"],
      "usageFieldsWarning": "cache_read_tokens observado MAIOR que total_tokens em uma chamada real; total_tokens nao e input+output+thinking+cache_read de forma confiavel; nao somar entre chamadas sem normalizar",
      "modelFieldPresence": "ausente por padrao; so aparece como eco em stream-json init.model quando --model e passado explicitamente na chamada; nenhum evento reporta o modelo EFETIVO se ele divergir do pedido",
      "costField": "nunca observado; usd sempre unknown",
      "conversationIdOrigin": "gerado pelo processo, visivel no evento init (stream-json) ou so no resultado final (json simples); NAO cunhavel antes da chamada (sem --session-id equivalente)"
    },
    "jsonSchema": {
      "flag": "--json-schema",
      "verified": true,
      "mechanism": "campo structured_output separado de response, conforme ao schema mesmo quando o prompt instrui o modelo a desobedecer; json_schema ecoado no resultado para auditoria",
      "recommendation": "adapter de pesquisa deve ler structured_output, nunca fazer parse de response"
    },
    "printTimeout": {
      "default": "5m0s",
      "onTimeout": "exit 0, status ainda SUCCESS, aviso so em stderr ('[agy] print timeout after Ns with turn in progress; returning partial output'), corpo pode vir vazio/zerado",
      "warning": "engine nao consegue distinguir timeout de resposta vazia rapida olhando so o JSON; precisa checar stderr ou duration_seconds"
    },
    "deniedActions": {
      "verified": true,
      "shape": "[{\"action\":\"command\",\"display_name\":\"RunCommand\"}]",
      "trigger": "ferramenta exige permissao 'command' que o modo headless nao pode perguntar (permission_mode default request-review); auto-nega e reporta em denied_actions, status ainda SUCCESS",
      "note": "recusa do MODELO por politica propria (ex.: 'nao apago o hosts') NAO gera denied_actions -- so aparece como texto normal em response"
    },
    "contextWindow": {
      "publishedNumber": null,
      "verifiable": false,
      "indirectEvidence": ["view_file trunca por chamada em ~46KB/800 linhas com paginacao ContentOffset", "changelog confirma existencia de teto ('overflowing the context window') e rejeita arquivos >100MB antes de tentar carregar"],
      "recommendation": "tratar como desconhecida e possivelmente MENOR que os 1.048.576 tokens do Gemini CLI; nao herdar o numero do Gemini CLI por suposicao de mesmo backend"
    },
    "foreignModels": {
      "verified": true,
      "method": "chamada real com --model claude-sonnet-4-6 e --model gpt-oss-120b-medium; modelo se autoidentificou corretamente em ambos os casos",
      "familyRule": "familyOf(run) := familyOfModel(request.model); engine deve sempre passar --model explicito quando Maker != Checker importa, nunca confiar em default"
    },
    "acp": {
      "agyCliHasAcpFlag": false,
      "separateBinaryExists": true,
      "separateBinaryId": "antigravity-acp",
      "separateBinaryRuntime": "Python (nao Go como o agy CLI)",
      "separateBinarySettingsPath": "~/.gemini/antigravity-acp/settings.json (distinto de ~/.gemini/antigravity-cli/ do agy CLI)",
      "downloadSizeWindows": "468238392 bytes (zip), 430801616 bytes (exe extraido)",
      "launchTest": "inicia sem crash, bloqueia em stdio, nao respondeu a 2 tentativas de handshake JSON-RPC (newline e Content-Length) em 5-8s sem settings.json preenchido -- handshake completo nao verificado nesta sessao"
    },
    "webSearch": {
      "toolName": "search_web",
      "verified": true,
      "returnsUrlAndQuote": true,
      "adapterRule": "exigir evidence[].{url,quote} obrigatorios no schema (ja e assim em research-finding.schema.json); tratar quote como ancora auditavel, nao prova; Checker pode confirmar via read_url_content quando orcamento permitir"
    }
  },
  "gemini": {
    "version": "0.59.0",
    "authTypeFlag": null,
    "authSwitchMechanism": "somente via settings.json security.auth.selectedType; env var sozinha nao muda o metodo (testado: GEMINI_API_KEY setada com selectedType=oauth-personal ainda abre prompt de browser)",
    "apiKeyPathVerified": true,
    "apiKeyPathEvidence": "com selectedType=gemini-api-key (settings isolado, sem tocar no ~/.gemini real) e GEMINI_API_KEY invalida de proposito, o CLI chamou generativelanguage.googleapis.com de verdade e recebeu 400 API_KEY_INVALID estruturado -- mecanismo ponta a ponta confirmado, falta so uma chave valida",
    "errorJsonShape": "{\"session_id\":str,\"error\":{\"type\":\"Error\",\"message\":str,\"code\":400}}",
    "viableToday": "condicional: sim via GEMINI_API_KEY/Vertex (mecanismo comprovado), nao via oauth-personal (sem conta ativa nesta maquina, tipo depreciado)"
  }
}
```

## 9. Contrato de saída do papel de pesquisa (`research-finding`)

Com base no que foi realmente exercitado (schema §2 + busca §7), o contrato mínimo verificável para o
step `research` (spec §8) usando `agy`:

```json
{
  "recommendation": "string, obrigatório",
  "alternatives": ["string, obrigatório, pode ser vazio"],
  "evidence": [{"url": "string, obrigatório", "quote": "string literal, obrigatório, <30 palavras"}],
  "confidence": "number 0-1, obrigatório"
}
```

Invocação: `agy -p "<pergunta>" --output-format json --json-schema research-finding.schema.json --model
<id da família pedida> --dangerously-skip-permissions` (headless de pesquisa não deveria bloquear em
permissão — busca web e leitura são baixo risco; **nunca** usar `--dangerously-skip-permissions` para
papéis que escrevem/executam). O adapter deve:

1. Ler `structured_output`, nunca `response`, como o achado.
2. Rejeitar o achado se `denied_actions` não-vazio e a ação negada era `search_web`/`read_url_content`
   (pesquisa capenga é pior que pesquisa nenhuma — reportar como falha, não como achado parcial).
3. Gravar `conversation_id`, `usage` bruto e `json_schema` ecoado no journal para auditoria, sem tentar
   reconciliar `total_tokens` com os demais campos de `usage` (§7).
4. Tratar `request.model` como o dado de família confiável (§6) — não inferir família de nenhum campo da
   resposta.

## 10. Regra de degradação quando a família Gemini está indisponível

Condições de indisponibilidade, em ordem de checagem pelo `ade doctor`:

1. `agy` ausente do PATH → tenta `gemini` com auth não-consumidora (`GEMINI_API_KEY` setada **e**
   `settings.json.security.auth.selectedType != "oauth-personal"`, verificado nesta rodada como a
   combinação que realmente funciona — só a env var não basta, §4).
2. `agy` presente mas `agy models` falha ou devolve lista vazia (cota/rede) → família indisponível para
   este lote.
3. Nenhuma das duas → roteamento cai para Claude + Codex, mantendo Maker ≠ Checker entre essas duas
   (spec §16, já previsto); step `research` roda só com as duas famílias restantes, e o tradutor marca no
   resumo de aprovação que a terceira opinião ficou indisponível.
4. **Novo nesta rodada**: se `agy` responde mas o `--model` pedido não é um dos ids de `agy models` (ex.:
   id descontinuado por atualização silenciosa do produto, §0), tratar como falha de configuração, não
   como família indisponível — o `ade doctor` deve rodar `agy models` a cada lote e cachear a lista por
   no máximo a duração do lote.

## 11. Veredito

**A família Gemini entra na v1, condicional — mesmo veredito do doc-base, agora com as condições
testadas em vez de assumidas:**

1. Binário é `agy` para o papel de pesquisa/CLI headless; `antigravity-acp` (`agy_acp_server`, Python,
   468 MB) é uma **terceira coisa**, opcional, só se a ADE algum dia integrar via ACP em vez de spawn de
   processo — não é necessário para a v1, que já usa spawn de processo com `--output-format json` para
   todos os adapters (spec §5). Não priorizar o download de 468 MB por plataforma no `ade doctor` padrão.
2. `--json-schema` é real e forte — **confirmado**, não é mais a maior lacuna do doc-base.
3. Maker ≠ Checker por model id é real e demonstrado, mas o mecanismo de detecção de fallback de cota
   **não existe hoje na saída do `agy`** — o adapter precisa fixar `--model` sempre e não pode confiar em
   nenhum campo de saída para confirmar o modelo efetivo (correção do doc-base, que assumia paridade com
   `stats.models` do Gemini CLI).
4. `gemini` via `GEMINI_API_KEY`/Vertex é mecanicamente viável hoje, comprovado por uma chamada real que
   chegou ao endpoint do Google; falta só uma credencial de Erick para fechar o teste ponta a ponta.
5. Contabilidade de tokens do `agy` tem uma anomalia real (`cache_read_tokens` > `total_tokens` numa
   chamada) — orçamento por lote não deve somar ingenuamente esses campos entre chamadas.
6. Janela de contexto do `agy` continua **não publicada e não verificável** por esta bateria de testes;
   não deve ser tratada como igual à do Gemini CLI (1M) por suposição de mesmo backend.

## 12. Riscos novos (adição à §16 da spec / §12 do doc-base)

| Risco | Evidência | Mitigação |
| :--- | :--- | :--- |
| `agy` se auto-atualiza sem aviso (1.2.3→1.2.4 entre sessões) | `agy --version` mudou sozinho | `ade doctor` relê versão a cada lote, nunca cacheia entre lotes |
| Nenhum campo do JSON confirma o modelo efetivo se divergir do `--model` pedido | `usage` não tem breakdown por modelo; `init.model` só ecoa o pedido | Fixar `--model` sempre; pedir autoidentificação no prompt de sistema do Checker como sinal adicional |
| `cache_read_tokens`/`total_tokens` inconsistentes entre si numa chamada real | dado bruto §7 | Não somar entre chamadas; logar bruto; tratar como aproximado |
| `--print-timeout` não distingue "vazio rápido" de "estourou" só pelo JSON | teste §1.3 | Checar stderr + comparar `duration_seconds` ao timeout pedido |
| `antigravity-acp` (`agy_acp_server`) é 468 MB por plataforma, runtime Python separado do `agy` Go | download real medido | Não incluir no `ade doctor` padrão da v1; documentar como opcional/futuro |
| `gemini` com `GEMINI_API_KEY` exige mudar `security.auth.selectedType`, a env var sozinha não basta | teste §4 | `ade doctor` deve escrever/checar essa chave de settings, não só a env var |
| `view_file` do `agy` corta a ~46KB/800 linhas por chamada | teste §3 | Adapter de "leitura de base grande" deve paginar via `ContentOffset` explicitamente, não assumir leitura de um arquivo inteiro numa chamada |

## Fontes

**Primárias — execução local nesta sessão (2026-09-16)**
- `agy --version` (`1.2.4`), `agy --help`, `agy models`, `agy changelog`, `agy help agent`
- `agy -p "..." --output-format json` (×6, incluindo `--model claude-sonnet-4-6`, `--model
  gpt-oss-120b-medium`, `--json-schema schema.json` ×2, `--print-timeout 5s`, prompt de `search_web`)
- `agy -p "..." --output-format stream-json` (×2)
- `agy -p "..." --add-dir ... ` lendo `tl-orchestrator-release/_tl-orc/project/evidence/T024-r01/review/checker-stderr.txt` via `view_file`
- `gemini --version` (`0.59.0`), `gemini --help`
- `gemini -p ... --output-format json` com `GEMINI_API_KEY` de teste, `selectedType=oauth-personal` (real) e `selectedType=gemini-api-key` (settings isolado em scratchpad)
- `curl https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (HTTP 200)
- Download e execução de `agy_acp_server.exe` 1.1.1 windows-x86_64 (`https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip`), `err.log` capturado, removido do disco ao final
- `C:\Users\Erick\.gemini\antigravity-cli\settings.json`, `google_accounts.json`, `settings.json` (gemini)

**Primárias — documentos do projeto**
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\capabilities-gemini-antigravity.md` (doc-base desta rodada)
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\landscape-routing-skills-terminal.md` §0.2, §5.3
- `E:\Documentos\ProjetosIA\TL-ADE\docs\research\adapters-and-acp.md` §1.3, §8.4
- `E:\Documentos\ProjetosIA\TL-ADE\docs\specs\2026-09-16-ade-design.md` §5, §8, §13

**Registry / CDN**
- https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-agy_acp_server_1.1.1-windows-x86_64.zip
