const { app, BrowserWindow, ipcMain, powerMonitor, screen, Menu, Tray, nativeImage, shell } = require('electron');
const { join } = require('node:path');
const { homedir } = require('node:os');
const { readFileSync } = require('node:fs');
const { Diagnostics } = require('../dist/diagnostics.cjs');
const { z } = require('zod');
const diagnosticCount = z.number().int().min(0).max(1000000000);
const diagnosticCounts = z.object({ routines: z.object({ observe: diagnosticCount, play: diagnosticCount, rest: diagnosticCount, greeting: diagnosticCount }).strict(), invitationsShown: diagnosticCount, invitationsExpired: diagnosticCount, invitationsAccepted: diagnosticCount, invitationsLater: diagnosticCount, invitationsQuiet: diagnosticCount }).strict();
const diagnosticRenderer = z.object({ npc: z.object({ phase: z.enum(['home', 'prepare', 'outbound', 'observe', 'return', 'yield', 'resume']), reason: z.enum(['none', 'disabled', 'input', 'unknown', 'pointer', 'work', 'user', 'lifecycle', 'geometry', 'capability']), keyboard: z.enum(['active', 'idle', 'unknown']), keyboardBackend: z.enum(['macos', 'windows', 'x11', 'none']).optional(), keyboardStatus: z.enum(['disabled', 'starting', 'available', 'unsupported-platform', 'unsupported-session', 'missing-dependency', 'failed', 'stale', 'unavailable', 'protocol-error']).optional(), targetValid: z.boolean(), compact: z.boolean() }).strict().optional(), mode: z.enum(['off', 'quiet', 'interactive']), activity: z.enum(['idle', 'observe', 'play', 'rest', 'greeting']), invitation: z.enum(['none', 'pending', 'shown']), mood: z.string().regex(/^[a-z-]{1,24}$/), careUnavailable: z.boolean(), hidden: z.boolean(), hour: z.number().int().min(0).max(23), queues: z.object({ carePending: diagnosticCount, pendingInteractions: diagnosticCount, composerSessions: diagnosticCount, chatTimers: diagnosticCount, snoozing: diagnosticCount, shownResults: diagnosticCount, acknowledgedResults: diagnosticCount }).strict(), counts: diagnosticCounts, heapBytes: z.number().min(0).max(Number.MAX_SAFE_INTEGER), nodes: diagnosticCount }).strict();
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { CompanionStore, companionRequest } = require('../dist/companion-store.cjs');
const { CharacterStore } = require('../dist/character-store.cjs');
const { createPetServer } = require('../dist/figure-server.cjs');
const { trayState, trayLocale } = require('./tray-state.cjs');
const { createDisplayController } = require('./display-controller.cjs');
const { installAlwaysOnTop } = require('./always-on-top.cjs');
const { petCopy, petLanguage } = require('../web/locale.js');
app.setName(petCopy('en').defaultName);
if (process.env.DSH_PET_TEST_DATA_DIR) {
  app.setPath('userData', process.env.DSH_PET_TEST_DATA_DIR);
  app.setPath('crashDumps', join(process.env.DSH_PET_TEST_DATA_DIR, 'crashes'));
}
if (process.platform === 'win32') app.setAppUserModelId('dev.takboo.dsh-coopanion');

