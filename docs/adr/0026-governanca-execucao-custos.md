# ADR 0026 — Governança de execução, controles de custos e preflight na v0.2

**Status:** Aceito (confirmado por Erick em 2026-09-20)

## Contexto

O desenvolvimento da TL-ADE avançou do fechamento do Slice 1 para a v0.2. Em 2026-09-20, o operador Erick concedeu autorização expressa para ampliar a execução autônoma sequencial até a v1 do roadmap (`docs/roadmap.md`), abrangendo o fechamento da v0.2, a v0.3, a v0.4a, a v0.4b, a v0.5 e a v1.

A governança do projeto estabelece que essa ampliação deve ser formalizada como novo ADR e atualização da Carta, sem alterar ou editar retroativamente nenhum ADR aceito (ADRs 0001 a 0025).

Adicionalmente, antes de iniciar chamadas pagas de modelos ou etapas de implementação dependente da v0.2, faz-se imperativo definir os controles prévios de governança, preflight determinístico com portas injetadas, reservas e tetos de execução, limites provisórios de custos e cotas por família de modelo, preservando a contenção e as barreiras humanas intransponíveis.

## Decisão

Com base na autorização concedida por Erick em 2026-09-20, estabelecer os seguintes controles normativos:

1. **Autorização até a v1 e recorte ativo de governança da v0.2:**
   - Formalizar o desenvolvimento sequencial até a v1 sob a autorização literal de Erick:
     *"Eu, Erick, autorizo ampliar o escopo além do slice 1 até a v1; registre essa autorização como emenda (ADR novo e charter), sem editar ADR aceito."*
   - O recorte ativo de governança da v0.2 cobre durabilidade, preflight determinístico puro, reservas, tetos de execução, cotas por família, relatórios e criticidade de passos antes de qualquer chamada paga.
   - Não aprova automaticamente revisão independente (Checker), fallback de fornecedor ou entrega remota pública, tópicos que permanecem estritamente fora deste recorte e vinculados aos épicos seguintes do roadmap.

2. **Padrões provisórios de execução e custos:**
   - **Teto absoluto de US$ 300:** uma reserva cujo total acumulado seja maior ou igual a US$ 300 (absolute_usd_cap: 300) será terminantemente recusada antes do despacho da chamada.
   - **Cota semanal de 50% por assinatura:** limite de 50% (weekly_quota_percent: 50) consultado por família; a porta de consulta exige recibo oficial com `used_percent`, `reserved_percent`, `observed_at` e `weekly_reset_at`. Na ausência de fonte oficial comprovada, o adaptador padrão devolve `unavailable`. Fica expressamente vedado inferir percentual por contagem de tokens, dólares ou soma ingênua de assinaturas.
   - **Tempo de parede máximo:** teto de 8 horas de parede (wall_clock_hours: 8).
   - **Unidades estacionadas:** limite operacional de no máximo 3 unidades estacionadas (parked_units: 3).
   - **Turnos provisórios por classe:** limite de turnos fixado em `proof: 14`, `implementation: 30`, `correction: 20` e `review: 10`.
   - **Limites de contexto:** contrato de 32000 bytes e Context Pack de 120000 bytes.
   - **Espaço livre mínimo em disco:** 1 GiB de espaço disponível para preflight.
   - **Validade temporal de sonda:** capacidade de acesso e conectividade verificada tem validade de 24 horas.
   - **Custo desconhecido:** custo não medido permanece `null` com `cost_source: 'unknown'` e é contabilizado separadamente, pois ausência de medição não equivale a custo zero.
   - **Criticidade efetiva de passo:** todo passo interno assume criticidade padrão `required`; a classificação `enhancement` é restrita a declarações intencionais e explícitas.

