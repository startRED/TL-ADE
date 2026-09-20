/** Extrai o sufixo numérico de um id (C2 -> 2), usado para ligar requisito e cenário. */
function idNumber(id) {
  const match = /(\d+)\s*$/.exec(String(id || ''))
  return match ? match[1] : null
}

/**
 * Divide deterministicamente um contrato quando ultrapassar o teto de cenários ou de bytes.
 * Função pura e estável: mesma entrada, mesma saída. Todos os cenários, verificadores e
 * requisitos do contrato original aparecem em alguma parte.
 *
 * @param {any} contract
 * @param {{ max_scenarios?: number, max_contract_bytes?: number }} [limits]
 * @returns {any[]}
 */
export function splitContract(contract, limits = {}) {
  if (!contract || typeof contract !== 'object') {
    throw new TypeError('splitContract: contrato inválido')
  }

  const maxScenarios = limits.max_scenarios ?? Infinity
  const maxBytes = limits.max_contract_bytes ?? 32000

  const scenarios = contract.scenarios || []
  const verifiers = contract.verifiers || []
  const requirements = contract.requirements || []
  const contractBytes = Buffer.byteLength(JSON.stringify(contract), 'utf8')

  if (scenarios.length <= maxScenarios && contractBytes <= maxBytes) {
    return [structuredClone(contract)]
  }

  if (scenarios.length <= 1) {
    // Contrato atômico: dividir perderia cobertura; falha alto em vez de devolver parte inválida.
    throw new Error(
      `splitContract: contrato ${contract.id} é atômico (${scenarios.length} cenário) e excede os limites (${contractBytes} bytes > ${maxBytes})`,
    )
  }

  const partsByScenarios = Number.isFinite(maxScenarios) ? Math.ceil(scenarios.length / maxScenarios) : 1
  const partsByBytes = Math.ceil(contractBytes / maxBytes)
  const partCount = Math.min(scenarios.length, Math.max(1, partsByScenarios, partsByBytes))
  let chunkSize = Math.ceil(scenarios.length / partCount)

  // ponytail: remonta as partes até que a MEDIÇÃO real de cada uma caiba no teto; cada
  // parte replica título, guardrails e demais campos comuns, então estimar pelo tamanho
  // do contrato original subestima. No máximo `scenarios.length` remontagens.
  for (;;) {
    const parts = buildParts({ contract, scenarios, verifiers, requirements, chunkSize })
    const biggest = Math.max(...parts.map((p) => Buffer.byteLength(JSON.stringify(p), 'utf8')))
    if (biggest <= maxBytes) return parts
    if (chunkSize === 1) {
      throw new Error(
        `splitContract: contrato ${contract.id} não cabe no teto: a menor parte separável ainda tem ${biggest} bytes > ${maxBytes}`,
      )
    }
    chunkSize -= 1
  }
}

/**
 * Monta as partes agrupando cenários de `chunkSize` em `chunkSize`, levando os
 * verificadores e requisitos que cada grupo reivindica.
 */
function buildParts({ contract, scenarios, verifiers, requirements, chunkSize }) {
  const usedVerifierIds = new Set()
  const usedRequirementIds = new Set()
  const parts = []

  for (let i = 0; i < scenarios.length; i += chunkSize) {
    const chunkScenarios = scenarios.slice(i, i + chunkSize)
    const referenced = new Set(chunkScenarios.flatMap((s) => s.verifiers || []))
    const chunkVerifiers = verifiers.filter((v) => referenced.has(v.id))
    for (const v of chunkVerifiers) usedVerifierIds.add(v.id)

    const chunkNumbers = new Set(chunkScenarios.map((s) => idNumber(s.id)).filter(Boolean))
    const chunkRequirements = requirements.filter((r) => chunkNumbers.has(idNumber(r.id)))
    for (const r of chunkRequirements) usedRequirementIds.add(r.id)

    const partNum = parts.length + 1
    parts.push({
      ...structuredClone(contract),
      id: `${contract.id}-p${partNum}`,
      title: `${contract.title} (Parte ${partNum})`,
      task: `${contract.task} (Parte ${partNum})`,
      scenarios: structuredClone(chunkScenarios),
      verifiers: structuredClone(chunkVerifiers),
      requirements: structuredClone(chunkRequirements),
    })
  }

  // Cobertura conservada: o que nenhum cenário reivindicou fica na primeira parte.
  const orphanVerifiers = verifiers.filter((v) => !usedVerifierIds.has(v.id))
  const orphanRequirements = requirements.filter((r) => !usedRequirementIds.has(r.id))
  if (orphanVerifiers.length > 0) {
    parts[0].verifiers = [...parts[0].verifiers, ...structuredClone(orphanVerifiers)]
  }
  if (orphanRequirements.length > 0) {
    parts[0].requirements = [...parts[0].requirements, ...structuredClone(orphanRequirements)]
  }

  return parts
}
