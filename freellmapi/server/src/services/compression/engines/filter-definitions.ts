import { z } from 'zod';

export const filterRuleSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive().default(1),
  detect: z.object({
    toolNames: z.array(z.string()).default([]),
    content: z.array(z.string()).default([]),
  }),
  stripAnsi: z.boolean().default(true),
  dropLines: z.array(z.object({
    pattern: z.string(),
    unless: z.string().optional(),
  })).default([]),
  keepLines: z.array(z.string()).default([]),
  collapseRuns: z.object({ min: z.number().int().min(2).default(3) }).optional(),
  headTail: z.boolean().default(true),
  maxChars: z.number().int().positive().optional(),
});

export type ToolFilterRule = z.infer<typeof filterRuleSchema>;

const common = {
  version: 1,
  stripAnsi: true,
  keepLines: [],
  collapseRuns: { min: 3 },
  headTail: true,
};

export const BUILTIN_FILTERS: ToolFilterRule[] = [
  { ...common, id: 'git-status', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^On branch ', '^Changes (?:not staged|to be committed):'] }, dropLines: [{ pattern: '^\\s*\\(use "git .+" to .+\\)\\s*$' }] },
  { ...common, id: 'git-log', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^(?:commit [0-9a-f]{7,40}|[0-9a-f]{7,40} )'] }, dropLines: [{ pattern: '^Author:\\s' }, { pattern: '^Date:\\s' }] },
  { ...common, id: 'git-diff', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^diff --git ', '^@@'] }, dropLines: [] },
  { ...common, id: 'package-install', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:npm|pnpm|yarn) (?:warn|notice|info)', 'packages? (?:added|audited)'] }, dropLines: [{ pattern: '^(?:npm notice|Progress: resolved|Downloading)\\b' }] },
  { ...common, id: 'vitest-jest', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:vitest|jest|Test Files|Tests:)'] }, dropLines: [{ pattern: '^\\s*[✓✔]\\s.*\\([\\d.]+m?s\\)\\s*$' }] },
  { ...common, id: 'pytest', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:pytest|test session starts|short test summary info)'] }, dropLines: [{ pattern: '^collecting \\.+' }] },
  { ...common, id: 'go-test', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^(?:ok|\\?)\\s+\\S+\\s+[\\d.]+s$', '^--- (?:PASS|FAIL):'] }, dropLines: [{ pattern: '^=== RUN\\s' }] },
  { ...common, id: 'cargo', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^\\s*(?:Compiling|Checking|Finished)\\s', 'running \\d+ tests'] }, dropLines: [{ pattern: '^\\s*(?:Compiling|Checking)\\s' }] },
  { ...common, id: 'tsc', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['error TS\\d+:', 'Found \\d+ errors?'] }, dropLines: [] },
  { ...common, id: 'lint', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:eslint|biome|problems? \\()'] }, dropLines: [{ pattern: '^\\s*ℹ\\s' }] },
  { ...common, id: 'build', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['(?:vite|webpack|built in|modules transformed)'] }, dropLines: [{ pattern: '^transforming\\.\\.\\.' }, { pattern: '^rendering chunks\\.\\.\\.' }] },
  { ...common, id: 'docker', detect: { toolNames: ['bash', 'shell', 'run_command'], content: ['^#\\d+ \\[', '^CONTAINER ID\\s'] }, dropLines: [{ pattern: '^#\\d+ (?:CACHED|DONE)' }] },
  { ...common, id: 'file-list', detect: { toolNames: ['bash', 'shell', 'run_command', 'glob', 'list_files'], content: ['^(?:\\.?\\.?\\/)?[\\w.-]+\\/(?:[\\w.-]+\\/)*[\\w.-]+$'] }, dropLines: [] },
  { ...common, id: 'search', detect: { toolNames: ['grep', 'rg', 'search', 'bash', 'shell', 'run_command'], content: ['^[^\\n:]+:\\d+:'] }, dropLines: [] },
  { ...common, id: 'json-dump', detect: { toolNames: [], content: ['^\\s*[\\[{][\\s\\S]*[\\]}]\\s*$'] }, dropLines: [] },
  { ...common, id: 'stack-trace', detect: { toolNames: [], content: ['(?:Traceback \\(most recent call last\\)|^\\s*at\\s+\\S+)'] }, dropLines: [], headTail: false },
  { ...common, id: 'fallback', detect: { toolNames: [], content: [] }, dropLines: [] },
].map(rule => filterRuleSchema.parse(rule));
