import type { ChatMessage, ChatToolDefinition } from '@freellmapi/shared/types.js';
import type { ZodTypeAny } from 'zod';

export const COMPRESSION_MODES = ['off', 'lossless', 'standard', 'aggressive'] as const;
export type CompressionMode = (typeof COMPRESSION_MODES)[number];
export type CompressionTarget = 'tool-results' | 'messages' | 'system';

export interface CompressionEngineConfig {
  enabled: boolean;
  [key: string]: unknown;
}

export interface CompressionConfig {
  mode: CompressionMode;
  engines: Record<string, CompressionEngineConfig>;
  autoTriggerEstTokens?: number;
  targetTokens?: number;
  trustProjectFilters: boolean;
  prefixFreeze: boolean;
}

export interface ToolCallOrigin {
  id: string;
  name: string;
  arguments: string;
  messageIndex: number;
}

export interface EngineContext {
  mode: CompressionMode;
  tools?: ChatToolDefinition[];
  targetTokens?: number;
  frozenMessageIndexes: ReadonlySet<number>;
  toolCallOrigins: ReadonlyMap<string, ToolCallOrigin>;
}

export interface EngineInput {
  messages: ChatMessage[];
  config: CompressionEngineConfig;
  context: EngineContext;
}

export interface EngineOutput {
  messages: ChatMessage[];
  details?: Record<string, unknown>;
}

export interface CompressionEngine {
  id: string;
  priority: number;
  lossless: boolean;
  targets: CompressionTarget[];
  configSchema: ZodTypeAny;
  apply(input: EngineInput): EngineOutput;
}

export interface CompressionStageStats {
  engine: string;
  inputChars: number;
  outputChars: number;
  savedChars: number;
  applied: boolean;
  discarded?: 'exception' | 'fidelity' | 'inflation' | 'disabled' | 'unchanged';
  fidelity?: {
    protectedTokenSurvival: number;
    numericLiteralsPreserved: boolean;
    jsonKeySurvival: number;
    diffHunksPreserved: boolean;
    criticalLinesPreserved: boolean;
  };
  details?: Record<string, unknown>;
}

export interface CompressionRequestStats {
  originalChars: number;
  compressedChars: number;
  estOriginalTokens: number;
  estCompressedTokens: number;
  estSavedTokens: number;
  enginesApplied: string[];
  discardedByGate: string[];
  durationMs: number;
  stages: CompressionStageStats[];
}

export interface CompressionResult {
  messages: ChatMessage[];
  mode: CompressionMode;
  cacheKey: string;
  stats: CompressionRequestStats;
}

export interface CompressRequestOptions {
  header?: string | string[];
  tools?: ChatToolDefinition[];
  config?: CompressionConfig;
  previewMode?: CompressionMode;
  targetTokens?: number;
  cacheControlPrefixLength?: number;
  recordStats?: boolean;
}
