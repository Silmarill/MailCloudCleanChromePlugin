"use strict";
const transfers = new Map();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "MAIL_ATTACHMENTS_BLOB" || sender.tab) return;
  try {
    const { key, chunk, final, kind } = message;
    let transfer = transfers.get(key);
    if (!transfer) {
      transfer = { parts: [] };
      transfers.set(key, transfer);
    }
    clearTimeout(transfer.timer);
    transfer.parts.push(Uint8Array.from(atob(chunk), character => character.charCodeAt(0)));
    if (!final) {
      transfer.timer = setTimeout(() => transfers.delete(key), 120000);
      respond({ ok: true });
      return;
    }
    transfers.delete(key);
    const type = kind === "log" ? "application/json" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const url = URL.createObjectURL(new Blob(transfer.parts, { type }));
    setTimeout(() => URL.revokeObjectURL(url), 600000);
    respond({ ok: true, url });
  } catch {
    transfers.delete(message.key);
    respond({ ok: false });
  }
});
