(() => {
  "use strict";
  if (globalThis.__mailAttachmentsCollector) return;
  globalThis.__mailAttachmentsCollector = true;
  const C = MailAttachmentsCore;
  const ROW = '[data-qa-type="file"][data-id]';
  const VERSION = 1;
  const extensionVersion = chrome.runtime.getManifest().version;
  class CollectionError extends Error {}
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let host, ui, checkpointKey, context, running = false, paused = false, stopping = false;
  let records = new Map(), logs = [], droppedLogs = 0, status = "Готов к сбору", startedAt = "", finishedAt = "", reason = "Не запускался";
  let lastSave = 0, saveChain = Promise.resolve();
  const documentScope = crypto.randomUUID();
  const config = { stepDelay: 180, stationaryDelay: 700, endWait: 20000, stallWait: 12000, bridgeTimeout: 1600, maxLogs: 5000 };
  let scrollPosition = "";
  const pending = new Map();
  function log(event, data = {}, level = "info") {
    const entry = { time: new Date().toISOString(), level, event, data };
    logs.push(entry);
    if (logs.length > config.maxLogs) { logs.shift(); droppedLogs++; }
    if (level === "error") console.warn("[Mail attachments]", event, data);
  }
  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin || event.data?.type !== "MAIL_ATTACHMENTS_ROWS_V1") return;
    const resolve = pending.get(event.data.requestId);
    if (resolve) { pending.delete(event.data.requestId); resolve(event.data); }
  });
  function requestPage(type, payload = {}, timeout = config.bridgeTimeout) {
    return new Promise(resolve => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ rows: [], error: "bridge-timeout" }); }, timeout);
      pending.set(requestId, value => { clearTimeout(timer); resolve(value); });
      window.postMessage({ type, requestId, ...payload }, location.origin);
    });
  }
  async function moveList(scroller, target) {
    const from = scroller.scrollTop;
    const offset = Math.max(0, Math.min(target, scroller.scrollHeight - scroller.clientHeight));
    if (Math.abs(from - offset) < 2) return { from, offset, actual: from, method: "already-there" };
    let method = "DOM";
    if (scroller.matches('[class*="VirtualList-new__list--"]')) {
      const result = await requestPage("MAIL_ATTACHMENTS_SCROLL_V1", { offset }, 350);
      if (result.applied) {
        method = "React";
        await sleep(100);
      }
    }
    if (Math.abs(scroller.scrollTop - offset) > 2) {
      method = method === "React" ? "React+DOM" : method;
      scroller.scrollTo({ top: offset, behavior: "instant" });
      await sleep(100);
    }
    return { from, offset, actual: scroller.scrollTop, method };
  }
  function text(node) { return node?.textContent?.trim() || ""; }
  function domRecord(row) {
    const id = row.getAttribute("data-id");
    const author = row.querySelector('[data-qa-id="author"]');
    const sizeText = text(row.querySelector('[class*="Size__size"]'));
    return {
      id, name: row.getAttribute("data-qa-name") || text(row.querySelector('[class*="ItemName__root"]')),
      authorName: author?.getAttribute("title") || author?.getAttribute("aria-label") || "",
      authorEmail: author?.querySelector("img")?.getAttribute("alt") || "",
      subject: text(row.querySelector('[class*="Destination__nameMargin"]')),
      date: text(row.querySelector('[data-qa-id="date"]')), sizeText, bytes: C.bytes(sizeText),
      sizeSource: "display", mailUrl: "", messageId: "", folderId: ""
    };
  }
  let bridgeWarned = false;
  async function collect() {
    // Capture DOM before the asynchronous bridge read; only enrich matching IDs.
    const visible = [...document.querySelectorAll(ROW)].map(domRecord);
    const response = await requestPage("MAIL_ATTACHMENTS_READ_V1");
    if (response.error && !bridgeWarned) { log("model_fallback", { reason: response.error }, "warn"); bridgeWarned = true; }
    const model = new Map((Array.isArray(response.rows) ? response.rows : []).filter(r => r && typeof r.id === "string").map(r => [r.id, r]));
    let added = 0, duplicate = 0;
    for (let row of visible) {
      const data = model.get(row.id);
      if (data) {
        const safe = {};
        for (const k of ["authorName", "authorEmail", "subject", "messageId", "folderId"]) {
          if (typeof data[k] === "string") safe[k] = data[k].slice(0, 32767);
        }
        row = C.merge(row, safe);
        if (Number.isSafeInteger(data.bytes) && data.bytes >= 0) { row.bytes = data.bytes; row.sizeSource = "exact"; }
        row.mailUrl = C.mailLink(row.messageId, row.folderId);
      }
      if (records.has(row.id)) { records.set(row.id, C.merge(records.get(row.id), row)); duplicate++; }
      else { records.set(row.id, row); added++; }
    }
    if (added) log("rows_added", { added, duplicate, visible: visible.length, total: records.size });
    render();
    return { added, visible: visible.length, signature: visible.map(r => r.id).join("|") };
  }
  function allTab() {
    return [...document.querySelectorAll('a[data-qa-id][href], [role="tablist"] a[href]')].find(link =>
      link.origin === location.origin && link.pathname.replace(/\/$/, "") === "/attaches" && link.hash === "#all");
  }
  function activeAll() {
    const all = allTab();
    return Boolean(all && (all.className.includes("TabMenuItem__active") ||
      all.getAttribute("aria-selected") === "true" || ["page", "true"].includes(all.getAttribute("aria-current"))));
  }
  function currentContext() {
    const url = new URL(location.href);
    // Only account selector is retained in memory; never retain full signed URLs.
    return url.searchParams.get("email") || url.searchParams.get("x-email") || "";
  }
  async function identity() {
    const { tabId } = await chrome.runtime.sendMessage({ type: "MAIL_ATTACHMENTS_TAB" });
    // Without a visible account selector, never auto-restore another account's run.
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(currentContext() || documentScope));
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
    return `mailAttachments:v${VERSION}:${tabId}:${hash}`;
  }
  function scopeIsValid() {
    const search = document.querySelector('input[placeholder*="Поиск"]');
    return location.pathname.startsWith("/attaches") && activeAll() && currentContext() === context && !search?.value?.trim();
  }
  function findScroller() {
    const list = document.querySelector('[data-qa-datalist="attaches"]');
    if (!list) return null;
    const first = list.querySelector(ROW);
    const virtual = list.querySelector('[class*="VirtualList-new__list--"]');
    const candidates = [];
    for (let node = first?.parentElement || virtual || list; node; node = node.parentElement) {
      if (node.clientHeight < 30) continue;
      const overflow = getComputedStyle(node).overflowY;
      if (node === virtual || node === document.scrollingElement || /^(auto|scroll|hidden)$/.test(overflow)) candidates.push(node);
    }
    const scrollable = node => node && node.scrollHeight > node.clientHeight + 1;
    if (scrollable(virtual) && candidates.includes(virtual)) return virtual;
    return candidates.find(scrollable) || (virtual?.clientHeight >= 30 ? virtual : candidates.find(node => list.contains(node))) || null;
  }
  function loading() {
    const list = document.querySelector('[data-qa-datalist="attaches"]');
    return Boolean(list?.querySelector('[aria-busy="true"], [role="progressbar"], [class*="Spinner__"], [class*="Loader__"], [class*="VirtualList-new__loader--"]'));
  }
  document.addEventListener("wheel", event => {
    if (!location.pathname.startsWith("/attaches") || running || event.defaultPrevented || event.ctrlKey || !event.deltaY) return;
    const list = event.target.closest?.('[data-qa-datalist="attaches"]');
    if (!list) return;
    const scroller = findScroller();
    if (!scroller?.matches('[class*="VirtualList-new__list--"]:not([class*="VirtualList-new__listDisableScroll"])') ||
      getComputedStyle(scroller).overflowY !== "hidden") return;
    const top = scroller.scrollTop;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1;
    scroller.scrollTop += event.deltaY * scale;
    if (top !== scroller.scrollTop) event.preventDefault();
  }, { passive: false });
  function viewportCovered(scroller) {
    const box = scroller.getBoundingClientRect();
    const rects = [...scroller.querySelectorAll(ROW)].map(row => row.getBoundingClientRect()).filter(r => r.height > 0);
    if (!rects.length) return false;
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= 3;
    // Text can extend a few pixels past a fixed-height final row. At the bottom,
    // the separate 20-second settle phase still collects delayed final rows.
    const tolerance = atBottom ? Math.max(3, Math.min(64, Math.max(...rects.map(r => r.height)))) : 3;
    return Math.min(...rects.map(r => r.top)) <= box.top + 3 && Math.max(...rects.map(r => r.bottom)) >= box.top + scroller.clientHeight - tolerance;
  }
  function summary() {
    const rows = [...records.values()];
    return {
      "Начало UTC": startedAt, "Окончание UTC": finishedAt, "Состояние": status, "Причина остановки": reason,
      "Охват": "Все вложения, доступные на вкладке «Все»", "Собрано вложений": records.size,
      "Без ссылки": rows.filter(r => !r.mailUrl).length, "Без имени и адреса": rows.filter(r => !r.authorName && !r.authorEmail).length,
      "Без точного размера": rows.filter(r => r.sizeSource !== "exact").length,
      "Старых событий удалено из журнала": droppedLogs, "Версия расширения": extensionVersion
    };
  }
  async function save(force = false) {
    if (!checkpointKey || (!force && Date.now() - lastSave < 5000)) return;
    lastSave = Date.now();
    const snapshot = { version: VERSION, extensionVersion, rows: [...records.values()], logs: [...logs], droppedLogs, startedAt, finishedAt, status, reason, savedAt: new Date().toISOString() };
    const key = checkpointKey;
    saveChain = saveChain.catch(() => {}).then(() => chrome.storage.local.set({ [key]: snapshot }));
    try { await saveChain; }
    catch { log("checkpoint_failed", {}, "error"); setNotice("Не удалось сохранить контрольную копию. Скачайте Excel до закрытия страницы."); }
  }
  async function run(resume = false) {
    if (running) return;
    running = true; stopping = false; paused = false; status = "Подготовка"; scrollPosition = ""; render();
    try {
      if (resume && context !== currentContext()) throw new CollectionError("Аккаунт изменился. Начните новый сбор, чтобы не смешивать данные.");
      // Explicitly switch the site's own filter, not merely change the outer app URL.
      if (!activeAll()) {
        const all = allTab();
        if (!all) throw new CollectionError("Не найдена вкладка «Все». Откройте раздел вложений в режиме списка.");
        all.click();
        const deadline = Date.now() + 15000;
        while (!activeAll() && Date.now() < deadline) await sleep(250);
        if (!activeAll()) throw new CollectionError("Не удалось переключиться на все вложения.");
        await sleep(1800);
      }
      const search = document.querySelector('input[placeholder*="Поиск"]');
      if (search?.value?.trim()) throw new CollectionError("Очистите поиск по вложениям перед сбором всех файлов.");
      context = currentContext();
      checkpointKey = await identity();
      if (!resume) { records.clear(); logs = []; droppedLogs = 0; startedAt = new Date().toISOString(); }
      finishedAt = ""; status = "Собираю"; reason = "Сбор идёт";
      log(resume ? "resumed_from_top" : "started", { settings: config });
      let scroller = null;
      const deadline = Date.now() + 20000;
      while (!scroller && Date.now() < deadline && !stopping) { scroller = findScroller(); if (!scroller) await sleep(400); }
      if (!scroller) throw new CollectionError("Не найден прокручиваемый список. Если он пуст, проверьте вкладку и загрузку страницы.");
      log("scroll_container", {
        virtualList: scroller.matches('[class*="VirtualList-new__list--"]'),
        overflow: getComputedStyle(scroller).overflowY,
        height: scroller.scrollHeight, viewport: scroller.clientHeight, top: scroller.scrollTop
      });
      const startingTop = scroller.scrollTop;
      const startingSignature = [...scroller.querySelectorAll(ROW)].map(row => row.getAttribute("data-id")).join("|");
      log("scroll_to_start", await moveList(scroller, 0));
      if (scroller.scrollTop > 3) throw new CollectionError("Не удалось вернуться к началу списка.");
      await sleep(1200);
      let bottomSince = 0, stallSince = 0, previousSignature = "", lastProgress = Date.now(), previousHeight = 0;
      let awaitingSignature = startingTop > 3 ? startingSignature : null;
      let movedAt = Date.now(), lastScrollLog = 0;
      while (!stopping) {
        if (paused || document.hidden) {
          status = document.hidden ? "Ожидаю видимую вкладку" : "Пауза"; render();
          bottomSince = 0; stallSince = 0; lastProgress = Date.now();
          await save(); await sleep(500); continue;
        }
        status = "Собираю";
        if (!scopeIsValid()) throw new CollectionError("Изменился аккаунт, раздел или вкладка «Все». Сбор остановлен, данные сохранены.");
        if (!scroller.isConnected) { scroller = findScroller(); if (!scroller) throw new CollectionError("Список исчез со страницы."); }
        const batch = await collect();
        const height = scroller.scrollHeight, top = scroller.scrollTop, viewport = scroller.clientHeight;
        scrollPosition = `Позиция: ${Math.round(top)} из ${Math.max(0, height - viewport)} пикселей загруженного списка.`;
        render();
        // Do not move again before React has rendered the previous viewport.
        // Otherwise a slow render could skip attachments between two scroll steps.
        if (awaitingSignature !== null) {
          if (batch.signature !== awaitingSignature || viewportCovered(scroller)) { awaitingSignature = null; }
          else if (Date.now() - movedAt < 12000) { await save(); await sleep(120); continue; }
          else throw new CollectionError("Страница не обновила строки после прокрутки за 12 секунд. Сохранён частичный результат.");
        }
        const changed = batch.signature !== previousSignature || height !== previousHeight || batch.added > 0;
        if (changed) { lastProgress = Date.now(); bottomSince = 0; stallSince = 0; }
        previousSignature = batch.signature; previousHeight = height;
        const atBottom = height - top - viewport <= 3;
        if (atBottom && !loading() && batch.visible > 0) {
          if (!bottomSince) { bottomSince = Date.now(); log("bottom_wait", { count: records.size, height, top }); }
          if (Date.now() - bottomSince >= config.endWait) {
            reason = "Низ списка стабилен 20 секунд; новые строки и подгрузка не обнаружены";
            status = "Конец списка достигнут"; log("end_detected", { count: records.size }); break;
          }
        } else {
          bottomSince = 0;
          const step = Math.max(20, Math.floor(viewport * 0.65));
          const movement = await moveList(scroller, top + step);
          if (Date.now() - lastScrollLog >= 1500) {
            log("scroll_step", { ...movement, height, viewport, visible: batch.visible });
            lastScrollLog = Date.now();
          }
          if (Math.abs(movement.actual - top) >= 2) { awaitingSignature = batch.signature; movedAt = Date.now(); stallSince = 0; }
          if (Math.abs(movement.actual - top) < 2 && !atBottom) {
            if (!stallSince) { stallSince = Date.now(); log("scroll_stalled", { top, height, viewport }, "warn"); }
          }
        }
        if ((stallSince && Date.now() - stallSince > config.stallWait) || Date.now() - lastProgress > 90000) {
          throw new CollectionError("Нет продвижения или подгрузка зависла. Сохранён частичный результат; можно продолжить.");
        }
        await save(); await sleep(atBottom ? config.stationaryDelay : config.stepDelay);
      }
      if (stopping) { status = "Остановлен пользователем"; reason = "Частичный результат: пользователь нажал «Стоп»"; log("stopped", { count: records.size }); }
    } catch (error) {
      status = "Ошибка — результат частичный";
      reason = error instanceof CollectionError ? error.message : "Не удалось завершить сбор из-за ошибки страницы или расширения.";
      log("collection_error", { message: reason }, "error"); setNotice(reason);
    } finally {
      finishedAt = new Date().toISOString(); running = false; paused = false;
      await save(true); render();
    }
  }
  async function download(blob, kind, partial = false) {
    setNotice("Готовлю скачивание…");
    const id = crypto.randomUUID();
    const chunkSize = 256 * 1024;
    try {
      for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, blob.size);
        const buffer = await blob.slice(offset, end).arrayBuffer();
        const data = new Uint8Array(buffer);
        let binary = "";
        for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
        const result = await chrome.runtime.sendMessage({
          type: "MAIL_ATTACHMENTS_EXPORT", id, kind, partial, chunk: btoa(binary), final: end === blob.size
        });
        if (!result?.ok) throw new Error(result?.error || "Chrome не принял файл.");
      }
      setNotice("Скачивание началось. Проверьте загрузки Chrome.");
    } catch (error) {
      log("download_failed", { kind }, "error");
      setNotice(`Chrome не начал скачивание: ${error.message}`);
    }
  }
  function exportExcel() {
    try {
      log("excel_export", { count: records.size, status });
      download(MailAttachmentsXlsx.create(C.sorted(records.values()), summary(), logs), "excel", status !== "Конец списка достигнут");
    } catch (error) { log("export_error", {}, "error"); setNotice(error.message); }
  }
  function setNotice(value) { if (ui) ui.querySelector("#notice").textContent = value; }
  function render() {
    if (!ui) return;
    ui.querySelector("#status").textContent = `${status}. Файлов: ${records.size.toLocaleString("ru")}`;
    ui.querySelector("#start").disabled = running;
    ui.querySelector("#resume").disabled = running || !records.size;
    ui.querySelector("#pause").disabled = !running;
    ui.querySelector("#pause").textContent = paused ? "Продолжить" : "Пауза";
    ui.querySelector("#stop").disabled = !running;
    ui.querySelector("#excel").disabled = !records.size;
    ui.querySelector("#clear").disabled = running || !records.size;
    ui.querySelector("#reason").textContent = running ? scrollPosition || "Держите вкладку открытой и видимой." : reason;
    if (!running) {
      const info = summary();
      ui.querySelector("#quality").textContent = records.size ? `Без ссылки: ${info["Без ссылки"]}. Без точного размера: ${info["Без точного размера"]}. Без автора: ${info["Без имени и адреса"]}.` : "";
    }
  }
  async function mount() {
    if (host || !location.pathname.startsWith("/attaches") || !document.querySelector('[data-qa-datalist="attaches"]')) return;
    host = document.createElement("div");
    host.id = "mail-attachments-export-panel";
    host.style.cssText = "position:fixed;bottom:18px;right:18px;z-index:2147483647;max-width:calc(100vw - 36px)";
    ui = host.attachShadow({ mode: "closed" });
    ui.innerHTML = `<style>:host{all:initial}section{box-sizing:border-box;width:365px;max-width:calc(100vw - 36px);font:13px/1.45 system-ui,sans-serif;color:#222;background:#fff;border:1px solid #ccd6e4;border-radius:12px;box-shadow:0 5px 30px #0003;padding:14px}h3{font-size:15px;margin:0 0 10px}p{margin:8px 0;overflow-wrap:anywhere}button{font:inherit;background:#edf2f7;color:#123;border:0;border-radius:6px;padding:8px 10px;cursor:pointer;margin:3px 3px 3px 0}button:disabled{opacity:.45;cursor:default}#start,#excel{background:#0969d8;color:#fff}#notice{color:#a33}#reason{font-size:12px;color:#556}summary{cursor:pointer}#status{font-weight:600}</style><section>
      <details open><summary><b>Вложения Mail.ru → Excel</b></summary>
      <p id="status"></p><p id="reason"></p><p id="quality"></p><p id="notice"></p>
      <button id="start">Собрать все с начала</button><button id="resume">Дособрать</button>
      <button id="pause">Пауза</button><button id="stop">Стоп</button>
      <p><button id="excel">Скачать Excel</button><button id="logs">Скачать журнал</button><button id="clear">Очистить</button></p>
      <small>Данные сохраняются локально. «Дособрать» повторяет проход с начала без повторов. Журнал не содержит имён файлов и адресов.</small>
      </details></section>`;
    document.documentElement.append(host);
    ui.querySelector("#start").onclick = () => { setNotice(""); run(false); };
    ui.querySelector("#resume").onclick = () => { setNotice(""); run(true); };
    ui.querySelector("#pause").onclick = () => { paused = !paused; log(paused ? "paused" : "unpaused"); render(); };
    ui.querySelector("#stop").onclick = () => { stopping = true; paused = false; };
    ui.querySelector("#excel").onclick = exportExcel;
    ui.querySelector("#logs").onclick = () => {
      // Deliberately exclude personal checkpoint records and account selectors.
      download(new Blob([JSON.stringify({ version: VERSION, info: summary(), logs }, null, 2)], { type: "application/json" }), "log");
    };
    ui.querySelector("#clear").onclick = async () => {
      records.clear(); logs = []; droppedLogs = 0; startedAt = ""; finishedAt = ""; status = "Готов к сбору"; reason = "Данные очищены";
      if (checkpointKey) await chrome.storage.local.remove(checkpointKey);
      render();
    };
    render();
    try {
      checkpointKey = await identity(); context = currentContext();
      const saved = (await chrome.storage.local.get(checkpointKey))[checkpointKey];
      if (!running && saved?.version === VERSION && Array.isArray(saved.rows)) {
        records = new Map(saved.rows.map(r => [r.id, r]));
        // Older versions could store raw browser errors. Only restore rows from those checkpoints.
        logs = saved.extensionVersion === extensionVersion ? saved.logs || [] : [];
        droppedLogs = saved.extensionVersion === extensionVersion ? saved.droppedLogs || 0 : 0;
        startedAt = saved.startedAt; finishedAt = saved.finishedAt; status = "Восстановлены сохранённые данные";
        reason = `Контрольная копия: ${saved.savedAt}. Для полного прохода нажмите «Дособрать».`;
        log("checkpoint_restored", { count: records.size }); render();
      }
    } catch { log("restore_failed", {}, "warn"); }
  }
  new MutationObserver(() => { if (!host) mount(); }).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("pagehide", () => { if (records.size) save(true); });
  mount();
})();
