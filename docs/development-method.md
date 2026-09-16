# Método de desenvolvimento da própria TL-ADE

Data: 2026-09-17. Escopo: como a TL-ADE é construída — ferramental, portões, artefatos, convenções e a
escada de dogfood até a ADE construir a si mesma. Não repete a arquitetura; referencia
`architecture.md §N`. Fontes de evidência: `docs/research/landscape-dev-workflows.md`,
`docs/research/landscape-harnesses.md` §1 e §3, e o digest (`docs/research/README.md`, "digest #N").
ADR correspondente: `docs/adr/0020-metodo-de-desenvolvimento-da-propria-ade.md`.

## 1. Princípio

**O portão substitui o humano; o modelo não** (`architecture.md §1`). Orca (`stablyai/orca`) fecha
~9,9k PRs em 6 meses com zero revisão humana `APPROVED` e nenhuma branch protection — porque tem ~30
portões de CI e 8.858 arquivos de teste; Gas City, com a mesma autonomia e sem malha, publicou 22,7 %
de CI verde e 116 de 150 commits em `main` quebrados (digest #40, `landscape-dev-workflows.md` §b1 e
§b5). A malha de verificação é a variável independente; a autonomia é a dependente. Consequência
operacional deste documento: **nenhum aumento de autonomia sem portão novo primeiro**.

Segundo princípio, herdado do harness de longa duração da Anthropic: plano de controle em código,
chamadas curtas, estado durável fora do modelo (`landscape-harnesses.md` §1.3, convergência de cinco
fontes primárias). O método de construir a ADE é a mesma forma que a ADE implementa — por isso cada
estágio abaixo é dogfood, não analogia.

Terceiro: **cerimônia proporcional**. Se o diff cabe numa frase, não há plano, não há brainstorming,
não há story — vai direto ao ciclo curto. BMAD v6.12 e Agent OS v3 chegaram a essa regra recuando do
próprio processo (`landscape-dev-workflows.md` §a, linhas BMAD e Agent OS).

## 2. A escada de dogfood

| Estágio | Quem executa | Entrada | Saída | Gatilho de saída |
| :--- | :--- | :--- | :--- | :--- |
| **0 — bootstrap** | Claude Code (Maker) + Codex (Checker) dirigidos por Erick; `tl-orchestrator` v0.17.0 ou `claude -p` em loop **só** no lote de paridade | `docs/plan/features.json` derivado do roadmap | engine núcleo, adapters, CLI falsa, slice 1 verde | slice 1 fecha uma story dela mesma ponta a ponta |
| **1 — ADE executa stories dela mesma** | `ade run --plan` com `plan.json` escrito à mão; depois `ade plan` | stories do próprio backlog da ADE | v0.2 e v0.3 construídas majoritariamente pela ADE | `ade "<pedido>"` ponta a ponta (v0.3) sem intervenção em ≥3 stories seguidas |
| **2 — ADE conduz fases** | `ade run` com Intent Compiler e Skill Fabric | um pedido em linguagem natural por fase | v0.4 em diante; jornadas 2–5 | jornada 6 (desatendida) em dogfood na v1 |

O ponto de troca é verificável, não uma data (`landscape-dev-workflows.md` §c5): cada estágio começa
quando o anterior fecha um critério binário. A regra de release — antes de cada versão, a ADE constrói
uma story dela mesma — é a régua contínua.

### 2.1 Estágio 0

Duas ferramentas, dois papéis, desde o dia 1:

- **Maker**: Claude Code com as skills Superpowers já instaladas (`brainstorming → writing-plans →
  using-git-worktrees → subagent-driven-development → test-driven-development →
  requesting-code-review → finishing-a-development-branch`). Custo de adoção zero: já está na máquina
  (`landscape-dev-workflows.md` §a, linha Superpowers). `writing-plans`/`executing-plans` são o
  esqueleto de toda a infraestrutura do estágio 0.
