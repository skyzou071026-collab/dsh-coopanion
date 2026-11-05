import { ElectronBridge } from '../dist/bridge.js';
const pet = new ElectronBridge();
let timer;
pet.on('failure', error => { console.error(error.message); process.exitCode = 1; clearInterval(timer); });
const phases = [
  ['idle', '你好，我是大肥鱼。这是桌面演示，任务事件是模拟的。'],
  ['thinking', '让我想想，接下来该怎么做…'],
  ['working', '正在看文件 · src/index.ts'],
  ['waiting', '这一步需要你确认，真实插件会引导你回到 Harness。'],
  ['happy', '任务完成啦！一起休息一下吧。🐳'],
];
let phase = 0;
let revision = 0, current;
const results = [];
function update(mood, text) {
  revision++;
  if (mood === 'happy') results.push({ id: `demo:${revision}`, sessionId: 'demo', text, time: Date.now(), read: false });
  current = { mood, text, active: ['thinking', 'talking', 'working', 'waiting'].includes(mood), revision, streaming: false, speechId: '', sessionId: 'demo', results,
    sessions: [{ id: 'demo', label: '桌面演示', project: 'dsh-coopanion', cwd: '', prompt: '', createdAt: Date.now(), updatedAt: Date.now(), mood, text, active: ['thinking', 'talking', 'working', 'waiting'].includes(mood), reply: '', replyId: results.at(-1)?.id ?? '', unread: results.filter(r => !r.read).length, revision, streaming: false, speechId: '' }] };
  pet.update(current);
}
update(...phases[0]);
await pet.start({ size: 150, roam: true, notifications: false, bubbleDurationMs: 12000 });
pet.onAction(action => {
  if (action?.type === 'chat') update('happy', `收到「${action.text}」！这是演示回复，真实插件会把消息发给 Harness。`);
  else if (action?.type === 'read') { const result = results.find(r => r.id === action.resultId); if (result) { result.read = true; current.sessions[0].unread = results.filter(r => !r.read).length; pet.update(current); } }
});
timer = setInterval(() => { phase = (phase + 1) % phases.length; update(...phases[phase]); }, 16000);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { clearInterval(timer); await pet.dispose(); });
