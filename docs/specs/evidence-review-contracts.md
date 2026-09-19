# Especificação dos Contratos de Evidência e Revisão (v2)

Esta especificação define os contratos formais, versionados e verificáveis para os resultados de execução (`unit-result`) e resultados de revisão (`review-result`) da arquitetura TL-ADE.

---

## 1. Visão Geral e Princípios

1. **Versionamento Estrito e Imutabilidade do Histórico**:
   - Os contratos correntes de `unit-result` e `review-result` adotam `format_version: 2`.
   - Cópias imutáveis da versão 1 são mantidas em `schemas/legacy/*.v1.schema.json` para permitir leitura histórica e auditoria, sem permitir que resultados antigos aprovem o fluxo novo.
   - Migrações silenciosas ou aceitação de formato antigo como aprovável são proibidas.

2. **Revisões Vinculadas ao Conteúdo**:
   - `contract_revision`: literal `sha256:<64 hex minúsculos>`, representando o hash criptográfico do contrato da tarefa.
   - `input_revision`: objeto estruturado `{ "tree": "<40 ou 64 hex minúsculos>", "digest": "sha256:<64 hex minúsculos>" }`, separando o estado da árvore Git e o digest canônico dos insumos.

3. **Tipagem Estrita de Referências**:
   - Todas as referências, inclusive `sources` dos dois envelopes e `handoff.claims[].sources`, utilizam exclusivamente os formatos tipados abaixo:
     - `eval:<id>` com id correspondendo a `[A-Za-z0-9._-]+`
     - `gate:<id>` com id correspondendo a `[A-Za-z0-9._-]+`
     - `artifact:<caminho-relativo>` caminho relativo sem raiz ou `..`
     - `source:<seção>@sha256:<64 hex minúsculos>`
     - `file:<caminho-relativo>#L<início>-L<fim>` com números de linha positivos e caminho relativo sem raiz ou `..`
     - `trace:<id>` com id correspondendo a `[A-Za-z0-9._-]+`
   - Texto livre como evidência foi descartado.

4. **Separação de Papéis e Vocabulário**:
   - O Executor (Maker) produz `unit-result` e apenas entrega trabalho para conferência; ele nunca aprova o próprio trabalho.
   - O Revisor (Checker) produz `review-result` e é a única entidade autorizada a emitir veredito de aprovação no fluxo corrente.

---

## 2. Contrato de Unit-Result (v2)

### Entradas
O envelope `unit-result` é produzido pelo Executor ao término da execução de uma rodada ou story e recebe como insumos de entrada:
- O contrato de tarefa com seu hash `contract_revision` (`sha256:<64 hex>`).
- O estado da árvore Git antes e depois da execução (`input_revision.tree`).
- O digest canônico dos arquivos e variáveis de entrada (`input_revision.digest`).
- Registros de execução de evals e gates (`eval_records` e `gate_records`).
- Fontes consultadas durante a execução (`sources`).

### Saídas
O envelope de saída gerado pelo Executor possui a seguinte estrutura de campos:
- `format_version`: inteiro fixo `2`. Origem: constante do contrato v2.
- `contract_revision`: string literal `sha256:<64 hex minúsculos>`. Origem: digest do contrato da tarefa executada.
- `input_revision`: objeto com `tree` e `digest`. Origem: commit/árvore Git de trabalho e hash dos insumos.
- `story_id`: string identificando a story. Origem: identificador da tarefa em execução.
- `state`: string enum `['ready_for_verification', 'failed', 'parked']`. Origem: status de encerramento do executor.
- `phase`: string enum `['red', 'make', 'green', 'gate']`. Origem: fase do ciclo TDD em que a execução finalizou.
- `requested_action`: string enum `['verify', 'rework', 'decide']`. Origem: ação solicitada pelo executor para a orquestração.
- `round`: inteiro positivo. Origem: contador incremental da rodada atual.
- `evidence`: array de objetos `{ "criterion": string, "result_ref": string, "input_digest": string }`. Origem: provas coletadas pelo runner de testes e checagens.
- `handoff`: objeto estruturado de transição contendo:
  - `claims`: array de `{ "id": string, "statement": string, "evidence_refs": string[], "sources": string[] }`; cada item de `evidence_refs` e `sources` deve ser uma referência tipada conforme a seção 1, nunca texto livre ou caminho sem prefixo.
  - `unknowns`: array de `{ "id": string, "question": string }`.
  - `questions_for_owner`: array de perguntas contendo pelo menos duas opções `{ "id": string, "label": string }`.
  - `deltas`: array de `{ "kind": "added" | "changed" | "removed", "ref": string }` onde `ref` utiliza prefixo tipado.
  - `next_action`: string que deve repetir exatamente o valor de `requested_action`.
  - `notes`: string informativa respeitando o teto de tamanho.
