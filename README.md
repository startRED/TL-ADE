# TL-ADE

Agentic Development Environment local e universal, sucessora do tl-orchestrator. Transforma um pedido
em linguagem natural ("corrija esse botão", "refaça o frontend inteiro") em Task Contracts com evals
executáveis, executa com Claude Code e Codex (família Google via Antigravity CLI `agy` depois) sob um
engine durável (journal com cadeia de hash, write-ahead, reconciliação após crash), prova qualidade por
portões e revisão de outra família, e devolve evidência. O usuário pode ser preguiçoso; a inteligência
operacional mora no harness.

## Estado e autorização

- Autorização até a v1: concedida por Erick em 2026-09-19 ([docs/adr/0024-autorizacao-roadmap-ate-v1.md](docs/adr/0024-autorizacao-roadmap-ate-v1.md)).
- Sequência obrigatória dos marcos: v0.2 (durabilidade e paridade 93) -> v0.3 -> v0.4a -> v0.4b -> v0.5 -> v1.
- Recorte ativo deste épico: v0.4a — Skill Fabric (catálogo curado com 12 controles de segurança da cadeia de suprimento, BM25 top-8, seletor de até 3 skills com tetos de 7,5k/20k tokens, aprovação congelada e injeção sanitizada no Context Pack) e Frontend Quality Engine, conforme autorização até a v1 no [ADR 0024](docs/adr/0024-autorizacao-roadmap-ate-v1.md).
- Slice 1: fechamento pendente ([docs/plans/slice-1-fechamento.md](docs/plans/slice-1-fechamento.md)).
- Recorte local v0.2: autorizado sequencialmente ([docs/plans/v02-local-proposta.md](docs/plans/v02-local-proposta.md), [docs/plans/v02-local-aprovacao.md](docs/plans/v02-local-aprovacao.md)).
- Restante da v0.2: segue a ordem do roadmap.
Implementação dependente: autorizada sequencialmente até a v1 conforme o épico ativo.

Repositório canônico: [`startRED/TL-ADE`](https://github.com/startRED/TL-ADE) (público). Autor: Erick.
Trabalho novo entra por branch + PR contra `main`; convenções em [`docs/development-method.md`](docs/development-method.md).

## Leia nesta ordem

1. [`docs/vision.md`](docs/vision.md) — north star, 15 princípios reconciliados, métricas, não-objetivos.
2. [`docs/architecture.md`](docs/architecture.md) — **documento canônico**: tese, componentes, contratos, fluxo de missão, durabilidade, subsistemas, mudanças sobre a spec v2, decisões de Erick confirmadas (§9), adendos do ECC (§10), arbitragem das divergências (§11) e emendas da revisão adversarial (§12, E41–E69).
3. [`docs/specs/2026-09-17-master-spec.md`](docs/specs/2026-09-17-master-spec.md) — spec mestra (substitui a v2) e specs por subsistema em [`docs/specs/`](docs/specs/): engine e durabilidade, Intent Compiler, Skill Fabric, Frontend Quality Engine, adapters e Capability Registry, contexto/Firewall/telemetria, superfície do operador.
4. [`docs/roadmap.md`](docs/roadmap.md) — vertical slices (slice 1 → v0.2 → v0.3 → v0.4a/b → v0.5 → v1 → futuro) com aceite, evals, calendário e escada de dogfood.
5. [`docs/plans/slice-1.md`](docs/plans/slice-1.md) — plano executável do primeiro slice (~3 semanas): stories como Task Contracts, testes nomeados, CLI falsa, método de execução.
6. [`docs/journeys.md`](docs/journeys.md) — as 6 jornadas obrigatórias validadas contra a arquitetura.
7. [`docs/adr/README.md`](docs/adr/README.md) — 22 ADRs (decisão, evidência, trade-offs, reversão).
8. [`docs/evals/README.md`](docs/evals/README.md), [`docs/security/README.md`](docs/security/README.md), [`docs/operations/autonomy-and-permissions.md`](docs/operations/autonomy-and-permissions.md), [`docs/operations/usar-em-outro-projeto.md`](docs/operations/usar-em-outro-projeto.md), [`docs/operations/dogfood-d1.md`](docs/operations/dogfood-d1.md), [`docs/development-method.md`](docs/development-method.md).
9. [`docs/research/README.md`](docs/research/README.md) — índice e digest da pesquisa (40 premissas derrubadas, confirmações, hipóteses a medir); [`docs/catalog-sources.md`](docs/catalog-sources.md) — fontes do catálogo com licença e decisão.

Histórico: [`docs/specs/2026-09-16-ade-design.md`](docs/specs/2026-09-16-ade-design.md) (spec v2, superada) e
[`PROMPT.md`](PROMPT.md) (prompt da rodada; algumas premissas dele foram derrubadas pela pesquisa, ver
`docs/research/README.md`).

## Referência de motor

`tl-orchestrator` v0.17.0 (`E:\Documentos\ProjetosIA\tl-orchestrator-release`): `scripts/tl_runtime.py`,
`docs/RUNTIME.md`, schemas JSON e `scripts/tests/test_tl_runtime.py` (93 casos; passam 93/93 no Windows).
Os 66 invariantes de durabilidade estão catalogados em `docs/research/runtime-port-map.md`.

## Superfície de planejamento e catálogo (v0.4a)

- `ade plan [--request <pedido>] [--repo <pasta>] [--from <missao>] [--non-interactive]`: planeja a missão, gera contratos válidos e apresenta dúvidas necessárias.
- `ade validate [--plan <arquivo>]`: valida deterministicamente planos e contratos sem efeitos colaterais.
- `ade approve --mission <id> --digest <hex>`: aprova e congela duravelmente no journal os efeitos e skills autorizados.
- `ade catalog sync [--rebuild-index]`: sincroniza fontes autorizadas pinadas por commit, executa o SkillGuard e reconstrói o índice atômico.
- `ade catalog list [--domain <d>] [--trust <t>] [--source <s>]`: lista habilidades curadas com filtros de domínio, confiança e fonte.
- `ade catalog inspect <id> [--body]`: inspeciona metadados, achados do SkillGuard e quarentena de uma habilidade sem expor scripts executáveis.
- **Frontend Quality Engine (FQE)**: portões determinísticos D1–D6 (console, rede, contraste AA com axe-core, estados, detector estético e responsividade), juiz multimodal independente com rubrica calibrada em 6 critérios, limite estrito de 2 rodadas de rework e paradas auditáveis (`visual_cut_not_met`, `visual_degraded`, `fqe_unavailable`).

## Próximo passo

Decisões de `docs/architecture.md` §9 confirmadas por Erick em 2026-09-17; conferir as lacunas da matriz em [docs/plans/slice-1-fechamento.md](docs/plans/slice-1-fechamento.md) e responder à consulta única existente em [docs/plans/v02-local-aprovacao.md](docs/plans/v02-local-aprovacao.md). A proposta de metade da cota ainda depende de fonte, janela semanal, consumo externo e tratamento de ausência aprovados; US$ 0,28 do dogfood não medem percentual da assinatura ([docs/operations/dogfood-d1.md](docs/operations/dogfood-d1.md) como fonte do valor e [docs/plans/v02-local-aprovacao.md](docs/plans/v02-local-aprovacao.md) como consulta única cujas regras proíbem inferir percentual a partir de dólares).
