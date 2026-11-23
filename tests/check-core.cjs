const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../extension/core.js');
const X = require('../extension/xlsx.js');
assert.equal(C.bytes('59.6\u00a0КБ'), 61030);
assert.equal(C.bytes('1,5 МБ'), 1572864);
assert.equal(C.bytes('0 Б'), 0);
assert.equal(C.bytes('нет'), null);
assert.equal(C.mailLink('9000000000000000347', '500000'), 'https://app.mail.ru/mail/500000/0:9000000000000000347:500000/?source=mail-superapp&platform=web&folder_id=500000');
assert.equal(C.mailLink('123', ''), '');
assert.equal(C.mailLink('1/evil', '0'), '');
assert.equal(C.merge({bytes:123,sizeSource:'exact'}, {bytes:120,sizeSource:'display'}).bytes, 123);
assert.deepEqual(C.sorted([{id:'a',name:'x',bytes:null},{id:'b',name:'x',bytes:4},{id:'c',name:'x',bytes:10}]).map(r=>r.id), ['c','b','a']);
(async () => {
  const rows = C.sorted([
    {id:'9000000000000000347;0;1',name:'=HYPERLINK("bad") <&>.pdf',bytes:100000,authorName:'Тестовый отправитель',authorEmail:'example@example.test',subject:'Тема',date:'01.01.25',sizeSource:'exact',mailUrl:C.mailLink('9000000000000000347','500000')},
    {id:'2;0;1',name:'same.pdf',bytes:0,sizeSource:'display',mailUrl:''}
  ]);
  const blob = X.create(rows, {Состояние:'Тест'}, [{time:'2025-01-01',level:'info',event:'test',data:{count:2}}]);
  const output = path.join(__dirname,'output'); fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'test.xlsx'),Buffer.from(await blob.arrayBuffer()));
  console.log('Core parsing, exact ID links, sorting, merge and workbook creation: PASS');
})();
