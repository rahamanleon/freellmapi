// Models → Decision page helpers. Mirrors server/src/services/decision.ts.

export interface DecisionModel {
  id: number
  platform: string
  modelId: string
  displayName: string
  priority: number
  enabled: boolean
  quotaLabel: string
  contextWindow: number | null
  keyCount: number
  healthyKeyCount: number
  decisionsThisMonth: number
}

export interface DecisionResult {
  model: string
  provider: string
  answers: Record<string, unknown>
  usage: { input_tokens: number; output_tokens: number }
}

/** "a, b ,c,,b" → ['a', 'b', 'c']: trimmed, non-empty, de-duplicated. */
export function parseOptions(raw: string): string[] {
  return [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))]
}

/** Option probabilities, highest first. */
export function topProbabilities(probabilities: Record<string, number> | undefined): Array<[string, number]> {
  if (!probabilities) return []
  return Object.entries(probabilities)
    .filter(([, p]) => typeof p === 'number' && Number.isFinite(p))
    .sort((a, b) => b[1] - a[1])
}

export function decisionExampleCurl(origin: string): string {
  const body = {
    state: 'my react useEffect runs twice, why?',
    questions: {
      tier: {
        type: 'choice',
        instructions: 'Which kind of model should answer this?',
        criteria: { chat: 'Casual chat', code: 'Coding', reasoning: 'Maths and logic' },
      },
    },
  }
  return [
    `curl ${origin}/v1/decisions \\`,
    `  -H "Authorization: Bearer $FREELLMAPI_KEY" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(body, null, 2).replace(/\n/g, '\n  ')}'`,
  ].join('\n')
}
