// Service worker: opens the app tab when the on-page launcher is clicked. Holds no data or sessions.
import { isSalesforceUiHost } from './core/hosts';

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== 'open-app' || sender.id !== chrome.runtime.id) return;
  const host = typeof msg.host === 'string' && isSalesforceUiHost(msg.host) ? msg.host : '';
  chrome.tabs.create({ url: chrome.runtime.getURL(`app.html${host ? `?host=${encodeURIComponent(host)}` : ''}`), index: sender.tab ? sender.tab.index + 1 : undefined });
});
