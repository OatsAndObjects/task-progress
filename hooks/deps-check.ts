/** Plugins task-progress routes work to (marketplace claude-plugins-official). */
export const REQUIRED_PLUGINS = ['feature-dev', 'code-simplifier'] as const
const MARKETPLACE = 'claude-plugins-official'

/** Plugin names (the part before '@') out of installed_plugins.json text; [] when unreadable. */
export function installedNames(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as { plugins?: Record<string, unknown> }
    return Object.keys(parsed.plugins ?? {}).map(k => k.split('@')[0] ?? k)
  } catch {
    return []
  }
}

/** Which required plugins are absent; names match with or without any @marketplace suffix. */
export function missingDeps(installedNames: string[]): { missing: string[]; message: string | null } {
  const have = new Set(installedNames.map(n => n.split('@')[0]))
  const missing = REQUIRED_PLUGINS.filter(p => !have.has(p))
  if (missing.length === 0) return { missing: [], message: null }
  const cmds = missing.map(p => `\`claude plugin install ${p}@${MARKETPLACE}\``).join(' and ')
  return { missing, message: `task-progress needs ${missing.join(', ')}: run ${cmds}` }
}
