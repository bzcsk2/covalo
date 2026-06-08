export interface FreeAutoCandidate {
  provider: string
  model: string
  baseUrl: string
  label: string
  priority: number
  /** Is this candidate suitable for tool-calling tasks? */
  supportsTools: boolean
}

const KILO_BASE = "https://api.kilo.ai/api/gateway/v1"

export const FREE_AUTO_CANDIDATES: FreeAutoCandidate[] = [
  {
    provider: "kilo",
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    baseUrl: KILO_BASE,
    label: "Kilo Nemotron Super",
    priority: 1,
    supportsTools: true,
  },
  {
    provider: "kilo",
    model: "poolside/laguna-xs.2:free",
    baseUrl: KILO_BASE,
    label: "Kilo Laguna XS 2",
    priority: 2,
    supportsTools: true,
  },
]
