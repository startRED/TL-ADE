# ADR 0005 — Duas famílias na v1, `agy` na v0.x, Maker ≠ Checker por `model_id`

**Status:** aceito 2026-09-17, pendente de confirmação do Erick (`architecture.md` §9.2 e §9.3)

## Contexto

A spec v2 assumia três famílias na v1 e um binário `antigravity`. A pesquisa derrubou as duas
premissas: o binário não existe e a família Google utilizável é o Antigravity CLI (`agy`), que serve
modelos de outras famílias e já foi flagrado escrevendo fora do diretório autorizado.

## Decisão

v1 com **duas** famílias: `claude` (Claude Code 2.1.271) e `codex` (Codex CLI 0.154.0). A família Google
é `agy` (Antigravity CLI 1.2.x), entra na **v0.x** com papel de pesquisa e fallback de Checker, e só
depois de o canário de isolamento por família passar — até lá, somente-leitura. Modo desatendido do
`agy` é `--dangerously-skip-permissions`; `--approval-mode yolo` é flag do Gemini CLI e nunca é usada.
O Gemini CLI não faz parte da ADE. A separação Maker ≠ Checker é verificada por **`model_id`**, nunca
por binário, e reforçada por `models[].vendor` no `CapabilitySet`: o Checker de rodada recusa vendor
igual ao do Maker (E10). Sem família de Checker disponível, a story vai para `parked`
(`no_checker_family_available`), nunca "aprovada sem revisão".

## Evidência

- Digest #2: o binário `antigravity` nunca existiu; `agy` está instalado e autenticado em
  `%LOCALAPPDATA%\agy\bin\agy.exe` (1.2.x, auto-atualiza). `gemini` 0.59.0 só funciona com
  `GEMINI_API_KEY`/Vertex e o OAuth pessoal está morto nesta máquina.
- Digest #3: `agy` serve `claude-sonnet`, `claude-opus-thinking` e `gpt-oss` — chavear papel por binário
  produziria Maker e Checker no mesmo modelo sem ninguém perceber.
- Digest #38: `agy` escreveu em `~/.gemini/antigravity-cli/scratch/` em vez do `--add-dir` pedido, **sem
  aviso**. Daí o canário por família ser pré-condição, e não teste opcional.
- Digest #36: o 4º provider natural (OpenCode) custa o princípio "sem chave de API obrigatória", porque
  não usa a assinatura Claude.
- `judgment-J1-implementability.md` §4, falha fatal 4: terceira família na v1 para satisfazer
  Maker ≠ Checker, critério que duas já satisfazem pelo `model_id`.
- Digest #35: `antigravity-acp` é projeto separado do `agy`, com binário Windows publicado sem sha256.

## Trade-offs

Com duas famílias, indisponibilidade de uma leva stories a `parked` em vez de degradar para um terceiro
revisor — escolha deliberada (revisão fraca é pior que fila). `agy` auto-atualiza, então o
`CapabilitySet` dele precisa de re-sondagem por `ade doctor` mais frequente que as outras — o
`capabilities_digest` do `runtime_stamp` (E7) existe para tornar um `agy` 1.2.3 → 1.2.4 visível no
journal. Adiar a
família Google adia também a diversidade de juiz visual em cenários onde Claude é o Maker.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Gemini CLI como família | exige `GEMINI_API_KEY`/Vertex; viola "sem chave de API obrigatória" (digest #2) |
| `agy` como Maker na v1 | isolamento violado e não explicado (digest #38) |
| OpenCode como 4º provider | chave de API obrigatória; plugins de assinatura removidos (digest #36) |
| `antigravity-acp` | binário Windows sem sha256; projeto separado do `agy` (digest #35) |
| Maker ≠ Checker por binário | `agy` serve modelos Claude (digest #3) |

## Como reverter

Gatilho: canário de isolamento do `agy` passando em todas as fases, ou necessidade medida de terceiro
revisor. Custo: um `CapabilitySet` medido, um adapter (casca fina, ADR 0004) e o canário por chamada;
o roteamento por papel já aceita primário + 2 fallbacks sem mudança de schema.

## Consequências para outros documentos

`schemas/capability-set.schema.json`, `docs/specs/` (adapters, roteamento, canário de contenção),
`~/.ade/capabilities.json` e `~/.ade/routing.jsonl`, ADR 0004, ADR 0006, ADR 0015, ADR 0016.

## Emendas (2026-09-17)

- E66: a telemetria de `model_call` passa de `model` único para `models: { role: 'executor' | 'advisor'; model_id }[]`; a separação Maker ≠ Checker por `model_id` e por vendor passa a valer para **todo** papel da chamada, não só para o Checker. `--advisor` só entra na receita quando o modelo do advisor é observável em `modelUsage` (sonda do doctor); até lá o Maker roda sem `--advisor`.
