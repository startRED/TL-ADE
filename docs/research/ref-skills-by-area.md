# Skills de referência por área (pedido de Erick, 2026-09-16)

Pergunta: qual é a "taste-skill" de cada área? Fontes varridas: `pbakaus/impeccable`, `Leonxlnx/taste-skill`, `VoltAgent/awesome-agent-skills` (índice; links seguidos), `addyosmani/agent-skills`, `affaan-m/ecc`. Agente sonnet, 27 leituras, fatos verificados nos repositórios (caminho e tamanho); licença conferida no repositório.

Regra já fixada por Erick: **frontend ou design ativa sempre `design-taste-frontend` (taste-skill) e `impeccable`**, inteiras, sem corte. `frontend-design` (Anthropic) entra como terceira. As skills não são editadas.

| Área | Escolha | Caminho | KB | Licença | Por quê | Estado |
| --- | --- | --- | --- | --- | --- | --- |
| Frontend/design | taste-skill + impeccable | `skills/taste-skill/SKILL.md`; `skills/impeccable/SKILL.md` | 88 / 12 | MIT / MIT | Anti-template com regras concretas; detector estático com `detect --json` | instaladas |
| Frontend (redesign, marca) | redesign-skill, brandkit | `skills/redesign-skill`, `skills/brandkit` | 15 / 16 | MIT | Auditoria antes de mexer; tokens de marca | instaladas |
| Backend/API | addyosmani `api-and-interface-design` | `skills/api-and-interface-design/SKILL.md` | 14,9 | MIT | Contrato antes do código, versionamento, regra de breaking change | **instalar** |
| Backend/API (base) | ECC `backend-patterns`, `api-design` | plugin ECC | 14 / 14 | MIT | Já cobrem o essencial | instaladas |
| Banco de dados | ECC `postgres-patterns`, `database-migrations` | plugin ECC | 4 / 12 | MIT | Base suficiente | instaladas |
| Banco (opcional) | supabase `postgres-best-practices` | `skills/supabase-postgres-best-practices/SKILL.md` | 3,2 | MIT | Voz oficial do vendor; só se Supabase | não |
| Testes/TDD | ECC `tdd-workflow`, `python-testing`, `e2e-testing` | plugin ECC | 13 | MIT | O pipeline já impõe vermelho→verde | instaladas |
| Testes (opcional) | LambdaTest `pytest-skill`, `playwright-skill` | `pytest-skill/SKILL.md`, `playwright-skill/SKILL.md` | 4,8 / 11,8 | MIT | Por framework | não |
| Segurança | ECC `security-review` | plugin ECC | 12,7 | MIT | Base | instalada |
| Segurança (opcional) | trailofbits `differential-review` | `plugins/differential-review/skills/differential-review/SKILL.md` | 7,4 | CC-BY-SA-4.0 | Revisão por diff, time de auditoria | não (licença share-alike) |
| Python | ECC `python-patterns` | plugin ECC | 17,5 | MIT | Base | instalada |
| Documentação | addyosmani `documentation-and-adrs` | `skills/documentation-and-adrs/SKILL.md` | 9,8 | MIT | Exige ADR junto do README | **instalar** |
| DevOps/CI | addyosmani `ci-cd-and-automation` | `skills/ci-cd-and-automation/SKILL.md` | 11,3 | MIT | Portões antes de deploy | **instalar** |
| Engenharia geral | addyosmani `code-review-and-quality`, `git-workflow-and-versioning` | `skills/code-review-and-quality`, `skills/git-workflow-and-versioning` | 20,6 / 14,1 | MIT | Critérios objetivos de revisão; convenções de commit/PR | **instalar** |
| Mobile | LambdaTest `appium-skill` | `appium-skill/SKILL.md` | 10,9 | MIT | Só automação; não há "taste" de arquitetura mobile | não |
| Dados/CSV | ClickHouse `chdb-datastore` | `skills/chdb-datastore/SKILL.md` | 5,6 | Apache-2.0 | Nicho; nada de referência para planilha/CSV | não |

Sem achado bom: backend Node/TS a nível de framework; mobile de referência; CSV/planilha dedicado. `openai/skills` não tem arquivo LICENSE no repositório: fora do catálogo até ter.

**Recomendação:** instalar as 5 do `addyosmani/agent-skills` (MIT) com `npx skills add https://github.com/addyosmani/agent-skills --skill <nome>` e ligar no seletor automático: `api-and-interface-design` por domínio backend/api; `documentation-and-adrs` por domínio docs; `ci-cd-and-automation` por palavras deploy/CI; `code-review-and-quality` como referência do revisor (Codex) em vez do maker; `git-workflow-and-versioning` só quando o pedido envolve git/PR.
