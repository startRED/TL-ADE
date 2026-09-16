# ADR 0020 — Método de desenvolvimento da própria ADE

**Status:** aceito 2026-09-17 — detalhe em `docs/development-method.md`; este ADR fixa as decisões.

## Contexto

A ADE é construída por um operador só, em meses, com agentes escrevendo a maior parte do código. O risco
não é velocidade — é deslocar a revisão humana para um CI que não existe. A evidência de 2026 é
inequívoca sobre qual variável manda: **a qualidade da malha de portões é independente; a autonomia do
agente é dependente**.

## Decisão

| Eixo | Decisão |
| :--- | :--- |
| Portões | Malha de CI estilo Orca antes de qualquer aumento de autonomia: `tsc --strict` + Vitest desde o commit 1, `oxlint` + `anti-slop` pinado por SHA, root directory guard, ratchets (`max-lines`, `ts-nocheck`, `any`) que só melhoram, `code-quality:changed`, verificação de que todo import novo existe no registry, razão teste:produção visível no corpo do PR |
| Ciclo por story | Skills **Superpowers** já instaladas: `brainstorming → writing-plans → using-git-worktrees → subagent-driven-development + TDD → requesting-code-review → finishing-a-development-branch`. Dois pontos de humano por story, e só dois: aprovar o design e aprovar o merge. **Exceção escrita** (§11 E30): as três superfícies de segurança — `contain`/isolamento, servidor local do painel, ingestão do catálogo — têm revisão humana obrigatória do diff, sempre |
| Repositório | **pacote único na raiz na v1**; npm workspaces só no commit que cria `packages/web`, na v0.4b (§11 E29) |
| Cobertura | ≥85 % de linhas apenas em `journal, step, lease, git, runner, contain` **[hipótese]**; no resto, razão teste:produção visível no corpo do PR, sem portão (§11 E27) |
| Backlog | `docs/plan/features.json` — lista **plana** de features com `id`, `description` end-to-end, `steps`, `eval` (comando) e um único campo gravável pelo agente: `passes`. JSON, não Markdown |
| Escopo | `PROJECT_CHARTER.md` de uma página dizendo o que a ADE **não** é (não é CI, não é issue tracker, não é IDE) |
| Instruções | `AGENTS.md` ≤ 8 KB como roteador de gatilhos; `CLAUDE.md` = uma linha (`@AGENTS.md`); poda semanal pelo critério "remover esta linha faria o agente errar?" |
| Fixtures | Toda regra que lê saída de CLI de agente é escrita contra **transcript gravado byte a byte e commitado**, nunca contra tela lembrada; `scripts/record-transcript.ts` é artefato do **dia 1** (§11 E28) |
| Paridade | `tl-orchestrator` v0.17.0 roda **um** lote: o porte dos 93 testes de `test_tl_runtime.py` para Vitest com os mesmos nomes, guiado pela `parity-name-map.json` como artefato de **entrada** da v0.2. O slice 1 cobre um subconjunto nomeado de **44 casos**; 93/93 é critério da **v0.2** (§11 E26). Dois alvos normativos: `parity` (zero credencial, CI Windows + Linux) e `probes` (chamadas reais, local, opt-in). Nada mais |
| Troca | A partir do sub-projeto 3, a própria ADE constrói a ADE. Ponto de troca verificável, não data |

## Evidência

