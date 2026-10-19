import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { buildContext, extract, watchedSubcommand } from './contributing-check.mjs';

const hookPath = join(dirname(fileURLToPath(import.meta.url)), 'contributing-check.mjs');

test('watchedSubcommand matches the git writes we care about', () => {
  assert.equal(watchedSubcommand('git commit -m x'), 'commit');
  assert.equal(watchedSubcommand('git push origin HEAD'), 'push');
  assert.equal(watchedSubcommand('git commit --amend --no-edit'), 'commit');
  // Chained and prefixed forms: git is not the first token.
  assert.equal(watchedSubcommand('npm test && git push'), 'push');
  assert.equal(watchedSubcommand('cd server; git commit'), 'commit');
  // Global options, including the ones that swallow the next token.
  assert.equal(watchedSubcommand('git -C /repo push'), 'push');
  assert.equal(watchedSubcommand('git -c user.name=x commit'), 'commit');
  assert.equal(watchedSubcommand('git --git-dir=/tmp/x commit'), 'commit');
});

test('watchedSubcommand ignores reads and lookalikes', () => {
  assert.equal(watchedSubcommand('git status'), null);
  assert.equal(watchedSubcommand('git log --grep=commit'), null);
  assert.equal(watchedSubcommand('git diff --stat'), null);
  assert.equal(watchedSubcommand('echo push'), null);
  assert.equal(watchedSubcommand('npm run commit-helper'), null);
  assert.equal(watchedSubcommand(''), null);
});

const FIXTURE = `# Contributing

Intro prose that is not a rule.

## Development loop

\`\`\`bash
npm install
npm test
\`\`\`

Every PR should:

- Include a test, and keep the existing suite green (\`npm test\`).
- Stay scoped to one change.

## Database migrations

Schema changes must use file-per-migration files under
\`server/src/db/migrations/\`.

## Reporting issues

- Include your version and the provider involved.
`;

test('extract pulls bullets, directive paragraphs and commands', () => {
  const { rules, commands } = extract(FIXTURE);
  const texts = rules.map((rule) => rule.text);

  assert.ok(texts.includes('Include a test, and keep the existing suite green (`npm test`).'));
  assert.ok(texts.includes('Stay scoped to one change.'));
  // Multi-line paragraph is joined into one rule.
  assert.ok(
    texts.includes(
      'Schema changes must use file-per-migration files under `server/src/db/migrations/`.',
    ),
  );
  assert.ok(commands.includes('npm test'));
  // Setup commands are not verification commands.
  assert.ok(!commands.includes('npm install'));
});

test('extract drops excluded sections, lead-ins and non-directive prose', () => {
  const { rules } = extract(FIXTURE);
  const texts = rules.map((rule) => rule.text);

  assert.ok(!rules.some((rule) => rule.section === 'Reporting issues'));
  // "Every PR should:" introduces the list; the bullets are the rules.
  assert.ok(!texts.includes('Every PR should:'));
  assert.ok(!texts.includes('Intro prose that is not a rule.'));
});

test('rules keep document order within a section', () => {
  const order = extract(FIXTURE)
    .rules.filter((rule) => rule.section === 'Development loop')
    .map((rule) => rule.text);
  assert.deepEqual(order, [
    'Include a test, and keep the existing suite green (`npm test`).',
    'Stay scoped to one change.',
  ]);
});

test('buildContext says so loudly when nothing could be extracted', () => {
  const context = buildContext('commit', { rules: [], commands: [] });
  assert.match(context, /Could not extract any rules/);
  assert.match(context, /needs its parser updated/);
});

test('the real CONTRIBUTING.md still yields the rules that matter', () => {
  const { rules, commands } = extract(
    readFileSync(join(dirname(hookPath), '..', '..', 'CONTRIBUTING.md'), 'utf8'),
  );
  assert.ok(rules.length > 0, 'expected rules from the repo CONTRIBUTING.md');
  assert.ok(rules.some((rule) => /Include a test/.test(rule.text)));
  assert.ok(commands.includes('npm test'));
  // This file documents the hook; quoting it back at the agent would be noise.
  assert.ok(!rules.some((rule) => rule.section === 'Commit checklist hook'));
});

test('run as a hook, it emits PreToolUse context only for a watched command', () => {
  const run = (command) =>
    execFileSync(process.execPath, [hookPath], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8',
    });

  const fired = JSON.parse(run('git commit -m x'));
  assert.equal(fired.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.match(fired.hookSpecificOutput.additionalContext, /Before this `git commit`/);
  assert.equal(fired.suppressOutput, true);

  assert.equal(run('git status'), '', 'reads must produce no output');
  assert.equal(run('ls'), '', 'non-git commands must produce no output');
});

test('malformed hook input is ignored rather than throwing', () => {
  const output = execFileSync(process.execPath, [hookPath], { input: 'not json', encoding: 'utf8' });
  assert.equal(output, '');
});