- `sources`: array de referências tipadas conforme a seção 1 às fontes consumidas. Origem: manifesto de arquivos lidos, representados por referências com prefixo e formato permitidos.
- `reason`: string resumindo o resultado da rodada. Origem: justificativa do executor.

Limites estritos:
- `notes`: máximo de 500 bytes (avaliado via `Buffer.byteLength(texto, 'utf8')`).

### Exemplo Literal de Unit-Result v2
```json
{
  "format_version": 2,
  "contract_revision": "sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
  "input_revision": {
    "tree": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
  },
  "story_id": "ADE-S2",
  "state": "ready_for_verification",
  "phase": "green",
  "requested_action": "verify",
  "round": 1,
  "evidence": [
    {
      "criterion": "CA1",
      "result_ref": "eval:E1",
      "input_digest": "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    }
  ],
  "handoff": {
    "claims": [
      {
        "id": "claim-1",
        "statement": "Contratos documentados com suporte a entradas e saídas tipadas",
        "evidence_refs": ["eval:E1"],
        "sources": ["file:docs/specs/evidence-review-contracts.md#L1-L200"]
      }
    ],
    "unknowns": [
      {
        "id": "U1",
        "question": "Qual a latência média aceitável para validação de revisão pelo Checker?"
      }
    ],
    "questions_for_owner": [
      {
        "id": "Q1",
        "question": "Deseja habilitar modo estrito para limites de caracteres?",
        "options": [
          { "id": "opt-yes", "label": "Sim, rejeitar com código 4" },
          { "id": "opt-warn", "label": "Não, emitir apenas alerta" }
        ]
      }
    ],
    "deltas": [
      {
        "kind": "added",
        "ref": "file:docs/specs/evidence-review-contracts.md#L1-L200"
      },
      {
        "kind": "added",
        "ref": "file:src/review/validate.js#L1-L30"
      }
    ],
    "next_action": "verify",
    "notes": "Trabalho pronto e verificado localmente em conformidade com as regras de TDD."
  },
  "sources": [
    "file:docs/specs/evidence-review-contracts.md#L1-L200"
  ],
  "reason": "Todos os critérios de aceite foram implementados e testados com sucesso."
}
```

---

## 3. Contrato de Review-Result (v2)

### Entradas
O envelope `review-result` é gerado pelo Revisor (Checker) durante a conferência independente do trabalho entregue pelo Executor. Recebe como entradas:
- O `unit-result` gerado na rodada com suas evidências e handoff.
- O contrato da tarefa e seu digest `contract_revision`.
- O estado do código e árvore de trabalho referenciados em `input_revision`.
- A lista de referências confirmadas e válidas (`verified_refs`) fornecida pelo motor de execução.

### Saídas
O envelope de saída gerado pelo Revisor contém:
- `format_version`: inteiro fixo `2`. Origem: constante do contrato v2.
- `contract_revision`: string literal `sha256:<64 hex minúsculos>`. Origem: digest verificado do contrato.
- `input_revision`: objeto `{ "tree": string, "digest": string }`. Origem: confirmação da árvore e insumos sob revisão.
- `verdict`: string enum `['approved', 'changes_requested']`. Origem: deliberação da revisão.
- `findings`: array de objetos descrevendo apontamentos encontrados:
  - `severity`: enum `['critical', 'high', 'medium', 'low']`. Origem: criticidade do apontamento.
  - `category`: enum `['patch', 'bad_spec', 'intent_gap']`. Origem: taxonomia do defeito.
  - `target_role`: enum `['maker', 'planner', 'human']`. Origem: responsável pela resolução.
  - `location`: string indicando onde o apontamento ocorre. Origem: arquivo ou identificador.
  - `problem`: string resumindo o problema (máximo 220 caracteres). Origem: constatação da revisão.
  - `evidence_refs`: array de referências tipadas demonstrando a falha. Origem: evals, gates ou arquivos.
  - `required_action`: string indicando a correção necessária. Origem: recomendação do revisor.
