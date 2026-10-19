import type { CompressionEngine } from './types.js';

const engines = new Map<string, CompressionEngine>();

export function registerEngine(engine: CompressionEngine): void {
  if (engines.has(engine.id)) throw new Error(`Compression engine already registered: ${engine.id}`);
  engines.set(engine.id, engine);
}

export function getEngine(id: string): CompressionEngine | undefined {
  return engines.get(id);
}

export function getRegisteredEngines(): CompressionEngine[] {
  return [...engines.values()].sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

export function _clearRegistryForTesting(): void {
  engines.clear();
}