- **Checker**: Codex, `codex exec --json --sandbox read-only --ignore-user-config --output-schema
  review-result.schema.json` — o mesmo comando que o engine vai emitir na v0.2 (`architecture.md §7`,
  digest #6). Usar o comando final desde o dia 1 é como o schema `review-result` ganha fixtures reais
  antes de existir código que o consuma. `--ignore-user-config` é obrigatório: o piso de chamada do
  Codex headless é ~19,4k tokens de entrada (digest #27).

O **lote de paridade** (93 testes de `test_tl_runtime.py` portados para Vitest com os mesmos nomes, mais
a tabela de mapeamento onde o schema mudou) é o único trabalho do projeto com o perfil em que um loop
autônomo ganha: volumoso, repetitivo, critério de pronto binário (digest #1,
`landscape-dev-workflows.md` §c5). Regra de corte: se rodar `tl-orchestrator` v0.17.0 neste repositório
custar mais de meio dia de adaptação, cai para `claude -p` em loop sobre a lista de testes — mesma
ideia, sem a integração. Em qualquer dos dois casos o loop roda **em worktree descartável, em branch
próprio, nunca em `main`**: Ralph exige `--dangerously-skip-permissions` e o worktree passa a ser a
única fronteira (`landscape-dev-workflows.md` §c7).

Fora do lote de paridade, nada de loop autônomo no estágio 0. Design novo (journal, cadeia de hash,
scheduler, adapters) vai pelo ciclo completo da §5, porque parsing de saída de CLI é a superfície em
que agentes erram sistematicamente (§6 deste documento).

### 2.2 Estágio 1

A ADE recebe `plan.json` escrito à mão (slice 1) e depois planos que ela mesma gera (v0.3). O risco
próprio deste estágio é a ADE se autodanificar ao se construir. Duas defesas já estão na arquitetura e
não precisam de código novo: `contain` pós-fato com `scope_paths`/`do_not_touch`
(`architecture.md §3`, C7) e o `runtime_stamp` divergente bloqueando missão aberta
(`architecture.md §6`) — ver a divergência D1 na §11.

### 2.3 Estágio 2

A ADE conduz fases inteiras a partir da v0.3/v0.4. A entrada humana por fase cai para: o pedido, a
aprovação única (`architecture.md §5`, passo 9) e as decisões em `awaiting_operator`. O indicador de
que o estágio 2 pegou é o mesmo do North Star: intervenções humanas por story em queda com eval pass
estável.

## 3. Artefatos do dia 1

| Artefato | Conteúdo | Teto | Origem |
| :--- | :--- | :--- | :--- |
| `PROJECT_CHARTER.md` | Uma página: o que a ADE **não** é (não é CI, não é issue tracker, não é IDE, não é hospedagem). Gate de escopo | ~20 linhas | Beads (`landscape-dev-workflows.md` §b5, §c6.2) |
| `AGENTS.md` (raiz) | Como buildar/rodar/testar + **roteador de gatilhos**: cada regra termina apontando um arquivo em `docs/reference/`. Invariantes e comandos. Nunca estilo, nunca status, nunca log | **≤ 8 KB**, alvo 2,5k tokens | Orca; digest #39 (Codex trunca AGENTS.md a 32 KiB e omite skills acima de 2 % da janela, em silêncio) |
| `CLAUDE.md` | Uma linha: `@AGENTS.md` | 1 linha | Orca (`§b1`) |
| `init.sh` | `npm ci`, build, teste rápido, `ade doctor`. Toda sessão começa lendo-o | — | Anthropic long-running harness (`landscape-harnesses.md` §1.1) |
| `docs/plan/features.json` | Feature list plana, **um único campo gravável pelo agente: `passes`** | — | Anthropic harness (`landscape-harnesses.md` §3.1.1; digest #22) |
| `docs/plan/progress.md` | Notas de sessão, append-only | — | Anthropic harness |
| `docs/reference/*.md` | Vazio no dia 1. Um arquivo por cicatriz, escrito **no momento** do erro | — | Orca (`§b1`: 40 arquivos, um por cicatriz) |
| `.github/workflows/pr.yml` | Malha da §4 | — | Orca |

**O que entra no AGENTS.md**: invariantes do repositório (o engine é o único que roda `git`/`gh`; nada
de `.ade/` em commit; `{pack_path}` sempre, nunca `{pack_text}`), comandos (build, teste, paridade,
doctor) e gatilhos de leitura. **O que nunca entra**: estilo de código (é portão, não instrução),
status do projeto, histórico, e qualquer instrução que o modelo resolveria sozinho. Poda **semanal**
pelo critério da Anthropic: *"remover esta linha faria o agente errar?"* — se não, sai
(`landscape-dev-workflows.md` §c6.3). Conhecimento condicional vai para skill ou `docs/reference/`.

A feature list é JSON e não Markdown por um motivo medido: o modelo sobrescreve Markdown com mais
facilidade (`landscape-dev-workflows.md` §c1). Campo único `passes` elimina, sem vigilância, a falha de
"agente reescreve o critério até passar" (`landscape-harnesses.md` §3.1.1) — é o mesmo invariante que o
`TaskContract.passes` carrega na arquitetura (`architecture.md §4`).

## 4. A malha de portões

Ordem de implementação, do mais barato ao mais caro. Os itens 1–4 e 8 são do dia 1; o resto entra com a
fase que os torna significativos.

| # | Portão | Comando / forma | Quando entra | Bloqueia merge |
| :-- | :--- | :--- | :--- | :--- |
| G1 | Tipos | `tsc --noEmit` (strict, ESM) | dia 1 | sim |
| G2 | Lint anti-slop | `oxlint` + `dmmulroy/anti-slop` **pinado por SHA** (`no-unknown-parameters`, `no-unknown-returns`, `no-chained-type-assertions`, `no-widen-then-assert`, `require-safety-comment-for-type-assertion`), **vendorizado** | dia 1 | sim |
| G3 | Testes + cobertura | `vitest run --coverage`, mínimo por pacote; queda de cobertura é falha | dia 1 | sim |
| G4 | Root directory guard | ~20 linhas de CI: arquivo novo na raiz é rejeitado | dia 1 | sim |
| G5 | Ratchets | `max-lines`, `ts-nocheck`, `any` — a métrica só melhora; suprimir a regra é **proibido por escrito** no AGENTS.md | dia 1 | sim |
| G6 | Paridade | 93/93 do `test_tl_runtime.py` nos dois SOs, com tabela de mapeamento de nomes onde o schema mudou (digest #1) | v0.2 | sim |
| G7 | Fixtures de transcript | todo `parseEvents` de adapter roda contra transcript gravado; fixture ausente = falha | com o primeiro adapter | sim |
| G8 | Schema validation | todo JSON de exemplo em `docs/` e `fixtures/` validado por ajv contra os 8 schemas publicados (`architecture.md §4`) | dia 1 | sim |
| G9 | Lint de docs e links | links relativos existem; ADRs referenciados existem; tabelas fecham | dia 1 | sim |
| G10 | Supply chain | `npm audit` + `osv-scanner` + **verificação de que todo import novo existe no registry**; lockfile commitado; **dependência nova é decisão humana** | dia 1 | sim |
| G11 | CI Windows + Linux | matriz nos dois SOs para toda a suíte; Windows é a máquina alvo, Linux é o CI | dia 1 | sim |
| G12 | `code-quality:changed` | lint pesado só nas linhas alteradas | quando o CI virar gargalo | sim |
| G13 | Revisão por outra família | Codex (`codex exec --output-schema`) sobre o diff + a story; `changes_requested` bloqueia | dia 1 | sim (passo do ciclo, não job de CI) |
| G14 | Razão teste:produção | tabela automática no corpo do PR, não threshold global. Referência: Cloudflare em 1,9:1 | v0.2 | não (visível) |

Não fazer na v1: mutation testing (caro, retorno baixo com G6 cobrindo o núcleo) e merge queue com
bisecting (só se paga com N agentes concorrentes; a arquitetura fixou N=1 —
`landscape-dev-workflows.md` §c3).

**Meta de zero revisão humana, com a malha como condição.** A meta só vale onde a malha cobre. Ela
**não** vale em três superfícies, onde revisão humana é obrigatória sem exceção: `contain` e o
isolamento por worktree, o servidor local do painel (v0.4, só `127.0.0.1`), e a ingestão do catálogo de
skills de terceiros (`docs/security/README.md`). Motivo na §7.

## 5. O ciclo por story no estágio 0

```
1. brainstorming           (Superpowers)   → design curto        [HUMANO aprova]
2. writing-plans           (Superpowers)   → tarefas de 2–5 min, caminhos exatos
3. using-git-worktrees                     → worktree + branch, baseline limpa
4. subagent-driven-development + TDD       → implementer fresco por tarefa, eval antes do código,
                                             teto de 5 rounds de fix
5. portões locais G1–G5, G8–G10 antes de qualquer commit
6. Checker Codex (G13), contexto mínimo: diff + a story
7. PR pequeno, corpo-relatório (§5.1) → CI (G11) → merge commit (`--merge`, nunca squash)
8. finishing-a-development-branch → limpa worktree               [HUMANO decide merge]
```

Dois pontos de humano por story, e só dois. Entre eles o agente não pergunta, exceto operação
irreversível, ação de segurança ou efeito fora do worktree (`landscape-dev-workflows.md` §c2). Regra de
cerimônia proporcional: **se o diff cabe numa frase, pula 1–2**.

### 5.1 Corpo de PR como relatório de evidência

Quatro seções obrigatórias (Orca, `§b1` e `§c4`):

1. **O que mudou** e por quê — um parágrafo.
2. **Eval executado** — comando e saída; o eval falharia sem a mudança? (é o mesmo
   `must_fail_before` de `architecture.md §7`, aqui na forma manual).
3. **Controle negativo** quando a verificação é de parsing ou detecção: a flag inexistente retorna 0, a
   real retorna 1.
4. **O que NÃO foi verificado** — lista explícita. *"Não consegui determinar X e não vou chutar"* é
   conclusão aceitável e preferível a um chute.

PR pequeno é regra, não estilo: PR grande derrota G12 e derrota o Checker, que perde precisão com
contexto grande.

## 6. Fixtures são gravações, nunca telas lembradas

Toda regra que lê saída de CLI de agente — os `parseEvents` dos adapters `claude`, `codex`, `agy` — é
escrita contra um transcript capturado byte a byte e commitado como fixture. Texto escrito à mão não
conta; a CLI falsa por família (`architecture.md §3`, C12) replica o transcript, não uma idealização
dele.

Evidência: o Orca documentou um detector de saída de CLI **escrito cinco vezes**; três das quatro
primeiras eram piores que o bug que substituíam, a quinta foi revertida, e nenhuma das cinco percebeu
que a condição comum a todas nunca casava com uma tela real. A correção institucional não foi prompt
melhor — foi um gravador de PTY commitado + fixtures + a regra escrita
(`landscape-dev-workflows.md` §b1, §c6.1). Custo na ADE: um script de gravação (~50 linhas). Retorno:
uma classe inteira de bug que já queimou cinco tentativas em outro projeto.

Corolário: quando uma CLI muda o formato de saída (o `gemini` → `agy` de 2026-06-18 é o precedente,
digest #2), a resposta é regravar a fixture e ver G7 falhar — não ajustar o parser contra memória.

## 7. Riscos e os portões que os cobrem

| Risco | Evidência | Portão |
| :--- | :--- | :--- |
| **Segurança plana em 45 %** de amostras de código gerado reprovadas em teste de segurança desde 2023, enquanto a corretude sintática subiu de ~50 % para ~95 % (Veracode, 150+ modelos, 80 tarefas) | `landscape-dev-workflows.md` §b7 | G10 + **revisão humana obrigatória** nas três superfícies da §4. O portão de que a ADE mais precisa é justamente aquele em que o modelo menos ajuda |
| **Pacotes alucinados**: 5,2 % (comercial) / 21,7 % (OSS), **repetíveis** → sequestráveis (USENIX Security 2025, 2,23M amostras) | idem | G10: import novo verificado no registry; **allowlist** de pacotes no `AGENTS.md` (a lista de deps da v1 é fechada: `canonicalize`, `ajv`, `playwright`, `better-sqlite3` na v0.4); lockfile commitado; dependência fora da allowlist é decisão humana |
| Escalação de privilégio e falhas de design subindo (Apiiro, ~62k repos, 10× vs dez/2024) | idem | G13 com `category: 'bad_spec' \| 'intent_gap'` no `review-result`; `target_role: 'human'` escala |
| Erosão de manutenibilidade: duplicação +81 %, refatoração −70 % (GitClear, 623M mudanças) | idem | G5 (ratchets) + G12 + o princípio da Anthropic: "a cada modelo novo, deletamos código" |
| Adapter quebra quando a CLI muda a saída | Orca; digest #2 | G7 + `ade doctor` com chamada real (`architecture.md §3`, C13) |
| Over-processo para um operador só | Agent OS v3; BMAD v6.12 | cerimônia proporcional (§5) |
| Métrica auto-reportada virando meta | 810× do gstack, US$297/US$50k do Ralph, METR autodesqualificado, 8× da Anthropic com caveat do próprio autor | medir localmente só: PRs com CI verde na primeira tentativa, razão teste:produção, intervenções por story. Nenhum número de terceiro vira meta |

## 8. Beads como três primitivas, não como ferramenta

O backlog da ADE precisa de exatamente três coisas de `gastownhall/beads`, e todas já cabem no engine
(`landscape-dev-workflows.md` §a, linha Beads — **REFERENCE**, não instalar):

| Primitiva | Forma na ADE | Onde |
| :--- | :--- | :--- |
| `ready` | `Scheduler.next_ready()` devolve o conjunto de stories sem `depends_on` aberto | `architecture.md §3`, C14 |
| claim atômico | `lease` por `mkdir` + heartbeat + fingerprint; exit 5 em conflito | C3 |
| id por hash | id de story/step derivado de hash (`bd-a1b2`), zero conflito de merge entre lotes | C1/C14 |

Nada de `bd` no `PATH`, nada de MCP, nada de grafo separado do `plan.json`. O DAG é adição da ADE sobre
a lista plana do harness da Anthropic (digest #22) e só se paga quando há dependência real — num lote
sem dependências o scheduler degenera em "próxima não bloqueada", e está certo assim
(`landscape-harnesses.md` §1.3, ressalva 2).

## 9. Convenções

**Commits.** Conventional commits em português: `feat(engine): journal com cadeia de hash`,
`fix(adapters): resolver .exe real atrás dos shims npm`, `docs(adr): 0021 versionamento do journal`.
Escopos: `engine`, `adapters`, `intent`, `skills`, `fqe`, `cli`, `docs`, `ci`, `fixtures`.
Saída de agente termina com `Co-Authored-By:`; correção feita à mão pelo humano diz isso na mensagem
(`Corrige à mão o bug que o agente errou 3×`). Isso torna a razão IA/humano mensurável por `git log` e
é a única convenção de autoria com precedente auditável (`landscape-dev-workflows.md` §b3: Cloudflare;
§b5: Beads). O commit mais valioso do histórico do `workers-oauth-provider` é um que declara
*"THIS CODE HAS A BUG"* — registrar fracasso é parte da convenção, não exceção a ela.

**Branches.** `slice/<n>-<slug>` no estágio 0, `story/<id>` no estágio 1+ (é o mesmo nome do worktree em
`.ade/wt/<story>`, `architecture.md §2`). O loop autônomo do lote de paridade vive em
`batch/parity-<n>` e nunca toca `main`.

**Releases.** Tag por marco do roadmap (`v0.2`, `v0.3`, …). Condição de release, além da malha verde:
**a ADE constrói uma story dela mesma** naquela versão, com o journal da missão anexado à release.
`ENGINE_VERSION` é o que pina Impeccable (nunca versão npm, digest #19) e o que compõe o `runtime_stamp`
(`architecture.md §6`).

**Merge.** Merge commit, nunca squash — a arquitetura depende de reconciliação contra o remoto por
classe de efeito (`architecture.md §3`, C22) e squash apaga a correspondência entre step e commit.

## 10. Métricas do método

Coletadas do próprio repositório, semanalmente, sem ferramenta nova:

| Métrica | Fonte | Alvo |
| :--- | :--- | :--- |
| PRs merged com CI verde na primeira tentativa | `gh api` | ≥ 80 % `[hipótese]` |
| Razão teste:produção | G14 | ≥ 1,5:1 `[hipótese]`; referência Cloudflare 1,9:1 |
| Intervenções humanas por story | journal (estágio 1+) / contagem manual (estágio 0) | queda monotônica entre versões |
| Stories que fecham com zero `eval_run` vermelho | journal | ≈ 0; qualquer ocorrência é suspeita de eval frouxo (`landscape-harnesses.md` §3.1.5) |
| Tamanho do `AGENTS.md` | `wc -c` | ≤ 8 KB, tendência de queda após cada poda |
| Arquivos em `docs/reference/` | `ls` | cresce; cada um é uma cicatriz que não se repete |

Nenhuma métrica de LOC por dia. A própria Anthropic ressalva que LOC é métrica imperfeita e que o "8×"
"é quase certamente exagero" (`landscape-dev-workflows.md` §b2).

## 11. Divergências propostas

**D1 — `runtime_stamp` estrito torna o estágio 1 impraticável sem uma exceção declarada.**
`architecture.md §6` fixa: `runtime_stamp` divergente numa intenção aberta bloqueia a missão
(`stale_workflow_version`) até `--accept-stale-version`, e "a ADE em dogfood nunca muda o engine embaixo
de uma missão sem passar por isso". No estágio 1 o engine muda várias vezes por dia — é o próprio objeto
da missão. Na prática, toda missão longa da ADE sobre si mesma morre no primeiro merge, e o operador
passa a usar `--accept-stale-version` por reflexo, que é o modo conhecido de um portão virar ruído (os
93 % de aprovação de prompts de permissão do Claude Code, `landscape-dev-workflows.md` §b2). Proposta:
separar `runtime_stamp` em `engine_version` e `config_digest`, e bloquear só quando a divergência tocar
componentes com estado no journal (C1, C2, C4, C5) — mudança em `fqe`, `skills` ou `cli` não invalida
uma intenção aberta. Evidência: `architecture.md §6`; `landscape-dev-workflows.md` §b2.

**D2 — `npm workspaces` com um único pacote na v1 é cerimônia sem consumidor.** A stack fixa
`packages/core` como único pacote até `packages/web` na v0.4. Workspaces com um membro adiciona um
nível de diretório, um `package.json` a mais, resolução de caminho que confunde os portões G4 (root
guard) e G12, e resolve zero problemas até existir o segundo pacote. Proposta: pacote único na raiz na
v1; introduzir workspaces no commit que cria `packages/web`, que é exatamente quando a migração é
trivial e o benefício existe. Evidência: nenhuma fonte de pesquisa recomenda workspaces por antecipação;
`landscape-dev-workflows.md` §c7 registra over-processo como risco medido (Agent OS v3 recuou do próprio
escopo pelo mesmo motivo).

**D3 — "zero revisão humana como meta" precisa da exceção de segurança escrita ao lado da meta.** O
roadmap fixa a meta com a malha como condição. Mas a evidência mais dura do levantamento é que a taxa de
falha de segurança de código gerado está plana em 45 % desde 2023 enquanto a corretude sintática foi a
95 % (Veracode) — ou seja, a malha não cobre justamente o eixo em que o modelo menos ajuda; e o
`workers-oauth-provider`, revisado por especialistas em segurança linha a linha, ainda assim recebeu dois
CVEs medium, com a advisory atribuindo a falha ao revisor humano (`landscape-dev-workflows.md` §b3, §b7).
Proposta: a meta é "zero revisão humana **fora das três superfícies de segurança**" (`contain`/isolamento,
servidor local do painel, ingestão do catálogo), declarada assim no roadmap e no ADR 0020, em vez de
"zero" com a exceção escondida no documento de riscos. Sem isso, a meta como escrita convida a relaxar
exatamente onde não se pode.

**D4 — o gravador de transcript merece ser artefato do dia 1, não do primeiro adapter.** A arquitetura
lista a CLI falsa por família em C12 e a matriz de crash como critério de aceite do slice 1, mas não
nomeia o gravador. Proposta: `scripts/record-transcript.ts` (~50 linhas) entra nos artefatos do dia 1
(§3), porque a primeira sondagem manual de `claude -p` e `codex exec` no estágio 0 já produz os
transcripts que o adapter vai consumir semanas depois — gravar depois significa gravar contra uma CLI
que já mudou de versão. Evidência: `landscape-dev-workflows.md` §b1 (cinco tentativas do Orca);
digest #2 (a família Google já trocou de binário uma vez neste ciclo).

## 12. Perguntas em aberto

1. Custo de adaptação do `tl-orchestrator` v0.17.0 para rodar o lote de paridade neste repositório: a
   regra de corte é meio dia, mas o número não foi medido. `[hipótese]`
2. Cobertura mínima de G3: percentual por pacote ainda não escolhido. Threshold global é ruim (é o que
   G14 substitui); a alternativa é cobertura só das linhas alteradas. `[hipótese]`
3. Qual família revisa o quê no estágio 0. CR-bench dá a Claude 32,1 % de pass rate contra 20,1 % do
   Codex, e ao Codex 88 % de precisão contra 78 % (digest #5). O ciclo da §5 usa Codex em G13 por
   precisão; se o estágio 0 sofrer mais de defeito escapado que de ruído, o papel inverte. Medir por
   defeitos escapados nas primeiras 20 stories. `[hipótese]`
4. Frequência real da poda do AGENTS.md: semanal é o alvo herdado do time do Claude Code; se o arquivo
   não crescer, a poda vira ritual vazio. `[hipótese]`
5. Se o estágio 1 deve exigir que a ADE rode em worktree de si mesma (auto-hospedagem estrita) ou se
   pode operar sobre o checkout principal com `contain` como única defesa. A resposta muda o risco de
   auto-dano da §2.2.