- `requested_action`: string enum `['verify', 'rework', 'decide']`. Origem: próximo passo indicado.
- `deferred`: array de apontamentos postergados. Origem: itens aceitos para etapas posteriores.
- `rejected`: array de apontamentos rejeitados. Origem: itens considerados falsos positivos ou fora de escopo.
- `sources`: array de referências tipadas conforme a seção 1 inspecionadas durante o processo de revisão. Origem: manifestos e arquivos lidos, representados por referências com prefixo e formato permitidos.
- `summary`: string resumindo o parecer da revisão (máximo 400 caracteres). Origem: síntese do revisor.

Limites estritos:
- `problem`: máximo de 220 caracteres.
- `summary`: máximo de 400 caracteres.

### Exemplo Literal de Review-Result v2
```json
{
  "format_version": 2,
  "contract_revision": "sha256:a1b2c3d4e5f60718293a4b5c6d7e8f90123456789abcdef0123456789abcdef0",
  "input_revision": {
    "tree": "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    "digest": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"
  },
  "verdict": "approved",
  "findings": [],
  "requested_action": "verify",
  "deferred": [],
  "rejected": [],
  "sources": [
    "file:docs/specs/evidence-review-contracts.md#L1-L200",
    "file:src/review/validate.js#L1-L30"
  ],
  "summary": "Revisão independente concluída com aprovação formal; todos os contratos e invariantes foram respeitados."
}
```

---

## 4. Tabela de Estados e Separação de Responsabilidades

Existe uma barreira estrita entre a submissão do trabalho pelo executor e a sua aprovação pela revisão independente:
- `ready_for_verification` pertence somente ao executor.
- `approved` pertence somente à revisão corrente validada.

Em nenhuma hipótese o estado de entrega do executor é interpretado como aprovação do fluxo:
> **Regra Fundamental**: `ready_for_verification não aprova`. O estado `ready_for_verification` sinaliza exclusivamente que o Executor finalizou sua rodada e entrega o pacote para auditoria.
> **Regra de Veredito**: `approved exige revisão corrente`. O veredito pertence somente à revisão validada sobre o conjunto atual de insumos e contrato.

| Estado / Veredito | Papel Exclusivo | Significado no Contrato |
| :--- | :--- | :--- |
| `ready_for_verification` | Executor (Maker) | Trabalho pronto para verificação; `ready_for_verification não aprova` |
| `failed` | Executor (Maker) | A execução da unidade falhou ou não atingiu verde |
| `parked` | Executor (Maker) | Execução pausada aguardando deliberação de bloqueio |
| `approved` | Revisor (Checker) | Revisão independente válida aprovou o resultado; `approved exige revisão corrente` |
| `changes_requested` | Revisor (Checker) | Revisão independente identificou apontamentos que exigem correção |

Os efeitos e as transições do motor decorrentes desses estados e vereditos ficam reservados para story própria; este contrato define somente os resultados e a separação de responsabilidades.

---

## 5. Erros de Validação e Códigos de Falha

A validação de envelopes e regras de negócio de aprovação é realizada por `src/review/validate.js` e pelo validador estrutural de schemas. Todos os erros de conformidade e rejeição retornam mensagens em português e encerram a operação com código 4 (`code: 4`), prevenindo qualquer aprovação acidental ou silenciosa:

1. `unsupported_result_format` (código 4):
   - **Descrição**: O envelope fornecido possui versão incompatível ou não suportada (exigido `format_version: 2`).
   - **Mensagem**: Formato de resultado não suportado; esperado format_version 2.