// Used only by the virtual-display test; normal installations retain Chromium's sandbox.
if (process.env.DSH_PET_TEST_NO_SANDBOX === '1') {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
}
if (process.env.DSH_PET_TEST_DEBUG_PORT) {
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  app.commandLine.appendSwitch('remote-debugging-port', process.env.DSH_PET_TEST_DEBUG_PORT);
}
const displayTest = process.env.DSH_PET_TEST_NO_SANDBOX === '1' && !!process.env.DSH_PET_TEST_DEBUG_PORT;
const keyboardActivity = require('./keyboard-activity.cjs').createKeyboardActivity();
const { initialLockState } = require('./lifecycle-state.cjs');
let win, tray, options, lastFrame, poll, assetServer, characters, companions, displays, diagnostics, diagnosticRead, disposeAlwaysOnTop;
let lifecycle = { locks: 0, unlocks: 0, suspends: 0, resumes: 0 };
const configureDiagnostics = () => {
  if (options?.diagnostics !== true) {
    lifecycle = { locks: 0, unlocks: 0, suspends: 0, resumes: 0 };
    if (diagnosticRead) { clearTimeout(diagnosticRead.timer); diagnosticRead.resolve(null); diagnosticRead = undefined; }
  }
  void diagnostics?.configure(options?.diagnostics === true).catch(() => console.error('Local diagnostics unavailable'));
};
function readRendererDiagnostics() {
  if (options?.diagnostics !== true || !win || win.isDestroyed() || diagnosticRead) return Promise.resolve(null);
  return new Promise(resolve => {
    const requestId = randomBytes(16).toString('hex');
    const timer = setTimeout(() => { if (diagnosticRead?.requestId === requestId) { diagnosticRead = undefined; resolve(null); } }, 1200);
    diagnosticRead = { requestId, resolve, timer }; forward({ type: 'diagnostics-read', requestId });
  });
}
let presentation = {}, lastTrayKey, lastIconKey, iconBase, iconAppearance;
let interactive = null;
const generation = Number(process.env.DSH_PET_GENERATION ?? 1);
let visibilityRevision = 0, screenLocked = process.env.DSH_PET_SCREEN_LOCKED === '1', systemAsleep = process.env.DSH_PET_SYSTEM_ASLEEP === '1';
let lockStateKnown = false;
let suspended = true;
let desiredVisible = process.env.DSH_PET_VISIBLE !== '0', userClosed = false;
function visibility() { if (win && !win.isDestroyed()) { process.send?.({ type: 'visibility', generation, visibilityRevision: ++visibilityRevision, visible: win.isVisible(), desiredVisible, suspended, screenLocked, systemAsleep, lockStateKnown }); syncTray(); } }
function forward(message) { if (win && !win.isDestroyed()) win.webContents.send('pet:update', message); }
function hit(active) {
  if (!win || win.isDestroyed()) return;
  if (active !== interactive) {
    interactive = active;
    win.setIgnoreMouseEvents(!active, { forward: true });
  }
  forward({ type: 'hit-state', active, focused: win.isFocused(), visible: win.isVisible() });
}
function show() { desiredVisible = true; win?.showInactive(); visibility(); }
function hide() { desiredVisible = false; win?.hide(); visibility(); }
function act(action) { process.send?.({ type: 'action', action }); }
function syncTray() {
  if (!tray || tray.isDestroyed()) return;
  const locale = trayLocale(options, presentation, app.getPreferredSystemLanguages());
  const state = trayState(lastFrame?.snapshot, presentation, { ...options, locale }, win?.isVisible());
  const copy = petCopy(locale);
  if (app.getName() !== copy.defaultName) app.setName(copy.defaultName);
  const displayList = screen.getAllDisplays();
  const key = JSON.stringify([state, displays?.state?.displayId, displayList.map(d => [d.id, d.label])]);
  if (key === lastTrayKey) return;
  lastTrayKey = key;
  tray.setToolTip(state.tooltip);
  if (process.platform === 'darwin') tray.setTitle(state.title);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: `${state.name} · ${state.stateLabel}`, enabled: false },
    { label: state.sessionLabel, enabled: false },
    { label: copy.trayOpen, enabled: !!state.sessionId, click: () => act({ type: 'open-session', sessionId: state.sessionId }) },
    { label: copy.traySwitch, enabled: !!state.sessions.length, submenu: state.sessions.slice(0, 20).map(session => ({ type: 'radio', label: `${session.label} · ${session.id.replace(/^session[-_:]/, '').slice(-8)}${session.unread ? copy.trayUnread(session.unread) : ''}${['waiting', 'error'].includes(session.mood) ? copy.trayNeeds : ''}`, checked: session.selected, click: () => act({ type: 'select', sessionId: session.id }) })) },
    { label: copy.trayPending(state.activity.unread, state.activity.waiting + state.activity.errors), click: () => { show(); forward({ type: 'ui-control', command: 'sessions' }); } },
    { type: 'separator' },
    { label: copy.trayChat, click: () => { show(); forward({ type: 'ui-control', command: 'chat' }); } },
    { label: copy.trayCharacters, click: () => { show(); forward({ type: 'characters' }); } },
    { label: copy.trayDisplay, submenu: displayList.map(d => ({ type: 'radio', label: `${d.label || copy.display} · ${d.id}`, checked: d.id === displays?.state?.displayId, click: () => displays.refresh({ displayId: d.id }) })) },
    { label: copy.trayRoam, type: 'checkbox', checked: state.roam, click: item => act({ type: 'preference', field: 'roam', value: item.checked }) },
    { label: copy.traySleep, type: 'checkbox', checked: state.sleeping, enabled: !state.active, click: () => forward({ type: 'ui-control', command: 'sleep' }) },
    { label: copy.trayNotices, type: 'checkbox', checked: state.notifications, click: item => act({ type: 'preference', field: 'notifications', value: item.checked }) },
    { label: copy.traySound, type: 'checkbox', checked: state.sound, click: () => forward({ type: 'ui-control', command: 'sound' }) },
    { type: 'separator' },
    { label: state.visible ? copy.hide : copy.trayShow, click: () => state.visible ? hide() : show() },
    { label: copy.trayQuit, click: () => { userClosed = true; app.quit(); } },
  ]));
  process.send?.({ type: 'tray-state', state });
  const iconKey = `${state.characterId}:${state.scheme}:${state.iconReady}:${state.icon}`;
  if (iconKey !== lastIconKey) { lastIconKey = iconKey; void syncIcon(state, iconKey); }
}
async function syncIcon(state, key) {
  try {
    const appearance = `${state.characterId}:${state.scheme}:${state.iconReady}`;
    let icon = iconAppearance === appearance ? iconBase : undefined;
    if (!icon) {
      const view = await characters.load(state.characterId);
      const thumb = view.presets.find(preset => preset.id === state.scheme)?.thumb ?? view.thumb;
      icon = nativeImage.createFromPath(join(__dirname, 'icon.png')).toDataURL();
      if (thumb && /\.(png|webp|jpe?g|svg)$/i.test(thumb)) {
        const response = await fetch(new URL(view.base + thumb, win.webContents.getURL()));
        const bytes = Buffer.from(await response.arrayBuffer());
        if (response.ok && bytes.length < 2 * 1024 * 1024) {
          if (/\.svg$/i.test(thumb)) icon = `data:image/svg+xml;base64,${bytes.toString('base64')}`;
          else { const image = nativeImage.createFromBuffer(bytes); if (!image.isEmpty()) icon = image.toDataURL(); }
        }
      }
      iconBase = icon; iconAppearance = appearance;
    }
    const template = process.platform === 'darwin';
    const url = await win.webContents.executeJavaScript(`import('./tray-icon.js').then(m => m.trayIcon(${JSON.stringify(icon)}, ${JSON.stringify({ icon: state.icon })}, ${template}))`);
    const rendered = nativeImage.createFromDataURL(url).resize({ height: template ? 20 : 24 }); rendered.setTemplateImage(template);
    if (tray && !tray.isDestroyed() && lastIconKey === key) {
      tray.setImage(rendered);
      process.send?.({ type: 'tray-icon', icon: state.icon, template: rendered.isTemplateImage(), title: state.title });
    }
  } catch { /* Keep the packaged icon when a pack thumbnail cannot be rendered. */ }
}
process.on('message', message => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'quit') { app.quit(); return; }
  if (message.type === 'init') { options = message.options; configureDiagnostics(); lastFrame = message; forward(message); syncTray(); }
  if (message.type === 'configure') { options = message.options; configureDiagnostics(); if (lastFrame) lastFrame.options = options; forward(message); syncTray(); }
  if (message.type === 'control') {
    if (message.command === 'hide') hide();
    if (message.command === 'show' || message.command === 'characters') show();
    if (message.command === 'characters') forward({ type: 'characters' });
    // Fixed public Desktop protocol; no renderer-supplied URL or private shell IPC.
    if (message.command === 'focus-harness' && process.env.DSH_PET_TEST_NO_SANDBOX !== '1') void shell.openExternal('dsh://open').catch(() => {});
  }
  if (message.type === 'snapshot') { lastFrame = { type: 'init', baseline: true, options, snapshot: { ...message.snapshot, results: message.snapshot.results ?? lastFrame?.snapshot?.results ?? [] } }; forward(message); syncTray(); }
  if (message.type === 'chat-result') forward(message);
  if (message.type === 'notification-state' || message.type === 'notification-snooze-result') forward(message);
  if (message.type === 'notice') {
    if (message.generation !== undefined && (message.generation !== generation || message.visibilityRevision !== visibilityRevision || !win?.isVisible() || suspended)) return;
    forward(message);
  }
});
process.on('disconnect', () => app.quit());
process.on('SIGTERM', () => app.quit());

