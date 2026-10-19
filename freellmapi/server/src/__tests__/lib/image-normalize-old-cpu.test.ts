import { describe, it, expect, vi, afterAll } from 'vitest';
import type { ChatMessage } from '@freellmapi/shared/types.js';

// #1469: sharp's prebuilt linux-x64 libvips needs SSE4.2. On an older CPU
// (Intel Atom D2700 in a Synology DS1512+) loading it is an illegal
// instruction: the kernel kills the process with SIGILL, so the container
// restarts on every chat. Two guards: a request with nothing to transcode never
// loads sharp, and a linux-x64 CPU without sse4_2 never loads it at all.
//
// Own file: the loaded (or refused) sharp is cached in module state, and
// vitest gives each file a fresh module registry.

let sharpLoads = 0;
vi.mock('sharp', () => {
  sharpLoads += 1;
  return { default: () => { throw new Error('sharp must not run in this test'); } };
});

const OLD_CPU_FLAGS = 'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush dts acpi mmx fxsr sse sse2 ss ht tm pbe syscall nx lm constant_tsc pni dtes64 monitor ds_cpl vmx est tm2 ssse3 cx16 xtpr pdcm movbe lahf_lm';
const NEW_CPU_FLAGS = 'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep sse sse2 ssse3 sse4_1 sse4_2 popcnt avx avx2';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('node:fs');
  return {
    ...actual,
    readFileSync: ((file: any, ...rest: any[]) => file === '/proc/cpuinfo'
      ? `processor\t: 0\nmodel name\t: Intel(R) Atom(TM) CPU D2700 @ 2.13GHz\n${OLD_CPU_FLAGS}\n`
      : (actual.readFileSync as any)(file, ...rest)) as typeof actual.readFileSync,
  };
});

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const realArch = Object.getOwnPropertyDescriptor(process, 'arch')!;
Object.defineProperty(process, 'platform', { value: 'linux' });
Object.defineProperty(process, 'arch', { value: 'x64' });
afterAll(() => {
  Object.defineProperty(process, 'platform', realPlatform);
  Object.defineProperty(process, 'arch', realArch);
});

const { normalizeMessageImages, cpuCanRunSharp } = await import('../../lib/image-normalize.js');

const BIG_PNG = `data:image/png;base64,${'A'.repeat(2_000_000)}`;
const SMALL_JPEG = `data:image/jpeg;base64,${'A'.repeat(1_000)}`;

function turn(...content: unknown[]): ChatMessage[] {
  return [{ role: 'user', content } as any];
}

describe('cpuCanRunSharp', () => {
  it('rejects a linux-x64 CPU without sse4_2', () => {
    expect(cpuCanRunSharp('linux', 'x64', () => OLD_CPU_FLAGS)).toBe(false);
  });

  it('accepts a linux-x64 CPU with sse4_2', () => {
    expect(cpuCanRunSharp('linux', 'x64', () => NEW_CPU_FLAGS)).toBe(true);
  });

  it('does not match sse4_1 or a longer flag as sse4_2', () => {
    expect(cpuCanRunSharp('linux', 'x64', () => 'flags : sse4_1 sse4_2a')).toBe(false);
  });

  it('assumes capable when it cannot tell, and off linux-x64', () => {
    expect(cpuCanRunSharp('linux', 'x64', () => { throw new Error('EACCES'); })).toBe(true);
    expect(cpuCanRunSharp('linux', 'x64', () => 'processor : 0')).toBe(true);
    expect(cpuCanRunSharp('linux', 'arm64', () => OLD_CPU_FLAGS)).toBe(true);
    expect(cpuCanRunSharp('darwin', 'x64', () => OLD_CPU_FLAGS)).toBe(true);
    expect(cpuCanRunSharp('win32', 'x64', () => OLD_CPU_FLAGS)).toBe(true);
  });
});

describe('inbound image normalization on a CPU without SSE4.2 (#1469)', () => {
  it('never loads sharp for a text-only or small-image request', async () => {
    const text = turn({ type: 'text', text: 'hi' });
    expect((await normalizeMessageImages(text)).normalized).toBe(0);
    await normalizeMessageImages([{ role: 'user', content: 'hi' } as any]);
    await normalizeMessageImages(turn({ type: 'image_url', image_url: { url: SMALL_JPEG } }));
    expect(sharpLoads).toBe(0);
  });

  it('passes a big image through untouched without loading sharp, and warns once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const messages = turn({ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: BIG_PNG } });
      const summary = await normalizeMessageImages(messages);
      await normalizeMessageImages(turn({ type: 'image_url', image_url: { url: BIG_PNG } }));

      expect(sharpLoads).toBe(0);
      expect(summary.normalized).toBe(0);
      expect((messages[0].content as any[])[1].image_url.url).toBe(BIG_PNG);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('SSE4.2');
    } finally {
      warn.mockRestore();
    }
  });
});
