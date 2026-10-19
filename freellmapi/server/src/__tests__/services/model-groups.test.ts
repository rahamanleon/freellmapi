import { describe, it, expect } from 'vitest';
import {
  stripProviderSuffix,
  normalizeGroupKey,
  slugifyGroupLabel,
  groupRows,
  resolveRequestedIdToMembers,
  resolveRequestedIdToTieredMembers,
  demotedMemberIds,
  type GroupableRow,
  type UnifyOverrides,
} from '../../services/model-groups.js';

const NO_OVERRIDES: UnifyOverrides = { merges: [], splits: [] };

function row(model_db_id: number, platform: string, model_id: string, display_name: string, intelligence_rank = 50): GroupableRow {
  return { model_db_id, platform, model_id, display_name, intelligence_rank };
}

// A realistic slice of the catalog: the same logical models under many providers
// with the mixed naming the real migrations use.
function catalog(): GroupableRow[] {
  return [
    row(1, 'cerebras', 'gpt-oss-120b', 'GPT-OSS 120B', 3),
    row(2, 'groq', 'openai/gpt-oss-120b', 'GPT-OSS 120B (Groq)', 6),
    row(3, 'cloudflare', '@cf/openai/gpt-oss-120b', 'GPT-OSS 120B (CF)', 6),
    row(4, 'sambanova', 'gpt-oss-120b', 'GPT-OSS 120B (SambaNova)', 6),
    row(5, 'ollama', 'gpt-oss:120b', 'GPT-OSS 120B (Ollama)', 9),
    row(6, 'groq', 'llama-3.3-70b-versatile', 'Llama 3.3 70B', 9),
    row(7, 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'Llama 3.3 70B (free)', 17),
    row(8, 'huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 'Llama 3.3 70B (HF)', 14),
    row(9, 'cloudflare', '@cf/meta/llama-3.3-70b-fp8-fast', 'Llama 3.3 70B fp8-fast (CF)', 12),
  ];
}

describe('stripProviderSuffix', () => {
  it('strips known provider/variant parentheticals', () => {
    for (const tag of ['Groq', 'CF', 'HF', 'NV', 'SambaNova', 'Ollama', 'Cerebras', 'GitHub', 'free']) {
      expect(stripProviderSuffix(`Llama 3.3 70B (${tag})`)).toBe('Llama 3.3 70B');
    }
  });
  it('strips a generic trailing parenthetical too', () => {
    expect(stripProviderSuffix('Some Model (whatever)')).toBe('Some Model');
  });
  it('leaves names without a trailing parenthetical alone', () => {
    expect(stripProviderSuffix('GPT-OSS 120B')).toBe('GPT-OSS 120B');
  });
});

describe('normalizeGroupKey', () => {
  it('lowercases, strips suffix, and treats hyphens/underscores/space as one separator', () => {
    expect(normalizeGroupKey('GPT-OSS 120B (Groq)')).toBe('gpt oss 120b');
    expect(normalizeGroupKey('  Llama  3.3   70B  (HF) ')).toBe('llama 3.3 70b');
    // Separator-only spelling differences normalize to the same key…
    expect(normalizeGroupKey('Qwen3 Coder 480B')).toBe(normalizeGroupKey('Qwen3-Coder 480B'));
    // …but a meaningful '+' is preserved, keeping distinct models apart.
    expect(normalizeGroupKey('Command R')).not.toBe(normalizeGroupKey('Command R+'));
  });
});

describe('groupRows', () => {
  it('collapses one model served by many providers into a single group', () => {
    const groups = groupRows(catalog(), NO_OVERRIDES);
    const gptoss = groups.find(g => g.groupKey === 'gpt oss 120b');
    expect(gptoss).toBeDefined();
    expect(gptoss!.members).toHaveLength(5);
    expect(gptoss!.groupLabel).toBe('GPT-OSS 120B'); // lowest intelligence_rank member
  });

  it('groups Llama 3.3 70B across differing model_ids but keeps fp8-fast separate', () => {
    const groups = groupRows(catalog(), NO_OVERRIDES);
    const llama = groups.find(g => g.groupKey === 'llama 3.3 70b');
    expect(llama!.members.map(m => m.model_db_id).sort()).toEqual([6, 7, 8]);
    // The fp8-fast variant normalizes to a DISTINCT key (merge only via override).
    expect(groups.find(g => g.groupKey === 'llama 3.3 70b fp8 fast')).toBeDefined();
  });

  it('merges a variant into a base group via an override', () => {
    const ov: UnifyOverrides = { merges: [{ into: 'Llama 3.3 70B', keys: ['llama 3.3 70b fp8 fast'] }], splits: [] };
    const groups = groupRows(catalog(), ov);
    const llama = groups.find(g => g.groupKey === 'llama 3.3 70b');
    expect(llama!.members.map(m => m.model_db_id).sort()).toEqual([6, 7, 8, 9]);
    expect(groups.find(g => g.groupKey === 'llama 3.3 70b fp8 fast')).toBeUndefined();
  });

  it('forces a member out of its group via a split override', () => {
    const ov: UnifyOverrides = { merges: [], splits: [{ member: 'groq:openai/gpt-oss-120b' }] };
    const groups = groupRows(catalog(), ov);
    const gptoss = groups.find(g => g.groupKey === 'gpt oss 120b');
    expect(gptoss!.members.map(m => m.model_db_id)).not.toContain(2);
    expect(groups.some(g => g.members.length === 1 && g.members[0].model_db_id === 2)).toBe(true);
  });

  it('merges names that differ only by separator punctuation (Qwen3 Coder vs Qwen3-Coder)', () => {
    const rows = [
      row(1, 'openrouter', 'qwen/qwen3-coder:free', 'Qwen3 Coder 480B'),
      row(2, 'ollama', 'qwen3-coder:480b', 'Qwen3-Coder 480B'),
    ];
    const groups = groupRows(rows, NO_OVERRIDES);
    expect(groups).toHaveLength(1);
    expect(groups[0].members.map(m => m.model_db_id).sort()).toEqual([1, 2]);
  });

  it('merges a free-tier name with its base model (DeepSeek V4 Flash Free → DeepSeek V4 Flash)', () => {
    const rows = [
      row(1, 'nvidia', 'deepseek-ai/deepseek-v4-flash', 'DeepSeek V4 Flash (NV)'),
      row(2, 'huggingface', 'deepseek-ai/DeepSeek-V4-Flash', 'DeepSeek V4 Flash (HF)'),
      row(3, 'opencode', 'deepseek-v4-flash-free', 'DeepSeek V4 Flash Free (OpenCode Zen)'),
    ];
    const groups = groupRows(rows, NO_OVERRIDES);
    expect(groups).toHaveLength(1);
    expect(groups[0].groupLabel).toBe('DeepSeek V4 Flash'); // "Free" dropped from the label
    expect(groups[0].members.map(m => m.model_db_id).sort()).toEqual([1, 2, 3]);
  });

  it('keeps models that differ by a meaningful char apart (Command R vs Command R+)', () => {
    const rows = [
      row(1, 'cohere', 'command-r-08-2024', 'Command R'),
      row(2, 'cohere', 'command-r-plus-08-2024', 'Command R+'),
    ];
    expect(groupRows(rows, NO_OVERRIDES)).toHaveLength(2);
  });

  it('assigns deterministic, unique canonical ids (collisions get -2)', () => {
    const rows = [row(1, 'a', 'm1', 'Model X'), row(2, 'b', 'm2', 'Model X!')];
    const groups = groupRows(rows, NO_OVERRIDES);
    const ids = groups.map(g => g.canonicalId).sort();
    expect(ids).toEqual(['model-x', 'model-x-2']);
  });
});

describe('slugifyGroupLabel', () => {
  it('keeps digits and dots, hyphenates spaces', () => {
    expect(slugifyGroupLabel('Llama 3.3 70B')).toBe('llama-3.3-70b');
    expect(slugifyGroupLabel('GPT-OSS 120B')).toBe('gpt-oss-120b');
  });
});

describe('resolveRequestedIdToMembers', () => {
  const groups = groupRows(catalog(), NO_OVERRIDES);
  const gptoss = groups.find(g => g.groupKey === 'gpt oss 120b')!;

  it('resolves a canonical id to all member db ids', () => {
    expect(resolveRequestedIdToMembers(gptoss.canonicalId, groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('resolves any member model_id (back-compat) to the whole group', () => {
    expect(resolveRequestedIdToMembers('gpt-oss-120b', groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
    expect(resolveRequestedIdToMembers('@cf/openai/gpt-oss-120b', groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('hard-pins an explicit "platform:model_id" member to ONLY that member (#580)', () => {
    expect(resolveRequestedIdToMembers('groq:openai/gpt-oss-120b', groups)).toEqual([2]);
    expect(resolveRequestedIdToMembers('cloudflare:@cf/openai/gpt-oss-120b', groups)).toEqual([3]);
  });
  it('a bare model_id containing a colon still resolves the whole group (Ollama ids)', () => {
    expect(resolveRequestedIdToMembers('gpt-oss:120b', groups)!.sort()).toEqual([1, 2, 3, 4, 5]);
  });
  it('returns null for an unknown platform:model_id (not-found, not the group)', () => {
    expect(resolveRequestedIdToMembers('nope:gpt-oss-120b', groups)).toBeNull();
    expect(resolveRequestedIdToMembers('groq:not-a-model', groups)).toBeNull();
  });
  it('returns null for an unknown id', () => {
    expect(resolveRequestedIdToMembers('does-not-exist', groups)).toBeNull();
  });
});

// A canonical id is a SLUG of a display name, so it can coincide with some other
// model's literal model_id. Resolution unions both matches — grouping must never
// shrink what an id reaches (#651) — but the two are not equally intended: an id
// typed literally must be tried literally first, and a coincidental slug sibling
// is only a fallback. Anything else is a silent substitution.
describe('slug / model_id collisions resolve as an ordered union', () => {
  // The one case that exists in the shipped catalog: the Cloudflare row's
  // display name "Gemma 4 26B-A4B it (CF)" slugs to `gemma-4-26b-a4b-it`, which
  // is Google's literal model_id in a different group.
  function gemmaCatalog(): GroupableRow[] {
    return [
      row(121, 'cloudflare', '@cf/google/gemma-4-26b-a4b-it', 'Gemma 4 26B-A4B it (CF)', 22),
      row(139, 'google', 'gemma-4-26b-a4b-it', 'Gemma 4 26B IT', 20),
    ];
  }

  it('puts the literally-requested model first and the slug sibling after', () => {
    const groups = groupRows(gemmaCatalog(), NO_OVERRIDES);
    const cf = groups.find(g => g.members.some(m => m.model_db_id === 121))!;
    expect(cf.canonicalId).toBe('gemma-4-26b-a4b-it');
    expect(groups.find(g => g.members.some(m => m.model_db_id === 139))!.groupKey)
      .not.toBe(cf.groupKey);

    // Literal match (139) first; the slug-only match (121) stays reachable but
    // can only serve once the literal one is exhausted.
    expect(resolveRequestedIdToMembers('gemma-4-26b-a4b-it', groups)).toEqual([139, 121]);
  });

  it('reports which members were reached only through a slug', () => {
    const groups = groupRows(gemmaCatalog(), NO_OVERRIDES);
    const tiered = resolveRequestedIdToTieredMembers('gemma-4-26b-a4b-it', groups)!;
    expect(tiered).toEqual([
      { modelDbId: 139, tier: 'literal' },
      { modelDbId: 121, tier: 'slug' },
    ]);
    expect([...demotedMemberIds(tiered)]).toEqual([121]);
  });

  it('still resolves the Cloudflare row by its own literal id, alone', () => {
    const groups = groupRows(gemmaCatalog(), NO_OVERRIDES);
    expect(resolveRequestedIdToMembers('@cf/google/gemma-4-26b-a4b-it', groups)).toEqual([121]);
  });

  it('keeps a plain slug request unaffected when nothing collides', () => {
    const groups = groupRows(catalog(), NO_OVERRIDES);
    // "Llama 3.3 70B" slugs to `llama-3.3-70b`, which no member carries as its
    // literal model_id — so the whole group is reached through the slug, and
    // with nothing above it the tier changes nothing about what serves first.
    const g = groups.find(gr => gr.canonicalId === 'llama-3.3-70b')!;
    const ids = resolveRequestedIdToMembers(g.canonicalId, groups)!;
    expect([...ids].sort()).toEqual(g.members.map(m => m.model_db_id).sort());
    expect(demotedMemberIds(resolveRequestedIdToTieredMembers(g.canonicalId, groups)!).size)
      .toBe(g.members.length);
  });

  it('treats a slug that a member also carries literally as a literal match', () => {
    const groups = groupRows(catalog(), NO_OVERRIDES);
    // `gpt-oss-120b` is both this group's slug and row 1's own model_id, so
    // nothing is demoted — the common case where the two agree.
    const tiered = resolveRequestedIdToTieredMembers('gpt-oss-120b', groups)!;
    expect(demotedMemberIds(tiered).size).toBe(0);
    expect(tiered.some(t => t.modelDbId === 1)).toBe(true);
  });

  it('treats a user-merged group as a first-class match, not a fallback', () => {
    // The user asserted this name themselves, so a slug match on it ranks with
    // the literal ones rather than behind them.
    const rows = gemmaCatalog();
    const merged: UnifyOverrides = {
      merges: [{ into: 'Gemma 4 26B-A4B it', keys: ['cloudflare:@cf/google/gemma-4-26b-a4b-it'] }],
      splits: [],
    };
    const groups = groupRows(rows, merged);
    const tiered = resolveRequestedIdToTieredMembers('gemma-4-26b-a4b-it', groups)!;
    expect(tiered.every(t => t.tier === 'literal')).toBe(true);
  });

  it('groups the catalog in a stable order regardless of row order', () => {
    const forward = groupRows(catalog(), NO_OVERRIDES).map(g => g.canonicalId).sort();
    const reversed = groupRows([...catalog()].reverse(), NO_OVERRIDES).map(g => g.canonicalId).sort();
    expect(reversed).toEqual(forward);
  });
});
