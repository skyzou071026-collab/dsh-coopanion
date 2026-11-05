import { afterEach, expect, it, vi } from 'vitest';
import { syncPetLocale } from '../src/client/locale-sync.ts';
import { appNoticeCopy, appStatusBody, petCopy } from '../web/locale.js';

afterEach(() => vi.useRealTimers());
it('aborts an in-flight language change when returning to the previously accepted language', async () => {
  let current='en', change: (force?: boolean) => void = () => {};
  const calls: {locale:string;signal:AbortSignal}[]=[];
  const stop=syncPetLocale({current:()=>current,subscribe:listener=>{change=listener;return()=>{};},send:async(locale,signal)=>{calls.push({locale,signal});if(locale==='zh') await new Promise(()=>{});}});
  await vi.waitFor(()=>expect(calls).toHaveLength(1));
  current='zh';change();await vi.waitFor(()=>expect(calls).toHaveLength(2));
  current='en';change();await vi.waitFor(()=>expect(calls).toHaveLength(3));
  expect(calls.map(call=>call.locale)).toEqual(['en','zh','en']);expect(calls[1].signal.aborted).toBe(true);
  stop();
});
it('retries the current locale after connection failure and stops timers on disposal', async () => {
  vi.useFakeTimers(); const send=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  const stop=syncPetLocale({current:()=> 'zh-CN',subscribe:()=>()=>{},send,retryMs:10});
  await vi.advanceTimersByTimeAsync(11); expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1][0]).toBe('zh');
  stop(); await vi.advanceTimersByTimeAsync(10000); expect(send).toHaveBeenCalledTimes(2);
});
it('bounds a transport that ignores abort and retries without retaining old requests', async () => {
  vi.useFakeTimers();const send=vi.fn(()=>new Promise<void>(()=>{}));
  const stop=syncPetLocale({current:()=> 'en',subscribe:()=>()=>{},send,timeoutMs:10,retryMs:10});
  await vi.advanceTimersByTimeAsync(21);expect(send).toHaveBeenCalledTimes(2);
  stop(); await vi.advanceTimersByTimeAsync(100);expect(send).toHaveBeenCalledTimes(2);
});
it('keeps complete paired dictionaries and translates only application diagnostics', () => {
  expect(Object.keys(petCopy('en')).sort()).toEqual(Object.keys(petCopy('zh')).sort());
  expect(Object.keys(petCopy('en').labels)).toEqual(Object.keys(petCopy('zh').labels));
  expect(appNoticeCopy({title:'会话尚未就绪',body:'请先回到 Harness 打开这个会话，然后再发送消息。'},'en')).toEqual({title:'Conversation not ready',body:'Open this conversation in Harness before sending a message.'});
  const text='任务遇到了问题，请回到 Harness 查看详情。';
  expect(appStatusBody({category:'error',body:text},'en')).toBe(petCopy('en').issueError);
  expect(appStatusBody({category:'completed',body:text},'en')).toBe(text);
  expect(appStatusBody({category:'question',body:text},'en')).toBe(text);
});
