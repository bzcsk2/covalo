export const SENSITIVE_READ_PATTERNS = [
  /(^|\/|\\)api-key$/,
  /(^|\/|\\)\.env$/,
  /(^|\/|\\)\.env\.[^.]+$/,
  /(^|\/|\\)\.env\.local$/,
  /(^|\/|\\)\.git\//,
  /(^|\/|\\)id_rsa$/,
  /(^|\/|\\)id_ed25519$/,
  /(^|\/|\\)\.ssh\//,
  /(^|\/|\\)known_hosts$/,
  /(^|\/|\\)[^.]+\.pem$/,
  /(^|\/|\\)[^.]+\.key$/,
  /(^|\/|\\)[^.]+\.pfx$/,
  /(^|\/|\\)[^.]+\.p12$/,
  /(^|\/|\\)\.npmrc$/,
  /(^|\/|\\)credentials\.json$/,
  /(^|\/|\\)service-account\.json$/,
  /(^|\/|\\)\.aws\/credentials$/,
  /(^|\/|\\)\.dockercfg$/,
  /(^|\/|\\)\.docker\/config\.json$/,
  /(^|\/|\\)\.netrc$/,
  /(^|\/|\\)\.htpasswd$/,
  /(^|\/|\\)token\.json$/,
]

export const SENSITIVE_WRITE_PATTERNS = [
  ...SENSITIVE_READ_PATTERNS,
  /(^|\/|\\)\.git\//,
  /(^|\/|\\)node_modules\//,
  /(^|\/|\\)\.covalo\//,
  /(^|\/|\\)package-lock\.json$/,
  /(^|\/|\\)yarn\.lock$/,
  /(^|\/|\\)pnpm-lock\.yaml$/,
  /(^|\/|\\)opencode\.jsonc?$/,
  /(^|\/|\\)\.opencode\//,
]

export function isSensitive(path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
  for (const p of SENSITIVE_READ_PATTERNS) {
    if (p.test(normalized)) return true
  }
  return false
}

export function isWriteProtected(path: string): boolean {
  const normalized = path.replace(/\\/g, "/")
  for (const p of SENSITIVE_WRITE_PATTERNS) {
    if (p.test(normalized)) return true
  }
  return false
}
