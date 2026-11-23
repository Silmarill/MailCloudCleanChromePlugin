/* Shared, dependency-free parsing and merge rules. IDs always remain strings. */
(function (root) {
  "use strict";
  function bytes(value) {
    if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
    const match = String(value ?? "").replace(/[\s\u00a0\u202f]/g, "").replace(",", ".")
      .match(/^(\d+(?:\.\d+)?)(Б|B|КБ|KB|KIB|КИБ|МБ|MB|MIB|МИБ|ГБ|GB|GIB|ГИБ|ТБ|TB|TIB|ТИБ)?$/i);
    if (!match) return null;
    const u = (match[2] || "B").toUpperCase();
    const power = /^(К|K)/.test(u) ? 1 : /^(М|M)/.test(u) ? 2 : /^(Г|G)/.test(u) ? 3 : /^(Т|T)/.test(u) ? 4 : 0;
    return Math.round(Number(match[1]) * 1024 ** power);
  }
  function mailLink(messageId, folderId) {
    if (!/^\d+$/.test(String(messageId)) || !/^\d+$/.test(String(folderId))) return "";
    return `https://app.mail.ru/mail/${folderId}/0:${messageId}:${folderId}/?source=mail-superapp&platform=web&folder_id=${folderId}`;
  }
  function merge(previous, next) {
    const result = { ...previous };
    for (const [key, value] of Object.entries(next)) {
      if (value !== "" && value !== null && value !== undefined) result[key] = value;
    }
    // A rounded DOM size must never replace an exact value from the page model.
    if (previous?.sizeSource === "exact" && next.sizeSource !== "exact") {
      result.bytes = previous.bytes;
      result.sizeSource = "exact";
    }
    return result;
  }
  function sorted(rows) {
    return [...rows].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || a.name.localeCompare(b.name, "ru") || a.id.localeCompare(b.id));
  }
  root.MailAttachmentsCore = { bytes, mailLink, merge, sorted };
  if (typeof module !== "undefined") module.exports = root.MailAttachmentsCore;
})(globalThis);
