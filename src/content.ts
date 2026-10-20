// Adds a small launcher button to Salesforce pages. Reads nothing from the page.
(async () => {
  if (window.top !== window) return;
  const { showLauncher } = await chrome.storage.local.get('showLauncher');
  if (showLauncher === false) return;
  const host = document.createElement('div');
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `button{position:fixed;right:0;top:42%;z-index:2147483646;border:0;border-radius:8px 0 0 8px;padding:10px 7px;background:#0b5cab;color:#fff;font:600 12px/1 system-ui,sans-serif;cursor:pointer;writing-mode:vertical-rl;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:.85}button:hover,button:focus-visible{opacity:1;outline:2px solid #fff;outline-offset:-4px}`;
  const btn = document.createElement('button');
  btn.textContent = '⇄ Data Migrator';
  btn.title = 'Open Salesforce Data Migrator for this org';
  btn.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'open-app', host: location.hostname }));
  root.append(style, btn);
  document.documentElement.appendChild(host);
})();