3. **Preflight determinístico puro e ordem de checagem:**
   - O preflight é implementado como caso de uso determinístico isolado via portas injetadas (`Record<string, PreflightCheckPort>`), desacoplando as regras puras de validação de efeitos colaterais de I/O, processos ou sondas de rede.
   - As verificações são avaliadas rigorosamente na ordem fixa `PREFLIGHT_CHECK_ORDER`:
     1. `proof_target`
     2. `dependencies`
     3. `build`
     4. `worktree`
     5. `input`
     6. `credential`
     7. `disk`
     8. `external_access`
   - O cálculo de chamadas pagas evitadas (`calls_avoided`) é obtido pelo saldo restante do orçamento entre chamadas planejadas (`planned_paid_calls`) e já consumidas (`consumed_paid_calls`) caso o preflight resulte bloqueado (`ready: false`).

4. **Barreiras humanas obrigatórias:**
   - Qualquer intervenção, decisão ou alteração que afete áreas críticas exige aprovação humana mandatória do operador Erick antes de prosseguir:
     - `segurança`;
     - `permissões`;
     - `regras de aprovação`;
     - `mudanças do plano de controle` (`control_plane_change`), incluindo regras, schemas, gates, roteamento, contain e journal.
   - Vedada autoaprovação pelo executor autônomo (D1).

5. **Códigos de saída e integridade do repositório:**
   - Os códigos de saída seguem a taxonomia fechada de `AdeError`: erro de configuração usa exitCode 4 (`preflight_input_invalid`), recusa de integridade usa exitCode 2 e estacionamento operacional usa exitCode 3.
   - Preservação integral e imutável dos ADRs 0001 a 0025.
   - Nenhuma dependência externa adicionada em produção (JavaScript ESM com JSDoc sob Node 22+).

## Evidência

- Autorização expressa e diretriz de barreiras humanas concedidas por Erick:
  *"Eu, Erick, autorizo ampliar o escopo além do slice 1 até a v1; registre essa autorização como emenda (ADR novo e charter), sem editar ADR aceito."*
  *"Não me pergunte coisa pequena, resolva sozinho. Só pare e me chame quando for algo que realmente precisa de mim: uma decisão que só eu posso tomar, um risco sério, ou uma mudança em parte crítica do sistema (segurança, permissões, regras de aprovação). Fora isso, siga trabalhando até terminar ou até esbarrar em algo assim."*
- `docs/roadmap.md`: taxonomia dos marcos até a v1.
- `docs/architecture.md` §7, §9.8, §11: limites de orçamento, autonomia Maker/Checker e regras de contenção.

## Trade-offs

- **Segurança preventiva:** impede despachos com risco de estourar teto financeiro ou exaurir cotas de forma silenciosa antes da validação da árvore de dependências e permissões.
- **Rigor determinístico:** a validação com portas puras desacopla testes e auditoria de variações instáveis de ambiente e rede.
- **Conservadorismo provisório:** tetos fixados em US$ 300, 50% de cota semanal e 8 horas de parede impõem paradas operacionais se não houver confirmação oficial da assinatura.

## Alternativas rejeitadas

| Alternativa | Motivo do descarte |
| :--- | :--- |
| Editar retroativamente ADRs 0001–0025 para unificar a governança | Viola o princípio fundamental de imutabilidade e a instrução expressa de Erick |
| Espalhar verificações de preflight diretamente no motor sem portas puras | Contamina as regras de negócio puras com I/O acidental e dificulta testes determinísticos |
| Inferir cota semanal por contagem de tokens ou dólares | Inseguro: inexiste conversão pública garantida entre dólares e percentual contratual da assinatura |
| Considerar custo ausente como zero | Mascara consumo real; ausência de medição deve ser tratada como custo desconhecido |
| Inferir criticidade de passo pelo nome | Risco de degradação silenciosa; criticidade padrão deve ser estritamente required |
| Introduzir novos códigos de saída no runtime | A tabela pública de códigos de saída é fechada (exitCode 2, 3, 4, 5) |

## Como reverter

Revogação expressa documentada por Erick ou emissão de novo ADR com atualização dos parâmetros provisórios e limites orçamentários.

## Consequências para outros documentos

- `docs/adr/README.md`: inclui o ADR 0026 no índice e mapeia o tema "Orçamento e execução".
- `PROJECT_CHARTER.md`: atualiza o escopo para o recorte ativo de governança da v0.2, consolidando os padrões provisórios e mantendo as exclusões dos marcos seguintes.
