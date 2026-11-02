// Isolated world. Injects wa-js and bridge.js into the page, then relays between the page and the hub.
(function () {
  const HUB_URL = 'ws://127.0.0.1:4747/extension';
  const RETRY_MS = 5000;
  let ws = null;

  function inject(files) {
    if (!files.length) return;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL(files[0]);
    script.onload = () => {
      script.remove();
      inject(files.slice(1));
    };
    (document.head || document.documentElement).appendChild(script);
  }

  async function connect() {
    const { token } = await chrome.storage.local.get('token');
    if (!token) return setTimeout(connect, RETRY_MS);
    ws = new WebSocket(`${HUB_URL}?token=${encodeURIComponent(token)}`);
    ws.onmessage = (e) => window.postMessage({ source: 'wawatch-content', ...JSON.parse(e.data) }, '*');
    ws.onclose = () => {
      ws = null;
      setTimeout(connect, RETRY_MS);
    };
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== 'wawatch-bridge') return;
    const { source, ...msg } = e.data;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  });

  inject(['wa-js.js', 'bridge.js']);
  connect();
})();
