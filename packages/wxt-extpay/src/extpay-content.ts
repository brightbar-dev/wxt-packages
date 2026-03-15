// ExtPay content script — runs on extensionpay.com to relay payment notifications.
// Injected automatically by the @brightbar-dev/wxt-extpay WXT module.
//
// ExtPay's module-level code listens for postMessage events from extensionpay.com
// and forwards 'extpay-fetch-user' / 'extpay-trial-start' to the background script.
import 'extpay';

export default defineContentScript({
  matches: ['https://extensionpay.com/*'],
  runAt: 'document_start',
  main() {
    // ExtPay's import-time side effects handle the message relay
  },
});
