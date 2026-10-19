import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterRuleSchema, type ToolFilterRule } from './filter-definitions.js';

let cacheKey = '';
let cached: ToolFilterRule[] = [];

function readFilterFile(file: string): ToolFilterRule[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    const values = Array.isArray(parsed)
      ? parsed
      : (parsed && typeof parsed === 'object' && Array.isArray((parsed as { filters?: unknown }).filters)
          ? (parsed as { filters: unknown[] }).filters
          : [parsed]);
    return values.flatMap(value => {
      const result = filterRuleSchema.safeParse(value);
      return result.success ? [result.data] : [];
    });
  } catch {
    return [];
  }
}

export function loadCustomFilters(trustProjectFilters: boolean): ToolFilterRule[] {
  const key = `${process.cwd()}:${trustProjectFilters}`;
  if (key === cacheKey) return cached;
  const filters: ToolFilterRule[] = [];
  const userDir = path.join(os.homedir(), '.freellmapi', 'filters');
  try {
    for (const name of fs.readdirSync(userDir).filter(name => name.endsWith('.json')).sort()) {
      filters.push(...readFilterFile(path.join(userDir, name)));
    }
  } catch {
    // Optional directory.
  }
  if (trustProjectFilters) {
    filters.push(...readFilterFile(path.resolve(process.cwd(), '.freellmapi', 'filters.json')));
  }
  cacheKey = key;
  cached = filters.slice(0, 100);
  return cached;
}

export function _clearCustomFilterCacheForTesting(): void {
  cacheKey = '';
  cached = [];
}
