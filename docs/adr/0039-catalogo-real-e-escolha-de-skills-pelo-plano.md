# ADR 0039 — Catálogo real de skills e escolha por parte pelo plano (emenda o ADR 0009)

**Status:** Aceito (pedido de Erick, 2026-09-24: a TL-ADE real precisa usar skills e plugins como a demo)

## Contexto

O Skill Fabric do ADR 0009 existia inteiro no código, mas nenhuma missão real usava skill:

1. O `sync` só achava skills em `skills/<nome>/SKILL.md`. As fontes boas medidas em 2026-09-24 guardam as skills
   aninhadas (`skills/engineering/tdd`, `plugins/<x>/skills/<y>`).
2. O plano feito pela IA (`llm-intent`) nunca passava as skills elegíveis adiante; `eligible_skills` saía sempre vazio.
   O seletor por BM25 do compilador heurístico casa descrição em inglês com pedido em português e acerta pouco.
3. As skills de terceiros foram escritas para sessão com humano ("pergunte ao usuário", "chame a skill X"), e a missão
   roda desatendida.
4. O padrão `sensitive_path_env` do SkillGuard (`\.env\b`) acusava `process.env.CI` de exemplo de código e mandava
   metade das skills boas para a quarentena.

## Decisão

1. **Skill é a pasta com `SKILL.md` em qualquer profundidade dos caminhos declarados** da fonte. O índice grava `dir`
   (caminho da pasta na fonte); `inspect` e `loadApprovedSkills` leem de lá, e índice antigo sem `dir` usa o layout
   plano.
2. **O plano escolhe as skills de cada parte.** O prompt de planejamento recebe a lista do catálogo elegível
   (id e descrição) e cada parte devolve `skills` (até 3). Id fora do catálogo é descartado, e
   `authorization.eligible_skills` do plano é a união do que as partes escolheram. É o degrau "seletor" do pipeline
   do ADR 0009, feito pela IA que já lê o projeto.
3. **Cabeçalho desatendido na seção de skills do pack:** onde o guia mandar perguntar ao usuário, decidir pelo
   contrato; ignorar skills, sub-agentes e comandos que o modelo não tem; o contrato e a política valem mais que o guia.
4. **`sensitive_path_env` casa o arquivo `.env`, não a propriedade** `process.env`/`import.meta.env`.

A quarentena por padrão continua intocada: achado real do SkillGuard (`<!--`, `credentials`, `<script`) segue
exigindo revisão humana. A promoção por revisão (controle 6) ainda não tem caminho no código.

## Consequências

- O catálogo sincronizado em `~/.ade/catalog` alimenta a página Skills e as missões do painel.
- As fontes e os pins ficam em `docs/catalog-sources.md` §1.1.

## Como reverter

Voltar `skillDirsUnder`/`skillRel` para a leitura plana em `src/skills/catalog.ts`, tirar `skills` de `PLAN_SCHEMA` e
de `withStory` em `src/intent/llm-intent.ts`, tirar `SKILLS_HEADER` de `src/context/story.ts` e voltar o padrão
`\.env\b` em `src/skills/skillguard.ts`.
