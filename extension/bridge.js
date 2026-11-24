// Main world. Runs next to WhatsApp Web's own code, so it can use WPP (wa-js). Talks to content.js by postMessage.
(function () {
  const TO_CONTENT = 'wawatch-bridge';
  const FROM_CONTENT = 'wawatch-content';
  const post = (msg) => window.postMessage({ source: TO_CONTENT, ...msg }, '*');

  // m is a wa-js MsgModel: fromMe lives on the MsgKey (m.id), the sender contact on m.senderObj (m.sender is a bare Wid).
  function toMessage(m) {
    const fromMe = !!m.id?.fromMe;
    // wa-js emits a not-yet-decrypted message as 'ciphertext', then again with the real text.
    if (m.type === 'ciphertext') return null;
    const text = m.body || (m.type && m.type !== 'chat' ? `[${m.type}]` : '');
    if (!text) return null;
    return {
      id: m.id?._serialized,
      chatId: m.id?.remote?._serialized ?? m.from?._serialized,
      sender: fromMe ? 'me' : m.senderObj?.pushname || m.senderObj?.name || m.author?._serialized || m.from?._serialized || '',
      fromMe,
      text,
      timestamp: (m.t || 0) * 1000 || Date.now(),
    };
  }

  // Ids already posted. wa-js can fire for the same message twice, so this keeps each message to one post.
  const posted = new Set();

  function postOnce(message) {
    if (!message || posted.has(message.id)) return;
    posted.add(message.id);
    post({ type: 'message', message });
  }

  // wa-js does not fire chat.new_message again once a ciphertext message is decrypted.
  // Wait for the text on the model, and re-read the message at 3 s and 10 s as a fallback.
  function waitForText(m) {
    const id = m.id?._serialized;
    const timers = [];
    let done = false;

    const stop = () => {
      m.off?.('change:type', onChange);
      m.off?.('change:body', onChange);
    };
    // Post once, then drop the listeners and the pending re-reads.
    const finish = (message) => {
      if (done) return;
      done = true;
      stop();
      timers.forEach(clearTimeout);
      postOnce(message);
    };
    const check = (model) => {
      const message = toMessage(model);
      if (message) finish(message);
    };
    const onChange = () => check(m);
    const reread = async () => {
      try {
        const fresh = await WPP.chat.getMessageById(id);
        if (fresh) check(fresh);
      } catch (err) {
        console.warn('wawatch: message re-read failed', err);
      }
    };

    m.on?.('change:type', onChange);
    m.on?.('change:body', onChange);
    timers.push(setTimeout(reread, 3000));
    // At 10 s, make the last re-read, then stop listening even if the text never came.
    timers.push(setTimeout(() => { reread(); stop(); }, 10000));
  }

  // WPP.chat.list() is async in wa-js 4.x.
  async function listChats() {
    return (await WPP.chat.list()).map((c) => ({ id: c.id._serialized, name: c.formattedTitle || c.name || c.id._serialized }));
  }

  // A failed list posts nothing; the next resync tries again.
  async function postChats() {
    try {
      post({ type: 'chats', chats: await listChats() });
    } catch (err) {
      console.warn('wawatch: chat list failed', err);
    }
  }

  let ready = false;

  WPP.loader.onReady(() => {
    ready = true;
    postChats();
    WPP.on('chat.new_message', (m) => {
      const message = toMessage(m);
      if (message) postOnce(message);
      else if (m.type === 'ciphertext') waitForText(m);
    });
  });

  // The hub socket may open after WPP is ready, so content.js asks for the chat list again.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.source !== FROM_CONTENT || e.data.type !== 'resync') return;
    if (ready) postChats();
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
