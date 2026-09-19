# ADR 0024 — Autorização para execução sequencial do roadmap até a v1

**Status:** Aceito (confirmado por Erick em 2026-09-19)

## Contexto

O roadmap original e o charter inicial delimitavam o escopo de execução ativa ao Slice 1, com o restante da v0.2 e as versões subsequentes condicionadas a liberações futuras. Em 2026-09-19, o operador Erick concedeu autorização expressa para ampliar o escopo além do Slice 1 até a v1 do roadmap (`docs/roadmap.md`), abrangendo o fechamento da v0.2, a v0.3, a v0.4a, a v0.4b, a v0.5 e a v1.

A governança do projeto estabelece que autorizações de ampliação de escopo não devem alterar ADRs aceitos anteriormente (ADRs 0001 a 0023), devendo ser formalizadas por meio de novo ADR e atualização correspondente do charter e do roadmap.

## Decisão

Registrar formalmente a autorização concedida por Erick para desenvolver o TL-ADE até a v1, estabelecendo os seguintes controles normativos:

1. **Execução sequencial obrigatória:** a autorização ampla até a v1 não autoriza atropelar etapas do roadmap nem misturar fases. O desenvolvimento deve percorrer rigorosamente a sequência de marcos:
   - **v0.2:** durabilidade comprovada, base de paridade dos 93 casos no Windows sem skips, mapa de nomes auditável e contratos de reconciliação;
   - **v0.3:** Intent Compiler, Task Contracts, orçamentos refinados e dogfood nível 2;
   - **v0.4a / v0.4b:** Maker/Checker dual-family (Codex/Claude), Frontend Quality Engine (FQE) e portões de inspeção;
   - **v0.5:** Skill Fabric curada, SQLite indexado e concorrência;
   - **v1:** autonomia completa desatendida (nível 4 de dogfood) com 2 noites comprovadas.

2. **Delimitação estrita do épico atual:** o épico ativo nesta missão encerra-se na durabilidade e na base de paridade da v0.2. Ficam expressamente descartados para este épico: implementação de Checker, rework automático, painel no navegador, PTY ou entrega remota pública real.

3. **Inventário normativo de paridade:** a paridade da v0.2 é fixada no artefato `parity-name-map.json` com exatamente 93 casos mapeados 1:1 a partir de `scripts/tests/test_tl_runtime.py` v0.17.0, executando sob quatro workers isolados e sem dependência de credenciais ou rede.

4. **Preservação dos ADRs 0001–0023:** nenhuma decisão já aceita é editada; a produção segue em JavaScript ESM com JSDoc e `checkJs` (ADR 0023), sobre Node 22+.

## Evidência

- Autorização expressa registrada por Erick em 2026-09-19: *"Eu, Erick, autorizo ampliar o escopo além do slice 1 até a v1; registre essa autorização como emenda (ADR novo e charter), sem editar ADR aceito."*
- `docs/roadmap.md` descreve a taxonomia de marcos e os critérios objetivos de cada fase.

## Trade-offs

Permite que a execução prossiga de forma autônoma e durável rumo à v1 sem interrupções artificiais de escopo, mantendo a blindagem arquitetural e a verificação estrita de cada marco antes de avançar para o próximo.

## Alternativas rejeitadas

| Alternativa | Motivo do descarte |
| :--- | :--- |
| Liberar todo o roadmap de uma vez no código de produção | Causa perda de controle arquitetural, quebra de contratos intermediários e inviabiliza auditoria de paridade |
| Editar retroativamente os ADRs 0001 a 0023 | Viola a regra de imutabilidade de decisões aceitas e obscurece a trilha histórica de auditoria |
| Ignorar a autorização e manter a execução bloqueada no Slice 1 | Contraria o pedido explícito e autorização do operador |

## Como reverter

Revogação expressa documentada por Erick restringindo o escopo a um marco específico ou congelando o avanço na v0.2.

## Consequências para outros documentos

- `PROJECT_CHARTER.md`: atualiza a seção "Estado e autorização" registrando a autorização até a v1 com execução sequencial e limite do épico atual na v0.2.
- `docs/roadmap.md`: atualiza "Estado e autorização" alinhando a autorização até a v1, a ordem mandatória dos marcos e o recorte deste épico.
- `docs/adr/README.md`: indexa o ADR 0024 na tabela de ADRs e no mapa temático.
