"use strict";
let creatingOffscreen;
async function ensureOffscreen() {
  creatingOffscreen ??= (async () => {
    const url = chrome.runtime.getURL("download.html");
    const existing = chrome.runtime.getContexts
      ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] })
      : (await clients.matchAll()).filter(client => client.url === url);
    if (!existing.length) {
      await chrome.offscreen.createDocument({
        url: "download.html",
        reasons: ["BLOBS"],
        justification: "Create a local file URL for Excel and diagnostic exports."
      });
    }
  })().finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "MAIL_ATTACHMENTS_EXPORT" || !sender.tab || !sender.url?.startsWith("https://cloud.mail.ru/attaches")) return;
  (async () => {
    await ensureOffscreen();
    const key = `${sender.tab.id}:${sender.frameId}:${message.id}`;
    const result = await chrome.runtime.sendMessage({ ...message, type: "MAIL_ATTACHMENTS_BLOB", key });
    if (!result?.ok) throw new Error("Не удалось подготовить файл.");
    if (result.url) {
      const filename = message.kind === "log" ? "mail-attachments-log.json" :
        `mail-attachments${message.partial ? "-частично" : ""}-${new Date().toISOString().replace(/[:.]/g, "-")}.xlsx`;
      return chrome.downloads.download({ url: result.url, filename });
    }
  })().then(id => respond({ ok: true, id }), error => respond({ ok: false, error: error.message }));
  return true;
});

// A separate checkpoint for every tab; no account names or cookies in the key.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type === "MAIL_ATTACHMENTS_TAB" && sender.tab) {
    respond({ tabId: sender.tab.id });
  }
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const stored = await chrome.storage.local.get(null);
  const prefix = `mailAttachments:v1:${tabId}:`;
  const keys = Object.keys(stored).filter(key => key.startsWith(prefix));
  if (keys.length) await chrome.storage.local.remove(keys);
});
