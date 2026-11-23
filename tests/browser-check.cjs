// Headless Chrome integration checks. No mail session or network requests required.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {spawn} = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const chrome = process.env.CHROME_PATH || (process.platform === 'win32'
  ? path.join(process.env.PROGRAMFILES || 'C:/Program Files','Google','Chrome','Application','chrome.exe')
  : process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const delay = ms => new Promise(r=>setTimeout(r,ms));
const harness = `<!doctype html><meta charset="utf-8"><style>#outer{height:320px;overflow:auto}#list{height:360px;width:900px;overflow:hidden;position:relative}.row{position:absolute;height:40px;display:block;width:100%}</style>
<div role="tablist"><a href="#all" role="tab" aria-selected="true">All</a></div><div id="outer"><div id="list" class="VirtualList-new__list--fixture" data-qa-datalist="attaches"><div id="space"></div></div></div>
<script>
const listeners=[];let offscreen=false;
window.exportsByName={};
window.chrome={
 runtime:{getManifest:()=>({version:"1.0.3"}),getURL:path=>path,getContexts:async()=>offscreen?[{}]:[],onMessage:{addListener:f=>listeners.push(f)},sendMessage:message=>new Promise(resolve=>{
  const sender=message.type==='MAIL_ATTACHMENTS_BLOB'?{}:{tab:{id:99},frameId:5,url:'https://cloud.mail.ru/attaches#all'};
  let pending=false;for(const listener of listeners)pending=listener(message,sender,resolve)===true||pending;
  if(!pending)resolve(undefined);
 })},
 offscreen:{createDocument:async()=>{offscreen=true}},
 downloads:{download:async({url,filename})=>{window.exportsByName[filename]=await(await fetch(url)).blob();return 1}},
 tabs:{onRemoved:{addListener(){}}},
 storage:{local:{set:async x=>Object.assign(window.saved,x),get:async key=>({[key]:window.saved[key]}),remove:async key=>delete window.saved[key]}}
};window.saved={};
const attach=Element.prototype.attachShadow;Element.prototype.attachShadow=function(o){const x=attach.call(this,o);window.panel=x;return x};
window.total=70;window.full=140;window.lazy=false;window.renderTimer=0;window.renderVersion=0;
const list=document.querySelector('#list'),space=document.querySelector('#space');
const nativeTop=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');
window.reactScrollCalls=0;
list.__reactFiber$test={return:{stateNode:{
 _outerRef:list,state:{scrollOffset:0},
 scrollTo(offset){window.reactScrollCalls++;this.state.scrollOffset=offset;nativeTop.set.call(list,offset)}
 }}};
window.lockDomScroll=()=>{list.scrollTo=()=>{};Object.defineProperty(list,'scrollTop',{get(){return nativeTop.get.call(this)},set(){}})};
function draw(){
 space.style.height=total*40+'px';space.replaceChildren();
 const start=Math.max(0,Math.floor(list.scrollTop/40)-2),end=Math.min(total,start+15);
 for(let i=start;i<end;i++){
  const row=document.createElement('a');row.className='row';row.style.top=i*40+'px';row.setAttribute('data-qa-type','file');
  const message=(9000000000000000000n+BigInt(i)).toString(),id=message+';0;1';row.setAttribute('data-id',id);row.setAttribute('data-qa-name','Одинаковое имя.pdf');
  row.innerHTML='<div class="Destination__root"><div data-qa-id="author"><img alt="sender@example.test"></div><div class="Destination__nameMargin">Тема '+i+'</div></div><div data-qa-id="date">01.01.25</div><div class="Size__size">1 КБ</div>';
  const item={id,message_id:message,folderId:i%2?500000:0,size:{original:(i+1)*1000},authorName:'Тестовый отправитель',authorEmail:'sender@example.test',subject:'Тема '+i};
  row.__reactFiber$test={memoizedProps:{},return:{memoizedProps:{item},return:null}};space.append(row);
 }window.renderVersion++;
}
list.addEventListener('scroll',()=>{
 clearTimeout(window.renderTimer);window.renderTimer=setTimeout(draw,120);
 if(list.scrollTop+list.clientHeight>=total*40-3&&!lazy){lazy=true;setTimeout(()=>{window.total=140;draw()},250)}
});draw();
</script><script src="/background.js"></script><script src="/download.js"></script><script src="/core.js"></script><script src="/xlsx.js"></script><script src="/bridge.js"></script><script src="/collector.js"></script>`;

