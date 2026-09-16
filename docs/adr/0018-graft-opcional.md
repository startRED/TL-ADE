# ADR 0018 — Graft como dependência opcional, com fallback silencioso para `rg`

**Status:** aceito 2026-09-17

## Contexto

O context discovery do Intent Compiler e o Context Pack precisam responder perguntas arquiteturais
("onde X é decidido", "quem depende de Y") sem abrir N arquivos. `trailhq/Graft` faz exatamente isso —
grafo markdown + grafo estrutural tree-sitter, local, sem servidor — e já está integrado no runtime de
referência (`tl_graft.py`, `docs/GRAFT.md`). A pergunta não é se serve; é se a ADE pode depender dele.

## Decisão

**ADOPT como dependência opcional**, portando `tl_graft.py` e `docs/GRAFT.md` quase inalterados em vez
de reprojetar. Regras de isolamento, todas herdadas:

| Regra | Conteúdo |
| :--- | :--- |
| Instalação | cache local por worktree (`.ade-graft-cache/`), nunca global nem no `PATH`; auto-excluído de git e de `rg` antes de instalar |
| `graft init` | **nunca roda** — escreveria em `.claude/`, `AGENTS.md`, `~/.codex/`; a ADE é dona desses arquivos (ADR 0020) |
| Camada `--deep` | inatingível: chaves de provedor removidas do `env` do subprocesso (I49) |
| Telemetria | `DO_NOT_TRACK=1` forçado |
| Frescor | `graft check` obrigatório antes de aceitar resposta; `stale_graph` cai para `rg` |
| Falha | ausência de Node/npm, timeout, erro ou grafo velho → `rg`/leitura direta, **sempre silencioso**, nunca "o código não existe" e nunca bloqueia a story |
| Papel | grafo é **dado sobre código**, nunca skill nem instrução; não entra no bloco de skills do pack |
| Versão | pinado por commit, como toda fonte externa (ADR 0009) |

Graft fica **fora** da v1 (`architecture.md` §3, linha de cortados: "Graft (opcional v0.x)").

## Evidência

- `ref-graft.md`, Veredito e §4: ADOPT por portar, não por reavaliar; o desenho de isolamento do
  tl-orchestrator já resolve os três riscos (supply chain pós-install, vazamento de credencial, resposta
  obsoleta silenciosa).
- `ref-graft.md` §2: MIT, 8.112 estrelas, push diário, ~1 release a cada poucos dias — mas **bus factor
  baixo-médio** (dois mantenedores concentram a maioria dos commits) e patrocinador comercial
  (trailhq/NanoNets) com produto pago cross-promovido no README.
- `ref-graft.md` §1, Windows: `install_failed` em raiz de caminho longo por dependência nativa compilada
  (mitigado por raiz curta + `core.longpaths`, ADR 0022); issues abertas #360, #393, #384, #323, #385
  confirmam atrito Windows-específico — nenhuma fatal.
- `ref-graft.md` §4 e a tabela de alternativas: o benchmark do README (+42 % tokens, +46 % tool-calls;
  SWE-bench Verified 66 % vs 54 %) é **medição deles, no repo deles** — não adotar como verdade para a
  ADE. O Context Pack + skills + evals já cortam parte da mesma exploração redundante, então o ganho
  incremental pode ser menor. **[hipótese]**
- Confirmações do `README.md` de pesquisa: "Graft: ADOPT como dependência opcional com fallback
  silencioso para rg (porte de `tl_graft.py`); ganho real a medir no dogfood".
- `ref-graft.md` §3: sem sobreposição com o Skill Fabric — skill é instrução de terceiro, grafo é mapa
  do código do usuário; as cautelas de supply chain de skills não se aplicam, e vice-versa.

## Trade-offs

Uma dependência nativa a mais no caminho de descoberta, com histórico de atrito no Windows e bus factor
baixo — mitigado por ser opcional e por todo caminho de falha cair em `rg`. Em troca, perguntas
arquiteturais deixam de custar N leituras de arquivo no pack do Intent Compiler. O preço de manter o
fallback é que **duas rotas de descoberta** precisam existir e ser testadas.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| Graft como dependência obrigatória | bus factor baixo-médio + dependência nativa que já falhou em Windows (`ref-graft.md` §2, §1) |
| `graft init` (wiring nativo do Graft) | escreveria em `.claude/`, `AGENTS.md` e `~/.codex/`, que a ADE controla |
| Camada `--deep` (LLM) | uma chamada de modelo por arquivo, exige chave de provedor; fere o princípio "sem chave de API" |
| CodeGraph / Potpie / GitNexus | nomes ambíguos, projetos recentes, alegações sem harness público (`ref-graft.md`, tabela) |
| Serena MCP | consulta LSP ao vivo por pergunta, sem cache de prosa; e MCP no caminho automático é rejeitado (ADR 0019) |
| Aider repo-map | puramente estrutural, sem camada de explicação; e o Aider está sem push desde 2026-05 (#24) |

## Como reverter

**Gatilho para promover a padrão-ligado:** o eval pareado de `ref-graft.md` §4 (mesma story, braço A =
pack + `rg`, braço B = pack + graft-first, repo >50 arquivos, linguagem de fidelidade alta) mostrar
redução de tokens/tool-calls **sem** piorar a taxa de aceite do eval. **Gatilho para remover:** upstream
abandonado, mudança de licença, ou o fallback `rg` empatando no eval. **Custo de remover:** apagar o
helper e o cache; nada no journal ou no contrato depende de Graft, porque o resultado dele entra no pack
como contexto recuperado comum.

## Consequências para outros documentos

`docs/catalog-sources.md` (linha `trailhq/Graft` como dependência opcional, pinada por commit),
`docs/specs/intent-compiler.md` (context discovery com duas rotas e fallback silencioso),
`docs/specs/` (`ade doctor` reporta presença do Graft e em que rota o discovery opera),
`docs/roadmap.md` (Graft fora da v1, opcional na v0.x), ADR 0011 (achado do Graft entra como contexto
recuperado, sob o teto de 6k), ADR 0017 (eval pareado na lista do harness doctor), ADR 0022 (raiz curta
e `core.longpaths`).
