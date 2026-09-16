# TL-ADE

Agentic Development Environment — sucessora do tl-orchestrator. Uma ADE local e universal: pedido em
linguagem natural → objetivos em camadas → plano com evals estritos → execução autônoma com Claude
Code, Codex e Gemini/Antigravity → painel com terminais reais dos agentes.

**Estado: planejamento.** Nenhum código ainda.

- Design completo: [`docs/specs/2026-09-16-ade-design.md`](docs/specs/2026-09-16-ade-design.md)
- Fontes do catálogo de skills (vetadas): [`docs/catalog-sources.md`](docs/catalog-sources.md)
- Referência do motor a portar: `tl-orchestrator` v0.17.0 (`scripts/tl_runtime.py`, `docs/RUNTIME.md`,
  schemas JSON e 93 testes como suíte de paridade)

Próximo passo: rodada de rearquitetação com Fable 5.1 — cole [`PROMPT.md`](PROMPT.md) num chat novo
aberto neste diretório. Depois dela: plano de implementação do primeiro vertical slice.