- `landscape-dev-workflows.md` b1 (Orca, `stablyai/orca`): 11.045 commits e 9.857 PRs merged em 6 meses,
  **zero reviews humanas aprovadas e nenhuma branch protection** — funciona porque há 66 workflows e
  ~30 portões. Contraponto publicado pelo próprio org do Gas City (2026-09-13): **CI success rate
  22,7 %**, 116 de 150 commits em main com CI falhando. Copiar a autonomia sem a malha é o erro
  nomeado (digest #40).
- `landscape-dev-workflows.md` b1, caso `antigravity-readiness-evidence.md`: um detector escrito cinco
  vezes, três piores que o bug que substituíam, a quinta revertida; a correção institucional foi
  **gravador de PTY commitado + fixtures**, não prompt melhor — diretamente aplicável aos adapters.
- Digest #22: o harness de longa duração da Anthropic **não usa DAG** — lista plana de features com um
  único campo gravável (`passes`). Digest #39: Codex trunca `AGENTS.md` a 32 KiB em silêncio e omite
  skills acima de 2 % da janela, daí o teto de 8 KB.
- `landscape-dev-workflows.md` (a): Superpowers já instalado localmente (custo de adoção zero); Beads dá
  o `PROJECT_CHARTER.md` como única defesa documentada contra agente que amplia superfície do produto.
- Digest #1: `test_tl_runtime.py` passa **93/93** no Windows (1 skip) — a paridade é o único trabalho
  volumoso, repetitivo e com critério de pronto binário do projeto (ADR 0003).
- `landscape-dev-workflows.md` b7: segurança de código gerado plana em **45 % de falha desde 2023**
  enquanto a corretude sintática foi a ~95 % (Veracode); pacotes alucinados 5,2 %/21,7 % e repetíveis
  (USENIX Security 2025).

## Trade-offs

Portões custam minutos de CI por PR (Orca paga 54,6–64,9 runner-min) e a malha precisa existir antes de
render. Superpowers e Orca trazem cerimônia que a regra de proporcionalidade tem de conter: se o diff
cabe numa frase, pula brainstorming e plano. Usar o `tl-orchestrator` para um lote só é aceitar
integrar um runtime Python que será substituído — se custar mais de meio dia de adaptação, cai para
`claude -p` em loop sobre a lista de testes (estágio 0), que é a mesma ideia sem integração e que grava
cursor durável no formato de linha do `journal-event` (§11 E28). A v1 completa é estimada em
**~15–16 semanas a 5 dias/semana** (§11 E37); o slice 1 mede linhas portadas por dia na semana 1 e
replaneja explicitamente.

## Alternativas rejeitadas

| Alternativa | Motivo |
| :--- | :--- |
| BMAD / Spec Kit / OpenSpec como método | reescrevem spec e backlog que já existem (ADR 0019) |
| Loop Ralph em `main` | exige `--dangerously-skip-permissions`; o sandbox vira a única fronteira — só em worktree descartável, no lote de paridade |
| `tl-orchestrator` para o projeto inteiro | é o runtime que está sendo substituído; design novo precisa de brainstorming e plano |
| DAG no backlog de desenvolvimento | lista plana com `passes` é o que a Anthropic mede (#22) |
| Declarar autoria por IA no README | correlaciona **negativamente** com maturidade de engenharia; a evidência vai nos trailers de commit e no CI |
| Mutation testing e merge queue na v1 | caro com 93 testes de paridade cobrindo o núcleo; merge queue só faz sentido com N>1 (ADR 0014) |

## Como reverter

**Gatilho:** PRs merged com CI verde na primeira tentativa caírem, ou razão teste:produção degradar.
**Custo:** baixo — portões são arquivos de workflow, adicionar ou remover é local. A regra dura é a
ordem: **nenhum aumento de autonomia sem portão novo**, nunca o inverso.

## Consequências para outros documentos

`docs/development-method.md` (fonte do detalhe), `AGENTS.md` (≤ 8 KB, roteador de gatilhos),
`CLAUDE.md` (uma linha), `PROJECT_CHARTER.md`, `init.sh`, `docs/plan/features.json` e
`docs/plan/progress.md`, `docs/reference/*.md` (nasce vazio, um arquivo por cicatriz),
`package.json` único na raiz até a v0.4b, `.github/workflows/pr.yml` (malha de portões, alvos `parity` e
`probes`), `scripts/record-transcript.ts` e `fixtures/` (transcripts gravados, nunca texto escrito à
mão), `docs/roadmap.md` (ponto de troca no sub-projeto 3; v0.4a/v0.4b; ~15–16 semanas),
ADR 0003 (paridade: 44 casos no slice 1, 93/93 na v0.2), ADR 0019.
