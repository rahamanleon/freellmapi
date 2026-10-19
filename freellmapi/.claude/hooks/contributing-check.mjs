#!/usr/bin/env node
// Optional Claude Code hook. Off unless you wire it up yourself — see the
// "Commit checklist hook" section of CONTRIBUTING.md.
//
// When wired as a PreToolUse hook on Bash and the agent is about to run
// `git commit` or `git push`, this reads CONTRIBUTING.md, extracts the rules
// that bear on a diff, and injects them into the agent's context with an
// instruction to verify them. It does not block the command.
//
// CONTRIBUTING.md is parsed at fire time, so the checklist is whatever the
// file says right now — nothing to regenerate, nothing to go stale.
//
// See what the agent would be told, without wiring anything up:
//   node .claude/hooks/contributing-check.mjs --preview

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sourcePath = join(repoRoot, 'CONTRIBUTING.md');

// Sections describing what to do *after* a change is written are the ones
// worth quoting at commit time. Anything else is excluded by name; a section
// added to CONTRIBUTING.md later is picked up automatically.
//
// "Commit checklist hook" documents this file. Without it here, the hook would
// quote its own setup instructions back at the agent as if they were rules.
export const EXCLUDED_SECTIONS = new Set([
  'Reporting issues',
  'Related community work',
  'Commit checklist hook',
]);

// A paragraph counts as a rule if it is phrased as one.
const DIRECTIVE = /\b(must|should|do not|don't|never|always|before opening a pr|run\b.*\bbefore)\b/i;

// Commands worth re-running before a commit — setup commands (`npm install`,
// `npm run dev`) are not.
const VERIFICATION_COMMAND = /\b(test|build|check:|lint|migration)\b/;

const WATCHED_SUBCOMMANDS = new Set(['commit', 'push']);

// Global git options that consume the following token, so `git -C <dir> push`
// is not read as the subcommand being `<dir>`.
const VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path']);

// --- command matching -------------------------------------------------------

// Finds `git commit` / `git push` anywhere in the command line, including
// behind `git -C <dir>`, `&&`, or a leading `cd`. `--dry-run` still counts:
// the checklist is cheap and a dry run usually precedes the real thing.
export function watchedSubcommand(command) {
  const tokens = command.split(/\s+/).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].replace(/^["']/, '') !== 'git') continue;
    for (let j = i + 1; j < tokens.length; j++) {
      const token = tokens[j];
      if (VALUE_OPTIONS.has(token)) {
        j++; // skip the option's value
        continue;
      }
      if (token.startsWith('-')) continue;
      if (WATCHED_SUBCOMMANDS.has(token)) return token;
      break; // some other subcommand — not our business
    }
  }
  return null;
}

// --- CONTRIBUTING.md extraction ---------------------------------------------

function stripMarkdown(text) {
  return text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // links keep their target
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\s)\*([^*]+)\*/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSections(markdown) {
  const sections = [];
  let current = { title: null, lines: [] };
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(.*\S)\s*$/.exec(line);
    if (heading) {
      sections.push(current);
      current = { title: heading[1], lines: [] };
      continue;
    }
    current.lines.push(line);
  }
  sections.push(current);
  return sections.filter((section) => section.title !== null);
}

// Splits a section body into fenced code blocks and everything else, so a
// bullet inside a fence is never mistaken for a rule.
function splitFences(lines) {
  const prose = [];
  const fences = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    (inFence ? fences : prose).push(line);
  }
  return { prose, fences };
}

// Both extractors carry the prose-line index of each item so the two lists can
// be merged back into document order.
function extractBullets(prose) {
  const bullets = [];
  prose.forEach((line, index) => {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push({ index, text: bullet[1] });
      return;
    }
    // Continuation of the previous bullet: indented, non-empty, mid-list.
    if (bullets.length && /^\s+\S/.test(line)) {
      bullets[bullets.length - 1].text += ' ' + line.trim();
    }
  });
  return bullets
    .map(({ index, text }) => ({ index, text: stripMarkdown(text) }))
    .filter(({ text }) => text);
}

function extractDirectiveParagraphs(prose) {
  const paragraphs = [];
  let buffer = [];
  let start = 0;
  const flush = () => {
    if (buffer.length) paragraphs.push({ index: start, text: buffer.join(' ') });
    buffer = [];
  };
  prose.forEach((line, index) => {
    if (!line.trim() || /^\s*[-*]\s+/.test(line)) return flush();
    if (!buffer.length) start = index;
    buffer.push(line.trim());
  });
  flush();
  return (
    paragraphs
      .map(({ index, text }) => ({ index, text: stripMarkdown(text) }))
      // A paragraph ending in ':' introduces the list that follows; the bullets
      // are the rules, the lead-in is not one.
      .filter(({ text }) => text && !text.endsWith(':') && DIRECTIVE.test(text))
  );
}

