// Custom-endpoint groups (#1176): helpers shared by the Keys page components.
import type { ApiKey } from '../../../shared/types'

/** The labels already in use by custom endpoints, sorted, for suggestions. */
export function existingGroupLabels(keys: ApiKey[]): string[] {
  const labels = new Set<string>()
  for (const k of keys) {
    const label = k.platform === 'custom' ? k.groupLabel?.trim() : ''
    if (label) labels.add(label)
  }
  return [...labels].sort((a, b) => a.localeCompare(b))
}

/**
 * The typable handle a group answers to after `#` in a model id (#1176) —
 * mirrors the server's endpointHandle slug, so `My Relays` is `my-relays`.
 */
export function groupHandle(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return slug || 'endpoint'
}
