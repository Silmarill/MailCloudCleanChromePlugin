/* Adapter to the React list and the data backing its visible attachment rows.
 * Internal React fields can change; isolated collector keeps a DOM fallback.
 */
(() => {
  "use strict";
  const primitive = value => typeof value === "string" || typeof value === "number" ? String(value) : "";
  function fiberFor(node) {
    const key = Object.keys(node).find(k => k.startsWith("__reactFiber$") || k.startsWith("__reactInternalInstance$"));
    return key && node[key];
  }
  function propsAlong(node) {
    const props = [];
    let fiber = fiberFor(node);
    for (let depth = 0; fiber && depth < 24; depth++, fiber = fiber.return) {
      if (fiber.memoizedProps) props.push(fiber.memoizedProps);
    }
    const propKey = Object.keys(node).find(k => k.startsWith("__reactProps$"));
    if (propKey) props.push(node[propKey]);
    return props;
  }
  function read(row) {
    const id = row.getAttribute("data-id");
    const nodes = [row, row.querySelector('[class*="Destination__root"]'), row.querySelector('[data-qa-id="author"]')].filter(Boolean);
    let item, author, subject = "";
    for (const node of nodes) for (const props of propsAlong(node)) {
      const candidate = props.item;
      if (candidate && String(candidate.id) === id) item = candidate;
      if (String(props.id) === id && props.owner) author = props.owner;
      if (props.author && typeof props.author === "object" && props.isAttaches) author = props.author;
      if (props.isAttaches && typeof props.destination === "string") subject = props.destination;
    }
    const size = item?.size;
    const raw = typeof size === "number" ? size : typeof size?.original === "number" ? size.original : null;
    return {
      id,
      authorName: primitive(item?.authorName || author?.name),
      authorEmail: primitive(item?.authorEmail || author?.email),
      subject: primitive(item?.subject || subject),
      messageId: primitive(item?.message_id),
      folderId: primitive(item?.folderId ?? item?.folder_id),
      bytes: Number.isSafeInteger(raw) && raw >= 0 ? raw : null
    };
  }
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) return;
    const { type, requestId, offset } = event.data || {};
    if (type !== "MAIL_ATTACHMENTS_READ_V1" && type !== "MAIL_ATTACHMENTS_SCROLL_V1") return;
    if (typeof requestId !== "string" || requestId.length > 80 || !location.pathname.startsWith("/attaches")) return;
    if (type === "MAIL_ATTACHMENTS_SCROLL_V1") {
      const node = document.querySelector('[data-qa-datalist="attaches"] [class*="VirtualList-new__list--"], [data-qa-datalist="attaches"][class*="VirtualList-new__list--"]');
      let applied = false;
      try {
        if (node && Number.isFinite(offset)) {
          const top = Math.max(0, Math.min(offset, node.scrollHeight - node.clientHeight));
          let fiber = fiberFor(node);
          for (let depth = 0; fiber && depth < 16; depth++, fiber = fiber.return) {
            const list = fiber.stateNode;
            if (list?._outerRef === node && typeof list.scrollTo === "function" &&
              typeof list.state?.scrollOffset === "number") {
              list.scrollTo(top);
              applied = true;
              break;
            }
          }
        }
      } catch { /* The collector can still try a native DOM scroll. */ }
      window.postMessage({ type: "MAIL_ATTACHMENTS_ROWS_V1", requestId, applied }, location.origin);
      return;
    }
    try {
      const rows = Array.from(document.querySelectorAll('[data-qa-type="file"][data-id]')).slice(0, 1000).map(read);
      window.postMessage({ type: "MAIL_ATTACHMENTS_ROWS_V1", requestId, rows }, location.origin);
    } catch {
      window.postMessage({ type: "MAIL_ATTACHMENTS_ROWS_V1", requestId, rows: [], error: "page-model-unavailable" }, location.origin);
    }
  });
})();
