// Main world. Runs next to WhatsApp Web's own code, so it can use WPP (wa-js). Talks to content.js by postMessage.
(function () {
  const TO_CONTENT = 'wawatch-bridge';
  const FROM_CONTENT = 'wawatch-content';
  const post = (msg) => window.postMessage({ source: TO_CONTENT, ...msg }, '*');

  function toMessage(m) {
    const text = m.body || (m.type && m.type !== 'chat' ? `[${m.type}]` : '');
    if (!text) return null;
    return {
      id: m.id?._serialized,
      chatId: m.id?.remote?._serialized ?? m.from?._serialized,
      sender: m.fromMe ? 'me' : m.sender?.pushname || m.sender?.name || m.author?._serialized || m.from?._serialized || '',
      fromMe: !!m.fromMe,
      text,
      timestamp: (m.t || 0) * 1000 || Date.now(),
    };
  }

  function listChats() {
    return WPP.chat.list().map((c) => ({ id: c.id._serialized, name: c.formattedTitle || c.name || c.id._serialized }));
  }

  WPP.loader.onReady(() => {
    post({ type: 'chats', chats: listChats() });
    WPP.on('chat.new_message', (m) => {
      const message = toMessage(m);
      if (message) post({ type: 'message', message });
    });
  });

  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.data?.source !== FROM_CONTENT || e.data.type !== 'send') return;
    const { reqId, chatId, text } = e.data;
    try {
      const res = await WPP.chat.sendTextMessage(chatId, text);
      post({ type: 'sent', reqId, messageId: String(res?.id?._serialized ?? res?.id ?? '') });
    } catch (err) {
      post({ type: 'sendError', reqId, error: String(err?.message ?? err) });
    }
  });
})();
