/**
 * Seleciona identificadores de skills elegíveis correspondendo deterministamente por domínio e linguagem.
 * Nunca retorna skill fora do conjunto elegível.
 *
 * @param {{ story?: { domains?: string[], languages?: string[], task?: string }, eligibleSkills?: any[] }} input
 * @returns {string[]}
 */
export function selectEligibleSkills({ story = {}, eligibleSkills = [] }) {
  if (!Array.isArray(eligibleSkills) || eligibleSkills.length === 0) {
    return []
  }

  const storyDomains = (story.domains || []).map((d) => d.toLowerCase())
  const storyLanguages = (story.languages || []).map((l) => l.toLowerCase())
  const selected = []

  for (const skill of eligibleSkills) {
    if (typeof skill === 'string') {
      const lower = skill.toLowerCase()
      if (storyDomains.some((d) => lower.includes(d)) || (story.task && story.task.toLowerCase().includes(lower))) {
        selected.push(skill)
      }
      continue
    }

    if (!skill || typeof skill !== 'object' || !skill.id) {
      continue
    }

    const skillDomains = (skill.domains || []).map((d) => d.toLowerCase())
    const skillLanguages = (skill.languages || []).map((l) => l.toLowerCase())

    // Verificar se há interseção de domínio
    const domainMatch = skillDomains.some((d) => storyDomains.includes(d))
    if (!domainMatch) {
      continue
    }

    // Se a skill especificar linguagens e a story tiver linguagens, verificar interseção de linguagem
    let languageMatch = true
    if (skillLanguages.length > 0 && storyLanguages.length > 0) {
      languageMatch = skillLanguages.some((l) => storyLanguages.includes(l))
    }

    if (languageMatch) {
      selected.push(skill.id)
    }
  }

  return selected
}
