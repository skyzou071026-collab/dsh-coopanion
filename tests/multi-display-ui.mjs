import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { previewServer } from '../scripts/preview.mjs';
import { controlNpc, npcUntil } from './helpers/npc-life.mjs';
let directory, server, browser;
before(async () => {
  directory = await mkdtemp(join(tmpdir(),'dsh-display-ui-'));
  server = previewServer({dataDir:directory}); server.listen(0,'127.0.0.1'); await once(server,'listening');
  browser = await chromium.launch({executablePath:process.env.CHROMIUM_PATH ?? (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : chromium.executablePath()),headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader']});
  await mkdir('artifacts',{recursive:true});
});
after(async () => { await browser?.close(); if(server) await new Promise(r=>server.close(r)); if(directory) await rm(directory,{recursive:true,force:true}); });
const cases = [
  {displayId:1,contentBounds:{x:0,y:25,width:980,height:720},scaleFactor:2},
  {displayId:2,contentBounds:{x:-420,y:-500,width:420,height:900},scaleFactor:1},
  {displayId:3,contentBounds:{x:160,y:-640,width:740,height:600},scaleFactor:1.5},
  {displayId:3,contentBounds:{x:160,y:-640,width:520,height:720},scaleFactor:2},
  {displayId:1,contentBounds:{x:0,y:25,width:980,height:680},scaleFactor:2},
];
test('native NPC requests missing and stale geometry and resumes without restarting its character', async t => {
  const page = await browser.newPage({ viewport: { width: 980, height: 720 } }); t.after(() => page.close());
  await controlNpc(page);
  await page.addInitScript(() => {
    window.geometryRequests = 0;
    window.dshPetBridge = {
      nativeGeometry: true,
      subscribe(fn) { window.displayReceive = fn; }, action() {}, hit() {},
      requestGeometry() {
        window.geometryRequests++;
        if (!window.geometryAvailable) return;
        const bounds = { x: -420, y: 25, width: innerWidth, height: innerHeight };
        window.displayReceive({ type: 'display-changed', displayId: 2, revision: ++window.geometryRevision, contentBounds: bounds, workArea: bounds, scaleFactor: 1.25 });
      },
    };
    window.geometryRevision = 0;
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForSelector('#pet[data-mode]');
  await page.evaluate(() => {
    window.originalBody = document.querySelector('#body-layer iframe');
    window.displayReceive({ type: 'init', options: { companionship: 'quiet', roam: true }, snapshot: { mood: 'idle', active: false, sessions: [], results: [] } });
  });
  await page.waitForSelector('#pet[data-npc-reason=geometry]');
  await page.evaluate(() => { window.geometryAvailable = true; });
  await page.waitForFunction(() => window.geometryRequests > 0, null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector('#pet').dataset.npcReason !== 'geometry', null, { timeout: 5000 });
  await npcUntil(page, 'outbound');
  await page.evaluate(() => {
    // Hold the reply until the paused state is observed. A correct, fast heal
    // must not make an external poll miss the transient geometry state.
    window.geometryAvailable = false;
    window.displayReceive({ type: 'display-changed', displayId: 2, revision: ++window.geometryRevision, contentBounds: { x: -420, y: 25, width: 980, height: 768 }, workArea: { x: -420, y: 25, width: 980, height: 720 }, scaleFactor: 1.25 });
  });
  await page.waitForSelector('#pet[data-npc-reason=geometry]');
  const requests = await page.evaluate(() => window.geometryRequests);
  await page.evaluate(() => { window.geometryAvailable = true; });
  await page.waitForFunction(n => window.geometryRequests > n && document.querySelector('#pet').dataset.npcReason !== 'geometry', requests, { timeout: 5000 });
  await npcUntil(page, 'outbound');
  assert.equal(await page.evaluate(() => document.querySelector('#body-layer iframe') === window.originalBody), true);
});
test('controlled irregular layout and mixed DPR preserve reading, draft, in-flight identity and hit areas', async t => {
  const page = await browser.newPage({viewport:{width:980,height:720},reducedMotion:'reduce'}); t.after(()=>page.close());
  const errors=[]; page.on('pageerror',e=>errors.push(e.message)); t.after(()=>assert.deepEqual(errors,[]));
  await page.addInitScript(()=>{window.displayActions=[];window.displayHits=[];window.m5DropEvents=[];window.addEventListener('message',e=>{if(e.source===document.querySelector('#body-layer iframe')?.contentWindow&&e.data?.t==='frame')for(const item of e.data.events??[])if(item.kind==='touch')window.m5DropEvents.push(item.detail.kind);});window.dshPetBridge={subscribe(fn){window.displayReceive=fn;},action(a){window.displayActions.push(a);},hit(b){window.displayHits.push(b);}};});
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.waitForSelector('#pet[data-mode]');
  const receive=m=>page.evaluate(m=>window.displayReceive(m),m);
  const reply={id:'m5-full-result',sessionId:'m5-session',time:1,read:false,text:'## M5 captured reply\n\n'+'捕获阅读与多屏。 Stable reader across displays.\n\n'.repeat(60)};
  await receive({type:'init',baseline:true,options:{size:90,textScale:1.5,roam:false},snapshot:{mood:'idle',sessionId:reply.sessionId,results:[reply],sessions:[{id:reply.sessionId,label:'M5 full session',mood:'idle',chatAvailable:true,replyId:reply.id,reply:reply.text,unread:1}]}});
  await receive({type:'ui-control',command:'chat'}); await page.locator('#message').fill('M5 retained draft');
  await page.keyboard.press('Escape'); await page.locator('#attention').click(); await page.locator('#reader').waitFor({state:'visible'});
  await page.locator('#reader-text').evaluate(n=>{n.scrollTop=120;window.m5Captured=n.firstChild;window.m5Frame=document.querySelector('#body-layer iframe');});
  const html=await page.locator('#reader-text').innerHTML(), actions=await page.evaluate(()=>window.displayActions);
  const cdp=await page.context().newCDPSession(page), samples=[];
  let revision=0;
  for(const c of cases) {
    // Both event orders occur on native platforms. The DPR values here are controlled Chromium emulation.
    const message={type:'display-changed',...c,revision:++revision,workArea:c.contentBounds};
    if(revision%2) await receive(message);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:c.contentBounds.width,height:c.contentBounds.height,deviceScaleFactor:c.scaleFactor,mobile:false});
    if(!(revision%2)) await receive(message);
    await page.waitForFunction(()=>{const r=document.querySelector('#reader').getBoundingClientRect();return r.x>=0&&r.y>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;});
    assert.equal(await page.locator('#reader-text').innerHTML(),html);
    assert.equal(await page.locator('#reader-text').evaluate(n=>n.firstChild===window.m5Captured),true);
    assert.equal(await page.evaluate(()=>document.querySelector('#body-layer iframe')===window.m5Frame),true,'same sandbox frame survives geometry updates');
    assert.equal(await page.locator('#reader-text').evaluate(n=>n.scrollTop),120);
    const hits=await page.evaluate(revision=>{
      window.displayReceive({type:'cursor',x:-100,y:-100,revision});
      const b=document.querySelector('#reader-close').getBoundingClientRect();
      window.displayReceive({type:'cursor',x:b.x+b.width/2,y:b.y+b.height/2,revision});
      const current=window.displayHits.at(-1);
      window.displayReceive({type:'cursor',x:-100,y:-100,revision:revision-1});
      return {current,afterStale:window.displayHits.at(-1)};
    },revision);
    assert.equal(hits.current,true,'scaled button uses viewport CSS hit region');
    assert.equal(hits.afterStale,true,'stale cursor cannot clear current hit');
    await receive({...message,revision:revision-1,displayId:999});
    assert.equal(await page.locator('#pet').getAttribute('data-display-id'),String(c.displayId));
    const pet=await page.locator('#pet').boundingBox();
    await page.waitForFunction(()=>{const b=document.querySelector('#pet').getBoundingClientRect();return b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;});
    samples.push({...c,revision,dpr:await page.evaluate(()=>devicePixelRatio),reader:await page.locator('#reader').boundingBox(),pet});
  }
  assert.deepEqual(await page.evaluate(()=>window.displayActions),actions,'geometry does not read/select/chat');
  await page.screenshot({path:'artifacts/multi-display-reader.png'});
  await page.keyboard.press('Escape'); await receive({type:'ui-control',command:'chat'});
  assert.equal(await page.locator('#message').inputValue(),'M5 retained draft');
  await page.locator('#message').evaluate(n=>n.setSelectionRange(3,9));
  const last={type:'display-changed',...cases[4],workArea:cases[4].contentBounds,revision:++revision}; await receive(last);
  assert.deepEqual(await page.locator('#message').evaluate(n=>[n.selectionStart,n.selectionEnd,n===document.activeElement]),[3,9,true]);
  await page.locator('#message').press('Control+Enter');
  const sent=await page.evaluate(()=>window.displayActions.filter(a=>a.type==='chat'));
  await receive({...last,revision:++revision,scaleFactor:1});
  assert.deepEqual(await page.evaluate(()=>window.displayActions.filter(a=>a.type==='chat')),sent);
  await receive({type:'chat-result',sessionId:sent[0].sessionId,requestId:sent[0].requestId,status:'accepted'});
  assert.equal(await page.locator('#message').inputValue(),'');
  await page.keyboard.press('Escape');
  const b=await page.locator('#pet').boundingBox(); await page.mouse.move(b.x+b.width/2,b.y+b.height/2); await page.mouse.down();
  await page.mouse.move(b.x+b.width/2,-180,{steps:8}); await page.mouse.up();
  assert.ok((await page.evaluate(()=>window.displayActions)).some(a=>a.type==='move-display'),'vertical release requests native display selection');
  await page.waitForFunction(()=>!['air','drag','crouch'].includes(document.querySelector('#pet').dataset.mode));
  await page.locator('#pet').hover(); await page.mouse.down();
  await page.mouse.move(920,280,{steps:12}); await page.waitForSelector('#pet[data-mode=drag]');
  await page.evaluate(()=>window.m5DropEvents=[]);
  await cdp.send('Emulation.setDeviceMetricsOverride',{width:420,height:640,deviceScaleFactor:1,mobile:false});
  await receive({type:'display-changed',...cases[1],contentBounds:{x:-420,y:25,width:420,height:640},revision:++revision});
  await page.waitForFunction(()=>{const n=document.querySelector('#pet'),b=n.getBoundingClientRect();return n.dataset.pressing==='false'&&b.width>20&&b.x>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;});
  await page.mouse.up();
  await page.waitForFunction(()=>window.m5DropEvents.includes('drop'));
  assert.equal(await page.evaluate(()=>window.m5DropEvents.includes('throw')),false,'layout recovery drops without generating a throw');
  await page.waitForFunction(()=>!['air','drag'].includes(document.querySelector('#pet').dataset.mode));
  await writeFile('artifacts/multi-display-ui.json',JSON.stringify({controlled:true,physicalMultiDisplay:false,samples,readerDom:true,scrollRetained:true,draftRetained:true,inflightRetained:true,staleGeometryRejected:true,verticalDrag:true,unplugDuringDrag:true},null,2)+'\n');
});