(async()=>{
 const watchdog=setTimeout(()=>{console.error('Browser check timed out');process.exit(1)},60000);
 const server=http.createServer((req,res)=>{
  res.setHeader('Content-Type','text/html;charset=utf-8');
  if(req.url.startsWith('/attaches'))return res.end(harness);
  if(['/core.js','/xlsx.js','/bridge.js','/collector.js','/background.js','/download.js'].includes(req.url)){
   res.setHeader('Content-Type','text/javascript;charset=utf-8');
   let s=fs.readFileSync(path.join(root,'extension',req.url.slice(1)),'utf8');
   if(req.url==='/collector.js')s=s.replace('stepDelay: 180','stepDelay: 40').replace('endWait: 20000','endWait: 500').replace('sleep(1200)','sleep(200)');
   return res.end(s);
  }res.statusCode=404;res.end();
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const port=server.address().port,profile=fs.mkdtempSync(path.join(os.tmpdir(),'mail-export-check-'));
 const child=spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--disable-extensions','--disable-background-networking','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
 let socket;
 try{
  let debug='';child.stderr.on('data',x=>debug+=x);child.on('exit',code=>console.log('Test Chrome exited:',code));
  for(let i=0;i<100&&!/DevTools listening on (ws:\/\/\S+)/.test(debug);i++)await delay(100);
  const match=debug.match(/DevTools listening on (ws:\/\/\S+)/);if(!match)throw Error('Chrome debugging endpoint unavailable: '+debug);
  console.log('Chrome debugging ready');
  const endpoint=new URL(match[1]),targets=await(await fetch('http://'+endpoint.host+'/json/list')).json();
  socket=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});
  let seq=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const{resolve,reject}=pending.get(m.id);pending.delete(m.id);m.error?reject(Error(m.error.message)):resolve(m.result)}};
  const cdp=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
  const evaluate=async expression=>{const v=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(v.exceptionDetails)throw Error(JSON.stringify(v.exceptionDetails));return v.result.value};
  console.log('CDP connected');
  await cdp('Page.navigate',{url:'http://127.0.0.1:'+port+'/attaches?email=test%40example.test#all'});
  for(let i=0;i<100&&!await evaluate('Boolean(window.panel)');i++)await delay(50);
  console.log('Fixture mounted');
  const wheel=await evaluate(`(()=>{const list=document.querySelector('#list');list.firstChild.dispatchEvent(new WheelEvent('wheel',{deltaY:720,bubbles:true,cancelable:true}));return [list.scrollTop,document.querySelector('#outer').scrollTop]})()`);
  assert.deepEqual(wheel,[720,0]);
  await evaluate('lockDomScroll();panel.querySelector("#start").click()');
  let status='';for(let i=0;i<600;i++){
   await delay(50);status=await evaluate('panel.querySelector("#status").textContent');
   if(status.includes('Конец списка достигнут')||status.includes('Ошибка'))break;
  }
  if(!/Конец списка достигнут.*140/.test(status))console.log('Failure details',await evaluate(`JSON.stringify({missing:Array.from({length:140},(_,i)=>i).filter(i=>!Object.values(saved)[0]?.rows.some(r=>r.id===(9000000000000000000n+BigInt(i)).toString()+';0;1')),logs:Object.values(saved)[0]?.logs.slice(-20),top:document.querySelector('#list').scrollTop,height:document.querySelector('#list').scrollHeight})`));
  assert.match(status,/Конец списка достигнут.*140/,'Full collection: '+status+' '+await evaluate('panel.querySelector("#notice").textContent'));
  const snapshot=await evaluate('Object.values(saved)[0]');
  assert(await evaluate('reactScrollCalls') > 10);
  assert(snapshot.logs.some(x=>x.event==='scroll_step'&&x.data.method==='React'&&x.data.actual>x.data.from));
  assert.equal(snapshot.rows.length,140);assert.equal(new Set(snapshot.rows.map(x=>x.id)).size,140);
  assert(snapshot.rows.every(r=>r.authorName==='Тестовый отправитель'&&r.sizeSource==='exact'&&r.mailUrl));
  assert.equal(snapshot.rows[0].messageId,'9000000000000000000');
  await evaluate('panel.querySelector("#excel").click();panel.querySelector("#logs").click()');
  for(let i=0;i<100&&await evaluate('Object.keys(exportsByName).length')<2;i++)await delay(50);
  const data=await evaluate('(async()=>Array.from(new Uint8Array(await Object.entries(exportsByName).find(([name])=>name.endsWith(".xlsx"))[1].arrayBuffer())))()');
  assert.equal(await evaluate('(async()=>JSON.parse(await exportsByName["mail-attachments-log.json"].text()).info["Собрано вложений"])()'),140);
  const diagnostic=await evaluate('exportsByName["mail-attachments-log.json"].text()');
  assert.doesNotMatch(diagnostic,/sender@example\.test|Тестовый отправитель|Одинаковое имя|9000000000000000000/);
  fs.mkdirSync(path.join(__dirname,'output'),{recursive:true});fs.writeFileSync(path.join(__dirname,'output/browser.xlsx'),Buffer.from(data));
  // A second pass must preserve all distinct IDs and enrich rather than duplicate rows.
  await evaluate('panel.querySelector("#resume").click()');
  for(let i=0;i<600;i++){await delay(50);status=await evaluate('panel.querySelector("#status").textContent');if(status.includes('Конец списка достигнут')||status.includes('Ошибка'))break}
  assert.match(status,/Конец списка достигнут.*140/);assert.equal((await evaluate('Object.values(saved)[0]')).rows.length,140);
  console.log('Headless Chrome: delayed virtual rendering, lazy loading 70→140, exact metadata, distinct same-name files, restart deduplication, Excel export: PASS');
  await evaluate(`(()=>{
    const old=document.querySelector('#list'),fresh=old.cloneNode(false);
    fresh.className='plain-scroll-list';fresh.style.overflow='auto';
    for(let i=0;i<48;i++){
      const row=document.createElement('a');
      row.dataset.qaType='file';row.dataset.id='synthetic-'+i;row.dataset.qaName='fixture-'+i+'.pdf';
      row.style.cssText='display:block;height:40px;overflow:hidden';
      row.innerHTML='<div data-qa-id="author"><img alt="sender@example.test"></div><div class="Size__size">1,5 МБ</div><div data-qa-id="date">01.01.25</div>';
      fresh.append(row);
    }
    old.replaceWith(fresh);panel.querySelector('#start').click();
  })()`);
  for(let i=0;i<600;i++){await delay(50);status=await evaluate('panel.querySelector("#status").textContent');if(status.includes('Конец списка достигнут')||status.includes('Ошибка'))break}
  assert.match(status,/Конец списка достигнут.*48/);
  const fallback=await evaluate('Object.values(saved)[0]');assert.equal(fallback.rows.length,48);
  assert(fallback.rows.every(r=>r.name&&r.bytes!==null&&r.sizeSource==='display'&&!r.mailUrl));
  assert(fallback.rows.some(r=>r.authorEmail));
  console.log('Synthetic DOM fallback: all 48 rows parsed, names/sizes/dates/author email, explicit approximate sizes and missing links in DOM fallback: PASS');
 }finally{clearTimeout(watchdog);socket?.close();child.kill();server.closeAllConnections();server.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