app.whenReady().then(async () => {
  const suspendState = key => { if (options?.diagnostics === true) lifecycle[key] = Math.min(Number.MAX_SAFE_INTEGER, lifecycle[key] + 1); suspended = screenLocked || systemAsleep || !lockStateKnown; visibility(); };
  powerMonitor.on('suspend', () => { systemAsleep = true; suspendState('suspends'); });
  powerMonitor.on('resume', () => { systemAsleep = false; suspendState('resumes'); });
  powerMonitor.on('lock-screen', () => { screenLocked = true; lockStateKnown = true; suspendState('locks'); });
  powerMonitor.on('unlock-screen', () => { screenLocked = false; lockStateKnown = true; suspendState('unlocks'); });
  const initialState = initialLockState({ monitor: powerMonitor });
  lockStateKnown = initialState !== 'unknown';
  screenLocked ||= initialState === 'locked';
  suspended = screenLocked || systemAsleep || !lockStateKnown;
  const { chatRequest } = await import('../web/chat-contract.js');
  const webRoot = join(__dirname, '../web');
  characters = new CharacterStore(join(app.getPath('userData'), 'figures-v2'), join(webRoot, 'upstream/whale'));
  const prefix = `/${randomBytes(24).toString('hex')}/`;
  companions = new CompanionStore(join(app.getPath('userData'), 'companionship-v1'));
  const manifest = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
  const build = JSON.parse(readFileSync(join(__dirname, '../dist/build-info.json'), 'utf8'));
  diagnostics = new Diagnostics({ registry: process.env.DSH_PET_TEST_DIAGNOSTICS_DIR ?? join(homedir(), '.dsh-coopanion', 'diagnostics'),
    profile: app.getPath('userData'), version: manifest.version, build,
    read: async () => ({ runtime: { generation, visible: !!win && !win.isDestroyed() && win.isVisible(), suspended, screenLocked, systemAsleep, lockStateKnown, lifecycle: { ...lifecycle } },
      store: companions.inspect(), renderer: await readRendererDiagnostics() }),
  });
  configureDiagnostics();
  process.once('exit', () => { companions.release(); diagnostics.release(); });
  assetServer = createPetServer({ webRoot, store: characters, prefix });
  assetServer.listen(0, '127.0.0.1'); await once(assetServer, 'listening');
  let characterOperation = Promise.resolve();
  const characterCall = (channel, operation) => ipcMain.handle(channel, (event, value) => {
    if (event.sender !== win?.webContents || event.senderFrame !== win.webContents.mainFrame) return { ok: false, error: '无效的角色请求' };
    const result = characterOperation.then(async () => {
      try { return { ok: true, value: await operation(value) }; }
      catch (error) { return { ok: false, error: String(error.message ?? error).slice(0, 400) }; }
    });
    characterOperation = result.then(() => undefined);
    return result;
  });
  const characterId = value => { if (typeof value !== 'string') throw new Error('无效的角色 id'); return value; };
  characterCall('pet:companionship', async value => {
    const request = companionRequest.parse(value);
    if (request.type === 'remove') throw new Error('Unsupported companionship request');
    await characters.load(request.characterId);
    return companions.request(request);
  });
  characterCall('pet:characters:list', () => characters.list());
  characterCall('pet:characters:load', value => characters.load(characterId(value)));
  characterCall('pet:characters:select', value => {
    if (!value || typeof value.scheme !== 'string') throw new Error('无效的角色配色');
    return characters.select(characterId(value.id), value.scheme);
  });
  characterCall('pet:characters:remove', async value => {
    const id = characterId(value); if (id === 'whale') throw new Error('内置角色不能删除');
    await characters.load(id);
    const state = await companions.request({ type: 'read', characterId: id });
    await companions.request({ type: 'remove', characterId: id, revision: state.revision, requestId: `remove-${id}-${Date.now()}` });
    return characters.remove(id);
  });
  characterCall('pet:characters:import', value => {
    if (!(value instanceof ArrayBuffer)) throw new Error('请选择 API 2 ZIP 角色包');
    return characters.import(new Uint8Array(value));
  });
  win = new BrowserWindow({ ...screen.getPrimaryDisplay().workArea, transparent: true, frame: false, resizable: false, skipTaskbar: true, hasShadow: false, show: false, alwaysOnTop: true, backgroundColor: '#00000000', webPreferences: { additionalArguments: displayTest ? ['--dsh-pet-display-test'] : [], preload: join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
  disposeAlwaysOnTop = installAlwaysOnTop(win, { isSuspended: () => suspended });
  win.on('show', visibility); win.on('hide', visibility);
  win.webContents.on('render-process-gone', () => app.exit(1));
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.platform === 'darwin') app.dock?.hide();
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  displays = createDisplayController({ screen, win, send: forward, changed: syncTray });
  displays.refresh();
  if (displayTest) require('./test-display-probe.cjs').installDisplayProbe({ ipcMain, screen, win, displays });
  for (const event of ['resize', 'resized', 'move']) win.on(event, () => setImmediate(() => { if (!win.isDestroyed()) displays.refresh(); }));
  win.webContents.on('did-finish-load', () => { if (lastFrame) forward(lastFrame); displays.publish(); });
  ipcMain.on('pet:geometry-request', event => {
    if (event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame) displays.publish();
  });
  ipcMain.on('pet:diagnostics-response', (event, message) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || options?.diagnostics !== true || !diagnosticRead || message?.requestId !== diagnosticRead.requestId) return;
    const value = diagnosticRenderer.safeParse(message.value);
    clearTimeout(diagnosticRead.timer); diagnosticRead.resolve(value.success ? value.data : null); diagnosticRead = undefined;
  });
  ipcMain.on('pet:hit', (event, active) => { if (event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame && typeof active === 'boolean') hit(active); });
  ipcMain.on('pet:action', (event, action) => {
    if (event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !action || typeof action !== 'object') return;
    if (action.type === 'hide') { hide(); return; }
    if (action.type === 'move-display') { displays.moveToCursor(); return; }
    if (action.type === 'presentation') {
      if (typeof action.characterId !== 'string' || !/^[a-z0-9-]{1,32}$/.test(action.characterId) || typeof action.scheme !== 'string' || action.scheme.length > 200 || typeof action.name !== 'string' || action.name.length > 200 || typeof action.sleeping !== 'boolean' || typeof action.sound !== 'boolean') return;
      presentation = { characterId: action.characterId, scheme: action.scheme, name: action.name, locale: typeof action.locale === 'string' ? petLanguage(action.locale) : undefined, sleeping: action.sleeping, sound: action.sound, ready: action.ready === true }; syncTray(); return;
    }
    if (action.type === 'notification-snooze') { if (typeof action.interactionId === 'string' && action.interactionId.length <= 2048 && Number.isSafeInteger(action.generation)) act(action); return; }
    if (action.type === 'chat') { const request = chatRequest(action); if (request) act(request); return; }
    if (action.type !== 'select' && action.type !== 'open-session' && action.type !== 'preference' && action.type !== 'read') return;
    process.send?.({ type: 'action', action });
  });
  hit(false);
  await win.loadURL(`http://127.0.0.1:${assetServer.address().port}${prefix}`);
  if (desiredVisible) show(); else visibility();
  // Restore input when a click-through window misses movement, without repeatedly
  // overriding the renderer's newer pointer event with a stationary OS cursor.
  let lastCursor, keyboardSentAt = -Infinity;
  const pollCursor = () => {
    keyboardActivity.configure(!!options?.companionship && options.companionship !== 'off' && !!win && !win.isDestroyed() && win.isVisible() && !suspended);
    if (performance.now() - keyboardSentAt >= 500) { keyboardSentAt = performance.now(); forward({ type: 'keyboard-activity', ...keyboardActivity.inspect() }); }
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const next = displays.cursor();
    if (!next || (next.x === lastCursor?.x && next.y === lastCursor?.y && next.revision === lastCursor?.revision)) return;
    lastCursor = next; forward(next);
  };
  pollCursor(); poll = setInterval(pollCursor, 100);
  const icon = nativeImage.createFromPath(join(__dirname, 'icon.png')).resize({ height: 24 });
  tray = new Tray(icon); syncTray();
  tray.on('click', show);
  const displayEvents = ['display-added', 'display-removed', 'display-metrics-changed'];
  const displayChanged = () => { if (!win.isDestroyed()) { displays.refresh(); lastTrayKey = undefined; syncTray(); } };
  for (const event of displayEvents) screen.on(event, displayChanged);
  win.once('closed', () => { for (const event of displayEvents) screen.off(event, displayChanged); });
  process.send?.({ type: 'ready' });
}).catch(error => {
  console.error(error);
  const failure = { type: 'startup-error', error: String(error?.message ?? error).slice(0, 600), recoverable: ['EADDRINUSE', 'EAGAIN', 'ENOMEM'].includes(error?.code) };
  if (process.connected) process.send(failure, () => app.exit(1)); else app.exit(1);
});

app.on('before-quit', () => { if (userClosed) process.send?.({ type: 'closed' }); disposeAlwaysOnTop?.(); clearInterval(poll); keyboardActivity.configure(false); if (diagnosticRead) { clearTimeout(diagnosticRead.timer); diagnosticRead.resolve(null); diagnosticRead = undefined; } diagnostics?.release(); void diagnostics?.close(); assetServer?.close(); tray?.destroy(); });
app.on('window-all-closed', () => { userClosed = true; app.quit(); });
