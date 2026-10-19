import { describe, it, expect, beforeAll } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import { initDb, getDb, getUnifiedApiKey } from '../../db/index.js';
import { encrypt } from '../../lib/crypto.js';
import {
  resolveAuth,
  prependSystemPrompt,
  mintClientProfileKey,
  hashClientProfileKey,
  CLIENT_PROFILE_KEY_PREFIX,
} from '../../lib/system-prompt.js';

// resolveAuth precedence (#411): unified key → default behavior (no enforced
// prompt); profile key → its own prompt; empty prompt → neutral passthrough;
// disabled profile → rejected exactly like an unknown key.

function insertProfile(name: string, systemPrompt: string | null, enabled = 1): string {
  const key = mintClientProfileKey();
  const { encrypted, iv, authTag } = encrypt(key);
  getDb().prepare(`
    INSERT INTO client_profiles (name, token_hash, encrypted_key, iv, auth_tag, system_prompt, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(name, hashClientProfileKey(key), encrypted, iv, authTag, systemPrompt, enabled);
  return key;
}

describe('resolveAuth (#411)', () => {
  beforeAll(() => {
    process.env.ENCRYPTION_KEY = '0'.repeat(64);
    initDb(':memory:');
  });

  it('resolves the unified key to the default behavior (no enforced prompt)', () => {
    const auth = resolveAuth(getUnifiedApiKey());
    expect(auth).toEqual({ kind: 'unified', systemPrompt: null });
  });

  it('resolves a profile key to its own prompt', () => {
    const key = insertProfile('support-bot', 'You are the support bot.');
    expect(key.startsWith(CLIENT_PROFILE_KEY_PREFIX)).toBe(true);
    const auth = resolveAuth(key);
    expect(auth?.kind).toBe('profile');
    expect(auth?.systemPrompt).toBe('You are the support bot.');
    if (auth?.kind === 'profile') expect(auth.name).toBe('support-bot');
  });

  it('treats a null or blank profile prompt as no prompt', () => {
    expect(resolveAuth(insertProfile('no-prompt', null))?.systemPrompt).toBeNull();
    expect(resolveAuth(insertProfile('blank-prompt', '   '))?.systemPrompt).toBeNull();
  });

  it('rejects a disabled profile like a bad key', () => {
    const key = insertProfile('disabled-bot', 'irrelevant', 0);
    expect(resolveAuth(key)).toBeNull();
  });

  it('rejects unknown and missing tokens', () => {
    expect(resolveAuth(undefined)).toBeNull();
    expect(resolveAuth('')).toBeNull();
    expect(resolveAuth('not-a-key')).toBeNull();
    expect(resolveAuth(`${CLIENT_PROFILE_KEY_PREFIX}${'0'.repeat(48)}`)).toBeNull();
  });
});

describe('prependSystemPrompt (#411)', () => {
  const caller: ChatMessage[] = [
    { role: 'system', content: 'caller instructions' },
    { role: 'user', content: 'hi' },
  ];

  it('puts the enforced prompt first and keeps the caller system message after it', () => {
    const out = prependSystemPrompt(caller, 'ENFORCED');
    expect(out.map(m => [m.role, m.content])).toEqual([
      ['system', 'ENFORCED'],
      ['system', 'caller instructions'],
      ['user', 'hi'],
    ]);
  });

  it('is a neutral passthrough for null/empty/blank prompts', () => {
    expect(prependSystemPrompt(caller, null)).toBe(caller);
    expect(prependSystemPrompt(caller, undefined)).toBe(caller);
    expect(prependSystemPrompt(caller, '')).toBe(caller);
    expect(prependSystemPrompt(caller, '  \n ')).toBe(caller);
  });

  it('does not mutate the input array', () => {
    const before = [...caller];
    prependSystemPrompt(caller, 'ENFORCED');
    expect(caller).toEqual(before);
  });
});
