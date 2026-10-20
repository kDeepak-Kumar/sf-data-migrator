import { isSalesforceUiHost } from './core/hosts';
import { sessionForUiHost } from './platform/session';

(async () => {
  const status = document.getElementById('status')!;
  const open = document.getElementById('open') as HTMLButtonElement;
  let host = '';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ? new URL(tab.url) : null;
    if (url && url.protocol === 'https:' && isSalesforceUiHost(url.hostname)) {
      const s = await sessionForUiHost(url.hostname);
      if (s) {
        host = url.hostname;
        status.textContent = `Org detected: ${s.apiHost}`;
        status.className = 'ok';
      } else status.textContent = 'Salesforce page detected, but no session was found. Make sure you are logged in.';
    } else status.textContent = 'Open a Salesforce tab to start with that org, or open the migrator and pick an org.';
  } catch {
    status.textContent = 'Open the migrator to pick an org.';
  }
  open.addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(`app.html${host ? `?host=${encodeURIComponent(host)}` : ''}`) });
    window.close();
  });
})();
