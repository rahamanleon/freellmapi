// End-to-end verification of the FreeLLMAPI router.
//
// Reads the unified API key straight out of the SQLite settings table and
// exercises /v1/chat/completions. The key is never printed.
//
// Usage:
//   node ops/scripts/verify-router.mjs [baseUrl] [model]

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const dbPath = path.join(root, 'freellmapi', 'server', 'data', 'freeapi.db');
const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3001';
const model = process.argv[3] ?? 'auto';
const withTools = process.argv[4] === 'tools';

const db = new DatabaseSync(dbPath, { readOnly: true });
const row = db.prepare("SELECT value FROM settings WHERE key = 'unified_api_key'").get();
db.close();
if (!row?.value) throw new Error('no unified_api_key in settings — has the server booted yet?');
const key = row.value;

console.log(`POST ${baseUrl}/v1/chat/completions`);
console.log(`model: ${model}`);
console.log(`key  : ${key.slice(0, 12)}… (${key.length} chars, redacted)\n`);

const started = Date.now();
const res = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    authorization: `Bearer ${key}`,
  },
  body: JSON.stringify({
    model,
    messages: [
      {
        role: 'user',
        content: withTools
          ? 'What is the weather in Dhaka right now? Use the get_weather tool.'
          : 'Reply with exactly: PONG',
      },
    ],
    max_tokens: withTools ? 200 : 20,
    ...(withTools
      ? {
          tools: [
            {
              type: 'function',
              function: {
                name: 'get_weather',
                description: 'Get the current weather for a city',
                parameters: {
                  type: 'object',
                  properties: { city: { type: 'string', description: 'City name' } },
                  required: ['city'],
                },
              },
            },
          ],
          tool_choice: 'auto',
        }
      : {}),
  }),
});

const elapsed = Date.now() - started;
console.log(`HTTP ${res.status} in ${elapsed}ms`);

const routedVia = res.headers.get('x-routed-via');
console.log(`x-routed-via        : ${routedVia}`);
const fallbacks = res.headers.get('x-freellm-fallbacks') ?? res.headers.get('x-fallback-count');
if (fallbacks) console.log(`fallback header     : ${fallbacks}`);

const text = await res.text();
let body;
try { body = JSON.parse(text); } catch { body = null; }

if (!res.ok) {
  console.log('\n--- error body ---');
  console.log(text.slice(0, 800));
  process.exit(1);
}

console.log(`\n--- completion ---`);
if (withTools) {
  const calls = body.choices?.[0]?.message?.tool_calls;
  console.log(`tool_calls: ${calls ? `${calls.length} returned` : 'NONE'}`);
  if (calls) {
    for (const c of calls) {
      console.log(`   ${c.function?.name}(${c.function?.arguments})`);
    }
  }
} else {
  console.log(`content   : ${JSON.stringify(body.choices?.[0]?.message?.content)}`);
}
console.log(`finish    : ${body.choices?.[0]?.finish_reason}`);
console.log(`usage     : ${JSON.stringify(body.usage)}`);
console.log(`model     : ${body.model}`);
