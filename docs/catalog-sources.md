# Registro de fontes do catálogo — vetado em 2026-09-16

Verificação: API do GitHub em 2026-09-16; todos ativos (push recente), nenhum arquivado.
Classificação decide o caminho de entrada na ADE: **skill** (sincroniza para `~/.ade/catalog/`),
**ferramenta** (integra num portão ou componente), **inspiração** (não integra; informa design).

## Fontes de skills (sincronizadas)

| Fonte | Estrelas | O que traz |
| :--- | ---: | :--- |
| `anthropics/skills` | 176k | Repositório oficial de Agent Skills; base do catálogo |
| `affaan-m/ECC` | 259k | Everything Claude Code: skills, instincts, memória, segurança, research-first; multi-CLI (Claude, Codex, Opencode, Cursor) |
| `ComposioHQ/awesome-claude-skills` | 75k | Lista curada — a sincronização segue os links e ingere só repositórios com `SKILL.md` válido |
| `ayghri/i-have-adhd` | 46k | Disciplina de saída: impede o agente de enterrar a resposta |
| `ibelick/ui-skills` | 8.5k | Skills de design engineering para UI |
| `UditAkhourii/adhd` | 4.2k | Tree-of-thought com poda para trabalho criativo/interdisciplinar |
| `img2threejs/img2threejs` | — | Imagem de referência → modelo Three.js procedural com gate de qualidade |
| `FloWritesCode/fwc-swiftui-skills` | — | SwiftUI moderno |
| Skills locais de Erick | — | Impeccable, tl-impeccable-design, frontend-design (prioridade sobre catálogo) |

## Ferramentas (integradas, não sincronizadas como skill)

| Fonte | Estrelas | Papel na ADE |
| :--- | ---: | :--- |
| `trailhq/Graft` | 8.1k | Embutido no harness: grafo por worktree, contexto graft-first (spec §12) |
| `dmmulroy/anti-slop` | 4.5k | Regras Oxlint anti-slop → portão de lint em projetos TS (spec §9) |
| `alibaba/open-code-review` | 29k | Revisão híbrida determinística+LLM → candidato a reforçar o Checker (backlog v2) |
| `reticlehq/reticle` | 663 | Percepção de runtime web/desktop → candidato do loop visual (backlog v2) |
| `edonadei/caliper` | 133 | A/B de skills/MCPs/regras com custo → poda medida do harness (spec §12, backlog v2) |

## Inspiração (não integra)

| Fonte | Estrelas | Por quê |
| :--- | ---: | :--- |
| `Q00/ouroboros` | 5.9k | Agent OS com loop de evolução orçado; ideia para o backlog de auto-melhoria |
| `JayPokale/Chisle` | 402 | Economia de tokens em três eixos — já coberto pelas tl-tools (rtk/caveman/ponytail) |

## Capacidades das CLIs (fontes da matriz, spec §13)

- Codex + gpt-image-2 embutido (skill `$imagegen`, 16 imagens de referência, 1K/2K/4K):
  [codex.danielvaughan.com](https://codex.danielvaughan.com/2026/04/27/codex-cli-image-generation-gpt-image-2-visual-development-workflows/),
  [community.openai.com](https://community.openai.com/t/introducing-gpt-image-2-available-today-in-the-api-and-codex/1379479)
- Comparativo 2026 (Claude implementador, Codex revisor/CI, Gemini contexto 1M; migração do consumo
  para Antigravity CLI em 2026-06-18):
  [tembo.io](https://www.tembo.io/blog/codex-vs-claude-code-vs-gemini-cli),
  [intuitionlabs.ai](https://intuitionlabs.ai/articles/claude-code-vs-codex-vs-gemini-cli-comparison),
  [amux.io](https://amux.io/guides/claude-code-vs-codex-vs-gemini-cli/)