2. `stale_contract_revision` (código 4):
   - **Descrição**: O hash `contract_revision` informado no resultado não confere com o sha256 do contrato corrente da tarefa.
   - **Mensagem**: Revisão de contrato desatualizada ou divergente do contrato corrente.

3. `stale_input_revision` (código 4):
   - **Descrição**: A árvore Git (`tree`) ou o digest de insumos (`digest`) referenciados no resultado divergem do estado atual sob inspeção.
   - **Mensagem**: Revisão de insumos desatualizada em relação à árvore ou insumos correntes.

4. `unverified_reference` (código 4):
   - **Descrição**: Uma referência tipada apontada em `evidence_refs`, `claims` ou `findings` não consta no conjunto de `verified_refs` validado pelo motor.
   - **Mensagem**: Referência tipada não verificada pelo ambiente de execução.

5. `claim_without_evidence` (código 4):
   - **Descrição**: Um claim ou finding aponta para uma evidência inexistente no array `evidence` do resultado.
   - **Mensagem**: Declaração ou apontamento sem evidência correspondente no resultado.

6. `next_action_mismatch` (código 4):
   - **Descrição**: O campo `handoff.next_action` diverge do valor declarado em `requested_action`.
   - **Mensagem**: Incompatibilidade entre next_action do handoff e requested_action do resultado.

7. `notes_too_large` (código 4):
   - **Descrição**: O conteúdo textual de `handoff.notes` excede o limite máximo permitido de 500 bytes UTF-8 (verificado via `Buffer.byteLength(texto, 'utf8')`).
   - **Mensagem**: Campo notes excede o limite máximo contratual de 500 bytes.

8. `legacy_result_not_approvable` (código 4):
   - **Descrição**: Tentativa de submeter um resultado no formato da versão 1 para aprovação de fluxo novo. Resultados legados são de leitura exclusiva para histórico e auditoria.
   - **Mensagem**: Resultados em formato legado (v1) são somente leitura e não podem aprovar o fluxo novo.

---

## 6. Regras de Compatibilidade

1. **Leitura Histórica vs Aprovação Nova**:
   - Resultados gerados na versão 1 permanecem arquivados e acessíveis para leitura, relatórios e auditoria histórica através dos esquemas em `schemas/legacy/*.v1.schema.json`.
   - Nenhuma transição, portão ou etapa do novo fluxo operacional pode ser aprovada a partir de um documento com `format_version: 1`. Toda aprovação corrente exige estritamente envelopes de revisão 2.
2. **Rejeição Fechada na Fronteira**:
   - Qualquer payload de resultado com campos não reconhecidos, versões ausentes ou divergência de tipos é recusado imediatamente na fronteira com erro código 4, sem tentativas de inferência mágica ou coerção silenciosa de tipos.

---

## 7. Fila de Reservas Posteriores Independentes

Para assegurar o foco estrito desta etapa na infraestrutura de evidências e contratos de revisão, as alterações em outros contratos foram isoladas e preservadas. Cada um dos seguintes formatos permanece inalterado na versão 1 nesta fase, sendo reservado para uma story posterior própria e independente:

1. **Reserva 1: `plan.schema.json`**:
   - Alterações no esquema de planos, alocação de fases e contratos de orçamento pertencem ao próximo épico de governança orçamentária e serão entregues em story independente dedicada.
2. **Reserva 2: `task-contract.schema.json`**:
   - A extensão dos contratos de tarefas, classes de complexidade e parâmetros específicos de execução rápida e rigorosa será tratada em story independente própria.
3. **Reserva 3: `ade-config.schema.json`**:
   - Modificações na configuração global do motor ADE, parâmetros de timeout e políticas de orquestração ficam reservadas para sua respectiva story independente.
4. **Reserva 4: `capability-set.schema.json`**:
   - O versionamento, ampliação de ferramentas e capacidades permitidas aos agentes permanecem isolados na sua própria story futura de registro de capacidades.

Nenhum desses quatro contratos foi alterado nesta etapa, mantendo sua integridade conforme definida na linha de base.
