import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock wxt/modules before importing our module
vi.mock('wxt/modules', () => ({
  defineWxtModule: vi.fn((config) => config),
  addEntrypoint: vi.fn(),
}));

import { addEntrypoint } from 'wxt/modules';
import moduleExport from '../src/index';

// Extract the setup function and metadata from the module definition
const moduleConfig = moduleExport as any;

function createMockWxt(outDir = '/tmp/test-output', wxtDir = '/tmp/test-wxt') {
  const hookCallbacks: Record<string, Function[]> = {};
  return {
    config: { outDir, wxtDir },
    hooks: {
      hook: vi.fn((event: string, cb: Function) => {
        if (!hookCallbacks[event]) hookCallbacks[event] = [];
        hookCallbacks[event].push(cb);
      }),
    },
    _hookCallbacks: hookCallbacks,
  };
}

describe('wxt-extpay module metadata', () => {
  it('has correct name', () => {
    expect(moduleConfig.name).toBe('@brightbar-dev/wxt-extpay');
  });

  it('has configKey "extpay"', () => {
    expect(moduleConfig.configKey).toBe('extpay');
  });

  it('exports a setup function', () => {
    expect(typeof moduleConfig.setup).toBe('function');
  });
});

describe('wxt-extpay module setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws when extensionId is missing', async () => {
    const wxt = createMockWxt();
    await expect(moduleConfig.setup(wxt, {})).rejects.toThrow('extensionId is required');
  });

  it('throws when options are undefined', async () => {
    const wxt = createMockWxt();
    await expect(moduleConfig.setup(wxt, undefined)).rejects.toThrow('extensionId is required');
  });

  it('calls addEntrypoint with content-script type', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    expect(addEntrypoint).toHaveBeenCalledOnce();
    const call = (addEntrypoint as any).mock.calls[0];
    expect(call[0]).toBe(wxt);
    expect(call[1].type).toBe('content-script');
  });

  it('injects content script matching extensionpay.com/*', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    const entrypoint = (addEntrypoint as any).mock.calls[0][1];
    expect(entrypoint.options.matches).toEqual(['https://extensionpay.com/*']);
  });

  it('injects content script with document_start', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    const entrypoint = (addEntrypoint as any).mock.calls[0][1];
    expect(entrypoint.options.runAt).toBe('document_start');
  });

  it('names the entrypoint "extpay"', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    const entrypoint = (addEntrypoint as any).mock.calls[0][1];
    expect(entrypoint.name).toBe('extpay');
  });

  it('sets outputDir under wxt outDir', async () => {
    const wxt = createMockWxt('/build/output');
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    const entrypoint = (addEntrypoint as any).mock.calls[0][1];
    expect(entrypoint.outputDir).toContain('/build/output');
    expect(entrypoint.outputDir).toContain('content-scripts');
  });

  it('points inputPath to extpay-content.ts', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    const entrypoint = (addEntrypoint as any).mock.calls[0][1];
    expect(entrypoint.inputPath).toMatch(/extpay-content\.ts$/);
  });

  it('registers prepare:types hook for config generation', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    expect(wxt.hooks.hook).toHaveBeenCalledWith('prepare:types', expect.any(Function));
  });
});

describe('wxt-extpay config generation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates config with extensionId', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, { extensionId: 'my-cool-ext' });

    const entries: Array<{ path: string; text: string }> = [];
    const hookCb = wxt._hookCallbacks['prepare:types'][0];
    hookCb(null, entries);

    expect(entries).toHaveLength(1);
    expect(entries[0].text).toContain('"my-cool-ext"');
  });

  it('generates config with default values when not specified', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    const entries: Array<{ path: string; text: string }> = [];
    wxt._hookCallbacks['prepare:types'][0](null, entries);

    const text = entries[0].text;
    expect(text).toContain('"trialDays": 7');
    expect(text).toContain('"priceLabel": "one-time"');
    expect(text).toContain('"priceDisplay": ""');
  });

  it('generates config with custom values', async () => {
    const wxt = createMockWxt();
    await moduleConfig.setup(wxt, {
      extensionId: 'premium-ext',
      priceDisplay: '$99',
      priceLabel: 'per year',
      trialDays: 14,
    });

    const entries: Array<{ path: string; text: string }> = [];
    wxt._hookCallbacks['prepare:types'][0](null, entries);

    const text = entries[0].text;
    expect(text).toContain('"premium-ext"');
    expect(text).toContain('"$99"');
    expect(text).toContain('"per year"');
    expect(text).toContain('"trialDays": 14');
  });

  it('generates config file in wxtDir', async () => {
    const wxt = createMockWxt('/out', '/my-wxt-dir');
    await moduleConfig.setup(wxt, { extensionId: 'test-ext' });

    const entries: Array<{ path: string; text: string }> = [];
    wxt._hookCallbacks['prepare:types'][0](null, entries);

    expect(entries[0].path).toContain('/my-wxt-dir/');
    expect(entries[0].path).toMatch(/extpay-config\.ts$/);
  });
});
