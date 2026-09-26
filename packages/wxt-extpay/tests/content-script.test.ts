import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

// The content script runs on every extensionpay.com page load. Its real work is extpay's
// import-time side effect, so the test asserts that import happens and that the script's
// own definition agrees with what the WXT module injects.
const extpayImported = vi.fn();
vi.mock('extpay', () => {
  extpayImported();
  return { default: vi.fn() };
});
vi.mock('wxt/modules', () => ({
  defineWxtModule: vi.fn((config) => config),
  addEntrypoint: vi.fn(),
}));

// WXT provides defineContentScript as an auto-import global at build time.
vi.stubGlobal('defineContentScript', (def: unknown) => def);

import { addEntrypoint } from 'wxt/modules';
import moduleExport from '../src/index';

type ContentScriptDef = { matches: string[]; runAt: string; main: () => unknown };

describe('extpay content script', () => {
  it('imports extpay for its message-relay side effect', async () => {
    await import('../src/extpay-content');
    expect(extpayImported).toHaveBeenCalled();
  });

  it('runs only on extensionpay.com, at document_start', async () => {
    const def = (await import('../src/extpay-content')).default as unknown as ContentScriptDef;
    expect(def.matches).toEqual(['https://extensionpay.com/*']);
    expect(def.runAt).toBe('document_start');
  });

  it('has a main() that does nothing and does not throw', async () => {
    const def = (await import('../src/extpay-content')).default as unknown as ContentScriptDef;
    expect(def.main()).toBeUndefined();
  });

  it('matches the options the WXT module injects it with', async () => {
    const def = (await import('../src/extpay-content')).default as unknown as ContentScriptDef;
    const wxt = { config: { outDir: '/out', wxtDir: '/wxt' }, hooks: { hook: vi.fn() } };
    await (moduleExport as any).setup(wxt, { extensionId: 'x' });
    const entry = (addEntrypoint as any).mock.calls[0][1];
    expect(entry.options).toEqual({ matches: def.matches, runAt: def.runAt });
  });

  it('is the file the WXT module points at, and it exists in the package', async () => {
    const wxt = { config: { outDir: '/out', wxtDir: '/wxt' }, hooks: { hook: vi.fn() } };
    (addEntrypoint as any).mockClear();
    await (moduleExport as any).setup(wxt, { extensionId: 'x' });
    const { inputPath } = (addEntrypoint as any).mock.calls[0][1];
    expect(existsSync(inputPath)).toBe(true);
    expect(inputPath).toBe(path.resolve(__dirname, '..', 'src', 'extpay-content.ts'));
  });
});