// CONTRIBUTING.md documents `db:migration:create` with a sample name. Keep the
// command, drop the sample so it does not read as something to run verbatim.
function normalizeCommand(command) {
  return command
    .replace(/\s+#.*$/, '')
    .replace(/--name=\S+/, '--name=<name>')
    .trim();
}

function extractCommands({ prose, fences }) {
  const commands = new Set();
  for (const line of fences) {
    const command = line.trim();
    if (!command || command.startsWith('#')) continue;
    if (VERIFICATION_COMMAND.test(command)) commands.add(normalizeCommand(command));
  }
  // Commands named inline in prose, e.g. "run `npm run check:i18n` before ...".
  for (const line of prose) {
    for (const [, inline] of line.matchAll(/`([^`]+)`/g)) {
      if (/^(npm|npx|node|\.\/|\.\\)/.test(inline) && VERIFICATION_COMMAND.test(inline)) {
        commands.add(normalizeCommand(inline));
      }
    }
  }
  return [...commands];
}

export function extract(markdown) {
  const rules = [];
  const commands = new Set();

  for (const section of parseSections(markdown)) {
    if (EXCLUDED_SECTIONS.has(section.title)) continue;

    const { prose, fences } = splitFences(section.lines);
    const items = [...extractDirectiveParagraphs(prose), ...extractBullets(prose)].sort(
      (a, b) => a.index - b.index,
    );
    for (const { text } of items) rules.push({ section: section.title, text });
    for (const command of extractCommands({ prose, fences })) commands.add(command);
  }

  return { rules, commands: [...commands] };
}

// --- context construction ---------------------------------------------------

export function buildContext(action, { rules, commands }) {
  // Extraction yielding nothing means CONTRIBUTING.md was restructured past
  // what this parser understands. Say so — silence would read as "all clear".
  if (!rules.length) {
    return `Could not extract any rules from CONTRIBUTING.md before this \`git ${action}\`. Read CONTRIBUTING.md directly and verify the change against it, and mention that .claude/hooks/contributing-check.mjs needs its parser updated.`;
  }

  const bySection = new Map();
  for (const rule of rules) {
    if (!bySection.has(rule.section)) bySection.set(rule.section, []);
    bySection.get(rule.section).push(rule.text);
  }

  const lines = [
    `Before this \`git ${action}\`, verify the repo's own contribution rules have been followed.`,
    'These are extracted verbatim from CONTRIBUTING.md — treat each one as a check against the actual diff, not a formality.',
    '',
  ];
  for (const [section, texts] of bySection) {
    lines.push(`${section}:`);
    for (const text of texts) lines.push(`  - ${text}`);
    lines.push('');
  }
  if (commands.length) {
    lines.push('Verification commands named in CONTRIBUTING.md:');
    for (const command of commands) lines.push(`  ${command}`);
    lines.push('');
  }
  lines.push(
    'Check the staged/committed diff against each rule. If a rule applies and is unmet — no test for a behavior change, unrelated reformatting in the diff, an unverified provider limit or model id, a translation key added to en.json only, an edit to an already-applied migration — fix it or say so explicitly before proceeding. If every applicable rule is satisfied, continue without comment.',
  );
  return lines.join('\n');
}

// --- entry point ------------------------------------------------------------

function readContributing() {
  try {
    return readFileSync(sourcePath, 'utf8');
  } catch {
    return null; // no CONTRIBUTING.md, nothing to enforce
  }
}

function main(argv) {
  if (argv.includes('--preview')) {
    const markdown = readContributing();
    if (markdown === null) {
      console.error(`No CONTRIBUTING.md at ${sourcePath}`);
      return 1;
    }
    const extracted = extract(markdown);
    console.log(buildContext('commit', extracted));
    console.error(
      `\n[${extracted.rules.length} rules, ${extracted.commands.length} commands, ` +
        `${new Set(extracted.rules.map((r) => r.section)).size} sections]`,
    );
    return 0;
  }

  let command = '';
  try {
    command = JSON.parse(readFileSync(0, 'utf8'))?.tool_input?.command ?? '';
  } catch {
    command = ''; // not hook input, or no stdin — nothing to check
  }

  const action = watchedSubcommand(command);
  if (!action) return 0;

  const markdown = readContributing();
  if (markdown === null) return 0;

  process.stdout.write(
    JSON.stringify({
      suppressOutput: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: buildContext(action, extract(markdown)),
      },
    }),
  );
  return 0;
}

// Only run when executed directly, so the test can import the parts above.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
