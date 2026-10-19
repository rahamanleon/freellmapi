import { describe, expect, it } from 'vitest';
import { getProvider } from '../../providers/index.js';
import { AUTH_JSON_PROVIDER_MAP, detectPlatform } from '../../lib/key-parser.js';
import type { Platform } from '@freellmapi/shared/types.js';

// Chinese domestic providers (#922/#923/#924). The failure this file guards
// against is a HALF-registered platform: the original PRs registered the
// provider and the Platform type but skipped the key-parser and the Keys page,
// so the provider existed on the server and was unreachable for a user — no way
// to add a key through the dashboard, and no way to import one from a .env.
// Registration is only useful when every entry point agrees, so assert them
// together.

const CN_PLATFORMS: { platform: Platform; baseUrl: string; envPrefixes: string[]; jsonAliases: string[] }[] = [
  {
    platform: 'qianfan',
    baseUrl: 'https://qianfan.baidubce.com/v2',
    envPrefixes: ['QIANFAN_', 'BAIDU_', 'ERNIE_'],
    jsonAliases: ['qianfan', 'baidu', 'ernie'],
  },
  {
    platform: 'volcengine',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    envPrefixes: ['VOLCENGINE_', 'VOLC_', 'ARK_', 'DOUBAO_'],
    jsonAliases: ['volcengine', 'volc', 'ark', 'doubao'],
  },
  {
    platform: 'longcat',
    baseUrl: 'https://api.longcat.chat/openai/v1',
    envPrefixes: ['LONGCAT_'],
    jsonAliases: ['longcat'],
  },
  {
    platform: 'xfyun',
    baseUrl: 'https://spark-api-open.xf-yun.com/v1',
    envPrefixes: ['XFYUN_', 'SPARK_', 'IFLYTEK_'],
    jsonAliases: ['xfyun', 'spark', 'iflytek'],
  },
];

describe('Chinese domestic providers: registration', () => {
  it.each(CN_PLATFORMS)('$platform is registered as an OpenAI-compatible provider', ({ platform }) => {
    const provider = getProvider(platform);
    expect(provider).toBeDefined();
    expect(provider!.platform).toBe(platform);
  });

  // The base URL is the one thing a typo makes silently useless: every request
  // 404s at a plausible-looking host. These four are transcribed from each
  // vendor's own OpenAI-compatibility doc.
  it.each(CN_PLATFORMS)('$platform points at the documented OpenAI-compatible base URL', ({ platform, baseUrl }) => {
    const provider = getProvider(platform) as unknown as { baseUrl: string };
    expect(provider.baseUrl).toBe(baseUrl);
  });
});

describe('Chinese domestic providers: key import', () => {
  it.each(CN_PLATFORMS)('$platform resolves from its .env prefixes', ({ platform, envPrefixes }) => {
    for (const prefix of envPrefixes) {
      expect(detectPlatform(prefix)).toBe(platform);
    }
  });

  it.each(CN_PLATFORMS)('$platform resolves from its auth.json aliases', ({ platform, jsonAliases }) => {
    for (const alias of jsonAliases) {
      expect(AUTH_JSON_PROVIDER_MAP[alias]).toBe(platform);
    }
  });
});
