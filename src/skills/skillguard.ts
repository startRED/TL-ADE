import { createHash } from 'node:crypto'

/**
 * Padrões de detecção do SkillGuard para segurança da cadeia de suprimento de habilidades.
 */
const HOSTILE_PATTERNS = [
  { id: 'zero_width_or_bidi', regex: /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/ },
  { id: 'script_tag', regex: /<script\b/i },
  { id: 'html_comment', regex: /<!--/ },
  { id: 'data_text_html', regex: /data:text\/html/i },
  { id: 'base64_payload', regex: /base64,/i },
  { id: 'network_command', regex: /\b(curl|wget|nc|scp|ssh)\b/i },
  { id: 'enable_all_project_mcp_servers', regex: /\benableAllProjectMcpServers\b/i },
  { id: 'anthropic_base_url', regex: /\bANTHROPIC_BASE_URL\b/i },
  { id: 'sensitive_path_ssh', regex: /~\/\.ssh/i },
  { id: 'sensitive_path_aws', regex: /~\/\.aws/i },
  { id: 'sensitive_path_env', regex: /\.env\b/i },
  { id: 'sensitive_keyword_credentials', regex: /\bcredentials\b/i },
  { id: 'sensitive_keyword_keychain', regex: /\bkeychain\b/i },
  { id: 'disable_gates', regex: /\b(disable\s+(all\s+)?gates|ignore\s+(previous\s+)?guardrails)\b/i },
]

/**
 * Examina estaticamente os arquivos de uma habilidade em busca de padrões hostis e scripts.
 */
export function scanSkill({ files = {} }: {
        files: Record<string, string | Buffer>
        allowedUrls?: string[]
    }): {
    ok: boolean
    findings: string[]
    hasScripts: boolean
    hashes: Record<string, string>
} {
  
  const findings: string[] = []
  let hasScripts = false
  
  const hashes: Record<string, string> = {}

  for (const [filePath, contentRaw] of Object.entries(files)) {
    const content = typeof contentRaw === 'string' ? contentRaw : contentRaw.toString('utf8')
    const hash = createHash('sha256').update(contentRaw).digest('hex')
    hashes[filePath] = hash

    const normalizedPath = filePath.replace(/\\/g, '/')
    if (
      normalizedPath.startsWith('scripts/') ||
      normalizedPath.includes('/scripts/') ||
      /\.(sh|bash|py|js|mjs|exe|bat|cmd|ps1)$/i.test(normalizedPath)
    ) {
      if (normalizedPath !== 'SKILL.md') {
        hasScripts = true
      }
    }

    // Verifica padrões hostis sobre o conteúdo original e normalizado NFKC
    for (const { id, regex } of HOSTILE_PATTERNS) {
      if (regex.test(content) || regex.test(content.normalize('NFKC'))) {
        if (!findings.includes(id)) {
          findings.push(id)
        }
      }
    }
  }

  const ok = findings.length === 0 && !hasScripts

  return {
    ok,
    findings,
    hasScripts,
    hashes,
  }
}
