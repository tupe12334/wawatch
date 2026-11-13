// Service worker. The hub link lives in the WhatsApp Web tab's content script,
// so closing that tab cut the link. Keep one WhatsApp Web tab open, and stop Chrome from discarding it.
const WA_TABS = 'https://web.whatsapp.com/*';

async function ensureTab() {
  const tabs = await chrome.tabs.query({ url: WA_TABS });
  if (!tabs.length) tabs.push(await chrome.tabs.create({ url: 'https://web.whatsapp.com/', pinned: true, active: false }));
  for (const tab of tabs) await chrome.tabs.update(tab.id, { autoDiscardable: false });
}

const keep = () => ensureTab().catch((err) => console.warn('wawatch: cannot keep a WhatsApp Web tab', err));
chrome.runtime.onInstalled.addListener(keep);
chrome.runtime.onStartup.addListener(keep);
chrome.tabs.onRemoved.addListener(keep);
