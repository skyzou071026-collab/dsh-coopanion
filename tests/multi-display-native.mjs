import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { _electron } from 'playwright-core';
import { petClick, nativeClick } from './helpers/native-pointer.mjs';
import { sampleNativeDisplay } from './helpers/multi-display-native.mjs';
const require=createRequire(import.meta.url), root=await mkdtemp(join(tmpdir(),'dsh-m5-native-'));
let app;
try {
  app=await _electron.launch({executablePath:require('electron'),args:['--no-sandbox',resolve('desktop/main.cjs')],env:{...process.env,DSH_PET_TEST_DATA_DIR:root,DSH_PET_TEST_NO_SANDBOX:'1',DSH_PET_TEST_DEBUG_PORT:'0'}});
  await mkdir('artifacts',{recursive:true});
  const page=await app.firstWindow();
  const snapshot={mood:'idle',sessionId:'m5-native',results:[{id:'m5-reader',sessionId:'m5-native',time:1,read:false,text:'## Native controlled layouts\n\n'+'原生工作区中的捕获正文。\n\n'.repeat(80)}],sessions:[{id:'m5-native',label:'M5 native session',mood:'idle',chatAvailable:true}]};
  await app.evaluate((_,snapshot)=>process.emit('message',{type:'init',baseline:true,options:{size:90,textScale:1.5,roam:false,notifications:true,bubbleDurationMs:12000},snapshot}),snapshot);
  await page.waitForSelector('#pet[data-display-revision][data-mode]');
  await petClick(page,{},true); await page.locator('#message').fill('native M5 stable draft');
  const actual=await sampleNativeDisplay(page);
  await page.keyboard.press('Escape'); await page.locator('#attention').click();
  await page.locator('#reader-text').evaluate(n=>{n.scrollTop=100;window.m5NativeReader=n.firstChild;});
  const html=await page.locator('#reader-text').innerHTML();
  // Inject only the screen adapter; real BrowserWindow bounds, Chromium layout,
  // sandbox frame and OS input remain active. These are subsets of one real monitor.
  const controlled=await app.evaluate(({screen})=>{
    const original={all:screen.getAllDisplays,primary:screen.getPrimaryDisplay,cursor:screen.getCursorScreenPoint};
    const real=screen.getPrimaryDisplay(), b=real.workArea;
    const width=Math.min(620,Math.floor(b.width*.48)),height=Math.min(760,b.height);
    const a={...real,id:91001,label:'Controlled left',workArea:{x:b.x,y:b.y,width,height},scaleFactor:1};
    const z={...real,id:91002,label:'Controlled right',workArea:{x:b.x+b.width-width,y:b.y+Math.max(0,b.height-height),width,height},scaleFactor:1.5};
    globalThis.m5Screen={original,real,layout:[a,z],cursor:{x:a.workArea.x+50,y:a.workArea.y+50}};
    screen.getAllDisplays=()=>globalThis.m5Screen.layout;screen.getPrimaryDisplay=()=>globalThis.m5Screen.layout[0];screen.getCursorScreenPoint=()=>globalThis.m5Screen.cursor;
    screen.emit('display-added',{},a); return [a,z];
  });
  const samples=[];
  await page.evaluate(()=>window.dshPetBridge.action({type:'hide'}));
  await page.waitForTimeout(100);
  assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  for(const id of [91001,91002]) {
    await app.evaluate(({screen},id)=>{const d=globalThis.m5Screen.layout.find(d=>d.id===id);globalThis.m5Screen.cursor={x:d.workArea.x+50,y:d.workArea.y+50};},id);
    await page.evaluate(()=>window.dshPetBridge.action({type:'move-display'}));
    await page.waitForSelector(`#pet[data-display-id="${id}"]`);
    if(id===91001) {
      assert.equal(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false,'hidden display switch does not show the window');
      await app.evaluate(()=>process.emit('message',{type:'control',command:'show'}));
    }
    await page.waitForFunction(()=>{const b=document.querySelector('#reader').getBoundingClientRect();return b.x>=0&&b.y>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;});
    assert.equal(await page.locator('#reader-text').innerHTML(),html);assert.equal(await page.locator('#reader-text').evaluate(n=>n.scrollTop),100);
    assert.equal(await page.locator('#reader-text').evaluate(n=>n.firstChild===window.m5NativeReader),true);
    // Restore actual cursor querying for OS-input samples; selection retains the chosen ID.
    await app.evaluate(({screen})=>screen.getCursorScreenPoint=globalThis.m5Screen.original.cursor);
    samples.push({displayId:id,...await sampleNativeDisplay(page,'#reader-text')});
    await app.evaluate(({screen})=>screen.getCursorScreenPoint=()=>globalThis.m5Screen.cursor);
  }
  await app.evaluate(({screen})=>{const d=globalThis.m5Screen.layout[1];d.workArea={...d.workArea,width:d.workArea.width-70,height:d.workArea.height-80};d.scaleFactor=2;d.rotation=90;screen.emit('display-metrics-changed',{},d,['workArea','scaleFactor','rotation']);screen.getCursorScreenPoint=globalThis.m5Screen.original.cursor;});
  await page.waitForFunction(width=>innerWidth===width,controlled[1].workArea.width-70);
  assert.equal(await page.locator('#reader-text').evaluate(n=>n.scrollTop),100);
  samples.push({metricsChanged:true,...await sampleNativeDisplay(page,'#reader-text')});
  await app.evaluate(({screen})=>{globalThis.m5Screen.layout=globalThis.m5Screen.layout.filter(d=>d.id!==91002);screen.emit('display-removed',{},{});screen.getCursorScreenPoint=globalThis.m5Screen.original.cursor;});
  await page.waitForSelector('#pet[data-display-id="91001"]');
  await page.waitForFunction(()=>{const b=document.querySelector('#reader').getBoundingClientRect();return b.right<=innerWidth&&b.bottom<=innerHeight;});
  assert.equal(await page.locator('#reader-text').evaluate(n=>n.scrollTop),100);
  await nativeClick(page,'#reader-close'); await petClick(page,{},true);assert.equal(await page.locator('#message').inputValue(),'native M5 stable draft');
  await page.keyboard.press('Escape');
  await app.evaluate(({screen},controlled)=>{
    const s=globalThis.m5Screen;s.layout=controlled;const d=s.layout[1];s.cursor={x:d.workArea.x+50,y:d.workArea.y+50};
    screen.getCursorScreenPoint=()=>s.cursor;screen.emit('display-added',{},d);
  },controlled);
  await page.evaluate(()=>window.dshPetBridge.action({type:'move-display'}));
  await page.waitForSelector('#pet[data-display-id="91002"]');
  await app.evaluate(({screen})=>screen.getCursorScreenPoint=globalThis.m5Screen.original.cursor);
  await page.waitForFunction(()=>!['air','drag','crouch'].includes(document.querySelector('#pet').dataset.mode));
  await petClick(page);await page.locator('#pet').hover();await page.mouse.down();
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight}));
  await page.mouse.move(viewport.width-25,viewport.height*.4,{steps:12});await page.waitForSelector('#pet[data-mode=drag]');
  await page.evaluate(()=>{window.m5DropEvents=[];window.addEventListener('message',e=>{if(e.source===document.querySelector('#body-layer iframe')?.contentWindow&&e.data?.t==='frame')for(const item of e.data.events??[])if(item.kind==='touch')window.m5DropEvents.push(item.detail.kind);});});
  await app.evaluate(({screen})=>{globalThis.m5Screen.layout=globalThis.m5Screen.layout.slice(0,1);screen.emit('display-removed',{},{});});
  await page.waitForSelector('#pet[data-display-id="91001"]');
  await page.waitForFunction(()=>{const n=document.querySelector('#pet'),b=n.getBoundingClientRect();return n.dataset.pressing==='false'&&b.width>20&&b.x>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;});
  await page.mouse.up();
  await page.waitForFunction(()=>window.m5DropEvents.includes('drop'));
  assert.equal(await page.evaluate(()=>window.m5DropEvents.includes('throw')),false);
  await page.waitForFunction(()=>!['air','drag'].includes(document.querySelector('#pet').dataset.mode));
  await petClick(page,{},true);assert.equal(await page.locator('#message').inputValue(),'native M5 stable draft');
  const restored=await app.evaluate(({screen})=>{const s=globalThis.m5Screen;screen.getAllDisplays=s.original.all;screen.getPrimaryDisplay=s.original.primary;screen.getCursorScreenPoint=s.original.cursor;screen.emit('display-metrics-changed',{},s.real,['workArea']);return s.real;});
  await page.waitForSelector(`#pet[data-display-id="${restored.id}"]`); await page.screenshot({path:'artifacts/multi-display-native.png'});
  await mkdir('artifacts',{recursive:true});
  await writeFile('artifacts/multi-display-native.json',JSON.stringify({sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),platform:process.platform,arch:process.arch,actual,controlled,controlledNativeSubsets:true,physicalMultiDisplay:false,physicalMixedDpi:false,samples,unplugRecovered:true,readerDom:true,scrollRetained:true,draftRetained:true,hiddenMoveNoFlash:true,unplugDuringDrag:true,api2DropWithoutThrow:true},null,2)+'\n');
  console.log('M5 native screen measurements, controlled work areas, unplug recovery and real OS cursor/CDP clicks passed.');
} finally {await app?.close();await rm(root,{recursive:true,force:true});}
