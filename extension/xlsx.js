/* Small OOXML/ZIP writer. Produces a real .xlsx, with no CDN or executable formulas. */
(function (root) {
  "use strict";
  const enc = new TextEncoder();
  const xml = value => String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  function col(n) {
    let s = "";
    for (n++; n; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s;
    return s;
  }
  function cell(value, row, column, style) {
    const ref = `${col(column)}${row}`;
    const s = style ? ` s="${style}"` : "";
    return typeof value === "number" && Number.isFinite(value)
      ? `<c r="${ref}"${s}><v>${value}</v></c>`
      : `<c r="${ref}" t="inlineStr"${s}><is><t xml:space="preserve">${xml(String(value ?? "").slice(0, 32767))}</t></is></c>`;
  }
  function sheet(matrix, widths, hyperlinks = []) {
    if (matrix.length > 1048576) throw new Error("Слишком много строк для одного листа Excel (максимум 1 048 575 вложений).");
    const cols = widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join("");
    const linked = new Set(hyperlinks.map(h => `${h.row}:${h.col}`));
    const data = matrix.map((row, i) => `<row r="${i + 1}">${row.map((v, j) => cell(v, i + 1, j, i === 0 ? 1 : linked.has(`${i + 1}:${j}`) ? 2 : 0)).join("")}</row>`).join("");
    const links = hyperlinks.length ? `<hyperlinks>${hyperlinks.map((h, i) => `<hyperlink ref="${col(h.col)}${h.row}" r:id="rId${i + 1}"/>`).join("")}</hyperlinks>` : "";
    return header + `<worksheet xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><dimension ref="A1:${col(matrix[0].length - 1)}${matrix.length}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${cols}</cols><sheetData>${data}</sheetData><autoFilter ref="A1:${col(matrix[0].length - 1)}${matrix.length}"/>${links}</worksheet>`;
  }
  const table = Array.from({ length: 256 }, (_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  function crc32(data) {
    let c = 0xffffffff;
    for (const byte of data) c = table[(c ^ byte) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  function zip(files) {
    const parts = [], central = [];
    let offset = 0, centralSize = 0;
    const put16 = (v, o, n) => v.setUint16(o, n, true);
    const put32 = (v, o, n) => v.setUint32(o, n, true);
    for (const [name, content] of Object.entries(files)) {
      const path = enc.encode(name), data = enc.encode(content), crc = crc32(data);
      if (offset + data.length > 0xffffffff) throw new Error("Книга превышает размер ZIP32.");
      const local = new Uint8Array(30 + path.length), l = new DataView(local.buffer);
      put32(l, 0, 0x04034b50); put16(l, 4, 20); put16(l, 6, 0x800);
      put16(l, 12, 33); put32(l, 14, crc); put32(l, 18, data.length); put32(l, 22, data.length); put16(l, 26, path.length);
      local.set(path, 30); parts.push(local, data);
      const directory = new Uint8Array(46 + path.length), d = new DataView(directory.buffer);
      put32(d, 0, 0x02014b50); put16(d, 4, 20); put16(d, 6, 20); put16(d, 8, 0x800);
      put16(d, 14, 33); put32(d, 16, crc); put32(d, 20, data.length); put32(d, 24, data.length);
      put16(d, 28, path.length); put32(d, 42, offset); directory.set(path, 46);
      central.push(directory); centralSize += directory.length; offset += local.length + data.length;
    }
    const end = new Uint8Array(22), e = new DataView(end.buffer);
    put32(e, 0, 0x06054b50); put16(e, 8, central.length); put16(e, 10, central.length);
    put32(e, 12, centralSize); put32(e, 16, offset);
    return new Blob([...parts, ...central, end], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }
  function create(rows, info, logs) {
    const links = [];
    const matrix = [["Имя файла", "Размер, байт", "Размер, МиБ", "Размер на странице", "Имя отправителя / автора", "Email автора", "Тема письма", "Дата на странице", "Ссылка на письмо", "Точность размера", "ID вложения", "Статус ссылки"]];
    rows.forEach((r, i) => {
      if (r.mailUrl && /^https:\/\/app\.mail\.ru\/mail\/\d+\/0:\d+:\d+\//.test(r.mailUrl)) links.push({ row: i + 2, col: 8, url: r.mailUrl });
      matrix.push([r.name, r.bytes, r.bytes == null ? "" : Math.round(r.bytes / 1048576 * 10000) / 10000, r.sizeText,
        r.authorName || r.authorEmail, r.authorEmail, r.subject, r.date, r.mailUrl,
        r.sizeSource === "exact" ? "Точный" : r.bytes == null ? "Не распознан" : "Оценка по округлённому размеру", r.id,
        r.mailUrl ? "Из ID письма и папки страницы" : "Не удалось определить папку письма"]);
    });
    const meta = [["Параметр", "Значение"], ...Object.entries(info), ["Примечание", "Конец списка подтверждён ожиданием стабильного низа; общее число вложений сервером не сверялось."],
      ["Автор", "Имя отправителя/автора, которое Mail.ru передаёт карточке вложения; тема письма хранится отдельно."],
      ["Ссылки", "Сформированы по предоставленному формату Mail.ru. Открываются в авторизованном аккаунте."],
      ["Размер", "Если точные байты недоступны, оценка из текста страницы (1024 байта в КБ) отмечена явно."]];
    const logMatrix = [["Время UTC", "Уровень", "Событие", "Данные"], ...logs.map(l => [l.time, l.level, l.event, JSON.stringify(l.data || {})])];
    const relNs = "http://schemas.openxmlformats.org/package/2006/relationships";
    const relType = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";
    const files = {
      "[Content_Types].xml": header + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + [1, 2, 3].map(i => `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("") + '</Types>',
      "_rels/.rels": header + `<Relationships xmlns="${relNs}"><Relationship Id="rId1" Type="${relType}officeDocument" Target="xl/workbook.xml"/></Relationships>`,
      "xl/workbook.xml": header + `<workbook xmlns="${ns}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Вложения" sheetId="1" r:id="rId1"/><sheet name="О сборе" sheetId="2" r:id="rId2"/><sheet name="Журнал" sheetId="3" r:id="rId3"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": header + `<Relationships xmlns="${relNs}">` + [1, 2, 3].map(i => `<Relationship Id="rId${i}" Type="${relType}worksheet" Target="worksheets/sheet${i}.xml"/>`).join("") + `<Relationship Id="rId4" Type="${relType}styles" Target="styles.xml"/></Relationships>`,
      "xl/styles.xml": header + `<styleSheet xmlns="${ns}"><fonts count="3"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font><font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`,
      "xl/worksheets/sheet1.xml": sheet(matrix, [55, 19, 18, 22, 30, 30, 45, 21, 55, 36, 35, 44], links),
      "xl/worksheets/sheet2.xml": sheet(meta, [32, 105]),
      "xl/worksheets/sheet3.xml": sheet(logMatrix, [28, 14, 30, 100])
    };
    if (links.length) files["xl/worksheets/_rels/sheet1.xml.rels"] = header + `<Relationships xmlns="${relNs}">` + links.map((h, i) => `<Relationship Id="rId${i + 1}" Type="${relType}hyperlink" Target="${xml(h.url)}" TargetMode="External"/>`).join("") + '</Relationships>';
    return zip(files);
  }
  root.MailAttachmentsXlsx = { create };
  if (typeof module !== "undefined") module.exports = root.MailAttachmentsXlsx;
})(globalThis);
