import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ExtPay touches chrome.* at call time; replace it with a recording fake.
const startBackground = vi.fn();
const ExtPay = vi.fn((_id: string) => ({ startBackground, getUser: vi.fn() }));
vi.mock('extpay', () => ({ default: (id: string) => ExtPay(id) }));

import * as helpers from '../src/helpers';
import * as proStatus from '../src/pro-status';

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createExtPay (popup/options)', () => {
  it('creates an ExtPay instance for the given extension id', () => {
    const instance = helpers.createExtPay('my-ext');
    expect(ExtPay).toHaveBeenCalledWith('my-ext');
    expect(instance).toBe(ExtPay.mock.results[0].value);
  });

  it('never starts the background listener', () => {
    helpers.createExtPay('my-ext');
    expect(startBackground).not.toHaveBeenCalled();
  });

  it('returns a fresh instance per call, so pages do not share one', () => {
    const a = helpers.createExtPay('my-ext');
    const b = helpers.createExtPay('my-ext');
    expect(a).not.toBe(b);
  });
});

describe('initBackground (background script, every browser start)', () => {
  it('creates an instance for the id and starts the background listener once', () => {
    helpers.initBackground('my-ext');
    expect(ExtPay).toHaveBeenCalledWith('my-ext');
    expect(startBackground).toHaveBeenCalledOnce();
  });

  it('swallows a startBackground failure with a warning instead of crashing the service worker', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = new Error('no chrome.management');
    startBackground.mockImplementationOnce(() => {
      throw err;
    });
    expect(() => helpers.initBackground('my-ext')).not.toThrow();
    expect(warn).toHaveBeenCalledWith('ExtPay background init failed:', err);
  });

  it('swallows a constructor failure too', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    ExtPay.mockImplementationOnce(() => {
      throw new Error('bad id');
    });
    expect(() => helpers.initBackground('')).not.toThrow();
    expect(startBackground).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe('@brightbar-dev/wxt-extpay/helpers public surface', () => {
  it('re-exports the pure pro-status functions unchanged', () => {
    expect(helpers.isTrialActive).toBe(proStatus.isTrialActive);
    expect(helpers.trialDaysRemaining).toBe(proStatus.trialDaysRemaining);
    expect(helpers.resolveProStatus).toBe(proStatus.resolveProStatus);
    expect(helpers.statusLabel).toBe(proStatus.statusLabel);
  });
});
