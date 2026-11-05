/** Match Harness's built-in Chinese/English fallback; never translate conversation content. */
export function petLanguage(locale = 'en') { return /^zh(?:-|$)/i.test(locale) ? 'zh' : 'en'; }
export function automaticPetLanguage(languages = []) {
  return petLanguage(languages.find(locale => /^(?:zh|en)(?:-|$)/i.test(locale)) ?? 'en');
}
export function localizedText(names, locale) { return names?.[petLanguage(locale)] ?? names?.en ?? names?.zh ?? Object.values(names ?? {})[0] ?? ''; }

const zh = {
  companionPetThanks:'谢谢摸摸', companionNoActivity:'这个模样暂时没有一起活动的动作', companionInvite:'陪我活动一下？', companionTogether:'一起活动', companionLater:'稍后', companionQuietToday:'今天安静', companionMode:'自主陪伴', companionOff:'关闭（停止自主活动）', companionQuiet:'安静陪伴', companionInteractive:'互动陪伴', companionResume:'恢复邀请', companionNew:'慢慢熟悉你', companionFamiliar:'熟悉招呼已解锁', companionProgress:n=>`一起相处了 ${n} 次`, companionUnavailable:'相处进度暂时无法保存', companionDisabled:'开启陪伴，留下相处的记忆', companionBusy:'等忙完再一起玩', companionPlaying:'陪你活动一会儿', companionPlayed:'一起活动，真开心',
  defaultName: 'DeepSeek 大肥鱼', title: 'DeepSeek 大肥鱼 · Harness',
  words:{neutral:'平静',happy:'开心',wink:'眨眼',love:'喜欢',shy:'害羞',surprised:'惊讶',angry:'生气',sad:'难过',sleepy:'犯困',thinking:'思考',smug:'得意',pout:'嘟嘴',worried:'担心',determined:'认真',flustered:'慌张',scared:'害怕',excited:'期待',cry:'大哭',confused:'疑惑',stand:'站起',jump:'跳',hop:'小跳',look:'张望',turn:'转身',nod:'点头',shake:'摇头',spin:'转圈',sit:'坐下',sleep:'睡觉',dizzy:'晕',walk:'散步',run:'跑',wave:'招手',bow:'鞠躬',shiver:'发抖',flap:'扑腾',dance:'跳舞'},
  settingFailed:'设置未能保存', settingFailedBody:'请回到 Harness 检查插件设置。', sessionUnavailable:'会话尚未就绪', sessionUnavailableBody:'请先回到 Harness 打开这个会话，然后再发送消息。', messageFailed:'消息未能发送', messageFailedBody:'请回到 Harness 检查会话状态。',
  replyBody:'本轮回复已生成，回到会话查看。', progressBody:'本轮回复已生成，目标仍在进行中。', completeBody:'目标已完成，回到会话查看。', goalPausedBody:'目标已暂停，回到会话查看。', goalBlockedBody:'目标遇到阻碍，回到会话查看。', stoppedBody:'先停在这里，随时继续。', interruptedBody:'这段任务中断了，陪你回去看看。',
  demoTitle:'工作的时候，\n大肥鱼陪着。', demoIntro:'住在桌面上的 DeepSeek 大肥鱼。\n点点她、拖着她走，或和她说句话。', demoStatus:'浏览器演示 · 模拟 Harness 事件', demoHint:'桌面插件会订阅真实任务，无需另填 API Key。',
  demoButtons:{thinking:'思考',talking:'回复',working:'工作',waiting:'等你确认',happy:'任务完成',error:'遇到问题',idle:'空闲',long:'长回复',background:'后台完成'},
  demoSession:'演示会话', demoOther:'另一个想法', demoPrompt:'让角色在思考与回复时做出对应的动作', demoOtherPrompt:'重做角色菜单与会话选择，让它更像伙伴',
  demoTexts:{thinking:'让我想一想，怎样把这个功能做好…',talking:'我想到了。让思考、说话与工作各有自己的动作，就能一眼看出这段对话在做什么。',working:'正在看文件 · src/index.ts',waiting:'下一步需要你确认。真实插件会引导你回到 Harness。',happy:'任务完成啦！要不要休息一下？🐳',error:'任务遇到了问题，请回到 Harness 查看详情。'},
  demoLong:'动画、气泡和会话的展示已经分开了。\n\n'+'思考和工具调用由动作表达，最终回复可以展开阅读。长内容会完整保留，不会在一千二百字处截断。\n\n'.repeat(35)+'最后一句：这份回复完整地保留下来了。', demoBackground:'后台会话已经完成，这是它的最终回复。', demoReply:text=>`收到「${text}」！这是演示回复。真实插件会使用 Harness 的模型。`,
  labels: { idle:'在这里陪你', thinking:'正在思考', talking:'正在回复', working:'正在忙', waiting:'等你确认', happy:'完成啦', error:'需要关注', sleeping:'休息中' },
  stage:'桌宠活动区域', dismiss:'收起气泡', reveal:'立即显示', expand:'展开完整回复 ↗', back:'回到会话 ↗', readerClose:'收起完整回复',
  conversationsCaption:'一起工作的片段', conversationsTitle:'这次，陪哪一段？', conversationsClose:'收起对话气泡', conversationsIntro:'固定陪着你选的这段。后台继续工作，回复留在这里，遇到要紧事就叫你。',
  all:'全部', pending:'待查看', searchPlaceholder:'找提问、项目或编号…', searchLabel:'搜索会话', switchConversation:'切换当前对话', openCurrent:'打开当前会话 ↗',
  chatTitle:'我在，慢慢说。', chatClose:'关闭聊天', changeConversation:'换一段 ›', readFull:'读完整回复 ↗', interact:'和角色互动', wave:'打个招呼', cheer:'给我打气', messagePlaceholder:'接着这段对话说点什么…', messageLabel:'消息', sendHint:'⌘ / Ctrl + Enter 发送', send:'捎给这段对话 ↗', retrySend:'重试发送 ↗', sending:'发送中…', sendAccepted:'已进入这段会话的收件队列。回复将继续显示在这里。', sendFailure:code=>`发送未确认：${chatFailure(code, 'zh')}。草稿已保留，可重试。`,
  companion:'桌上的小伙伴', menuClose:'收起伙伴菜单', appearance:'换个模样', appearanceHint:'角色 · 配色 · 动作', say:'说句话', sayHint:'接着你的会话聊', roam:'散散步', roamHint:'自在走动', sleep:'歇一会', sleepHint:'忙起来会醒', notices:'提醒我', noticesHint:'要紧事不漏掉', sound:'小小声', soundHint:'动作与说话音效', hide:'暂时藏起来', source:'源码 · AGPL ↗', sourceHint:'下载当前版本完整对应源码',
  characters:'角色与动画', charactersClose:'关闭角色面板', selectCharacter:'选择角色', character:'角色', outfit:'配色 / 换装', characterScheme:'角色配色', preview:'角色动画预览', previewAction:'预览动作', play:'播放动作', useCharacter:'使用角色', import:'导入角色包', remove:'删除', characterHint:'支持 Coopanion API 2 ZIP 角色包；角色和配色会在重启后保留。',
  using:'正在使用', useScheme:'使用这个配色', useOutfit:'使用这个搭配', customOutfit:'自定义搭配', defaultScheme:'默认', imported:'已导入。预览满意后点击使用角色。', switched:'已切换，重启后会保留这个角色和配色。', removed:'已删除本地角色包。', packTooLarge:'角色包不能超过 128 MiB',
  noSession:'还没有对话', noConversation:'还没有会话', session:'会话', sessionReply:'会话回复', focused:'关注', unread:'1 份未读', notOpen:'未打开', connected:'有会话相伴', emptySearch:'没找到这段对话。试试提问里的词或项目名？', emptyPending:'都看过啦，安心做手边的事。', emptySessions:'还没有可用的对话。先在 Harness 中打开一段对话，我就能听见它。', noChat:'先在 Harness 中打开一段对话，就可以从这里和我说话。', unavailableChat:'会话服务暂不可用，请在 Harness 中检查。', sleepBusy:'正在忙，完成后再休息', sleepWake:'有新的任务会自动醒来',
  issueError:'任务遇到了问题，请回到 Harness 查看详情。', issueWaiting:'任务暂时停下了，请回到 Harness 看看。', timeUnknown:'时间未记录',
  petLabel:name=>`${name}，点击互动，双击聊天，右键菜单，拖动移动`, finalReply:name=>`${name}的最终回复`, recent:text=>`最近：${text}`, chatTarget:label=>`当前对话：${label}。点击切换`, chatHelp:label=>`消息交给「${label}」，完成后只展示最终回复。`, activity:(busy,unread)=>`${busy} 段进行中 · ${unread} 份未读回复`,
  authorCredit:(author,credits,license)=>`作者：${author} · ${credits} · 许可：${license}`, unknownAuthor:'未注明', builtinLicense:'代码 AGPL-3.0-or-later；素材见权利声明', authorLicense:'由角色作者注明',
  operationError:detail=>`操作未完成：${detail}`, bodyError:detail=>`角色运行失败：${detail}`, builtinError:detail=>`无法加载内置角色：${detail}`, previewError:detail=>`预览失败：${detail}`, restoreError:detail=>`已恢复内置大肥鱼：${detail}`, loadError:detail=>`角色加载失败：${detail}`,
  trayDisplay:'移到显示器', display:'显示器', trayOpen:'回到当前会话', traySwitch:'切换陪伴会话', trayChat:'说句话', trayCharacters:'角色与配色', trayRoam:'自在走动', traySleep:'休息一下（新任务会唤醒）', trayNotices:'任务提醒', traySound:'动作与说话音效', trayShow:'显示伙伴', trayQuit:'关闭桌宠', trayNeeds:' · 需要你',
  trayUnread:n=>` · ${n} 份未读`, trayPending:(unread,pending)=>`待查看 · ${unread} 份回复 · ${pending} 段需要你`, trayTooltip:(name,mood,label,busy,pending,unread)=>`${name} · ${mood}\n关注：${label}\n${busy} 段进行中 · ${pending} 段需要你 · ${unread} 份未读回复`,
};
const en = {
  companionPetThanks:'Thanks for the gentle stroke', companionNoActivity:'This character has no shared activity yet', companionInvite:'Shall we play for a moment?', companionTogether:'Play together', companionLater:'Later', companionQuietToday:'Quiet today', companionMode:'Companionship', companionOff:'Off (no autonomous activity)', companionQuiet:'Quiet', companionInteractive:'Interactive', companionResume:'Resume invitations', companionNew:'Getting to know you', companionFamiliar:'Familiar greeting unlocked', companionProgress:n=>`${n} shared moments`, companionUnavailable:'Shared moments cannot be saved right now', companionDisabled:'Enable companionship to remember shared moments', companionBusy:'Let’s play after work', companionPlaying:'Playing together', companionPlayed:'That was fun together',
  defaultName: 'DeepSeek Whale', title: 'DeepSeek Whale · Harness',
  words:{neutral:'Neutral',happy:'Happy',wink:'Wink',love:'Love',shy:'Shy',surprised:'Surprised',angry:'Angry',sad:'Sad',sleepy:'Sleepy',thinking:'Thinking',smug:'Smug',pout:'Pout',worried:'Worried',determined:'Determined',flustered:'Flustered',scared:'Scared',excited:'Excited',cry:'Cry',confused:'Confused',stand:'Stand',jump:'Jump',hop:'Hop',look:'Look around',turn:'Turn',nod:'Nod',shake:'Shake head',spin:'Spin',sit:'Sit',sleep:'Sleep',dizzy:'Dizzy',walk:'Walk',run:'Run',wave:'Wave',bow:'Bow',shiver:'Shiver',flap:'Flap',dance:'Dance'},
  settingFailed:'Settings were not saved', settingFailedBody:'Open Harness to check the plugin settings.', sessionUnavailable:'Conversation not ready', sessionUnavailableBody:'Open this conversation in Harness before sending a message.', messageFailed:'Message was not sent', messageFailedBody:'Open Harness to check the conversation state.',
  replyBody:'This turn’s reply is ready. Open the conversation to read it.', progressBody:'This turn’s reply is ready. The goal is still in progress.', completeBody:'Goal completed. Open the conversation to read it.', goalPausedBody:'The goal is paused. Open the conversation for details.', goalBlockedBody:'The goal is blocked. Open the conversation for details.', stoppedBody:'Paused here. Continue whenever you are ready.', interruptedBody:'This task was interrupted. Open the conversation to check it.',
  demoTitle:'While you work,\nWhale keeps you company.', demoIntro:'Your DeepSeek Whale desktop companion.\nSay hello, drag her around, or continue a conversation.', demoStatus:'Browser demo · Simulated Harness events', demoHint:'The desktop plugin follows real tasks. No extra API key is needed.',
  demoButtons:{thinking:'Think',talking:'Reply',working:'Work',waiting:'Approval',happy:'Finished',error:'Error',idle:'Idle',long:'Long reply',background:'Background reply'},
  demoSession:'Demo conversation', demoOther:'Another idea', demoPrompt:'Match the character’s actions to thinking and replying', demoOtherPrompt:'Make the character menu and conversation picker feel like a companion',
  demoTexts:{thinking:'Let me think about how to do this…',talking:'Thinking, replying and working each have their own actions, so you can see what this conversation is doing.',working:'Reading files · src/index.ts',waiting:'The next step needs your approval. The installed plugin opens Harness.',happy:'Finished! Shall we take a rest? 🐳',error:'This task needs attention. Open Harness for details.'},
  demoLong:'Animation, bubbles and conversations are presented separately.\n\n'+'Actions show thinking and tool use. Final replies open in full and remain complete, including long content.\n\n'.repeat(35)+'The complete reply has been preserved.', demoBackground:'The background conversation finished. Here is its final reply.', demoReply:text=>`Received “${text}”! This is a demo reply. The installed plugin uses the Harness model.`,
  labels: { idle:'Here for you', thinking:'Thinking', talking:'Replying', working:'Working', waiting:'Waiting for you', happy:'Finished', error:'Needs attention', sleeping:'Resting' },
  stage:'Desktop pet activity area', dismiss:'Dismiss bubble', reveal:'Show now', expand:'Read full reply ↗', back:'Back to conversation ↗', readerClose:'Close full reply',
  conversationsCaption:'Working together', conversationsTitle:'Which conversation shall we join?', conversationsClose:'Close conversations', conversationsIntro:'Stay with the conversation you choose. Background work continues, replies stay here, and important requests get your attention.',
  all:'All', pending:'Inbox', searchPlaceholder:'Find a prompt, project or ID…', searchLabel:'Search conversations', switchConversation:'Switch current conversation', openCurrent:'Open current conversation ↗',
  chatTitle:'I’m here. Take your time.', chatClose:'Close chat', changeConversation:'Switch ›', readFull:'Read full reply ↗', interact:'Interact with the character', wave:'Say hello', cheer:'Cheer me on', messagePlaceholder:'Continue this conversation…', messageLabel:'Message', sendHint:'⌘ / Ctrl + Enter to send', send:'Send to this conversation ↗', retrySend:'Retry send ↗', sending:'Sending…', sendAccepted:'Accepted into this conversation’s inbox. Replies will appear here.', sendFailure:code=>`Send unconfirmed: ${chatFailure(code, 'en')}. Draft kept; you can retry.`,
  companion:'Your desktop companion', menuClose:'Close companion menu', appearance:'Change appearance', appearanceHint:'Character · Colours · Actions', say:'Say something', sayHint:'Continue your conversation', roam:'Take a walk', roamHint:'Roam freely', sleep:'Take a rest', sleepHint:'Wake when work starts', notices:'Keep me posted', noticesHint:'Remember important requests', sound:'A little sound', soundHint:'Action and reply sounds', hide:'Hide for now', source:'Source · AGPL ↗', sourceHint:'Download the complete source for this version',
  characters:'Characters and animation', charactersClose:'Close character panel', selectCharacter:'Select character', character:'Character', outfit:'Colours / Outfit', characterScheme:'Character colours', preview:'Character animation preview', previewAction:'Preview action', play:'Play action', useCharacter:'Use character', import:'Import character pack', remove:'Delete', characterHint:'Coopanion API 2 ZIP packs. Characters and colours survive restarts.',
  using:'In use', useScheme:'Use these colours', useOutfit:'Use this outfit', customOutfit:'Custom outfit', defaultScheme:'Default', imported:'Imported. Preview the character, then choose Use character.', switched:'Changed. This character and its colours will survive restarts.', removed:'Local character pack deleted.', packTooLarge:'Character packs cannot exceed 128 MiB',
  noSession:'No conversation yet', noConversation:'No conversation yet', session:'Conversation', sessionReply:'Conversation reply', focused:'Focused', unread:'1 unread reply', notOpen:'Not open', connected:'Conversation connected', emptySearch:'No matching conversation. Try a word from the prompt or project name.', emptyPending:'All read. Carry on with your work.', emptySessions:'No conversation is available. Open one in Harness to get started.', noChat:'Open a conversation in Harness to chat here.', unavailableChat:'The conversation service is unavailable. Check Harness.', sleepBusy:'Working now. Rest when it is done.', sleepWake:'Wake automatically when new work starts.',
  issueError:'The task needs attention. Open Harness for details.', issueWaiting:'The task paused. Open Harness to check the next step.', timeUnknown:'Time not recorded',
  petLabel:name=>`${name}, click to interact, double-click to chat, right-click for the menu, drag to move`, finalReply:name=>`Final reply from ${name}`, recent:text=>`Recent: ${text}`, chatTarget:label=>`Current conversation: ${label}. Click to switch`, chatHelp:label=>`Send to “${label}”. Each turn’s full reply is kept here.`, activity:(busy,unread)=>`${busy} active · ${unread} unread replies`,
  authorCredit:(author,credits,license)=>`Author: ${author} · ${credits} · License: ${license}`, unknownAuthor:'Not specified', builtinLicense:'Code: AGPL-3.0-or-later; see artwork rights notice', authorLicense:'Specified by the character author',
  operationError:detail=>`Operation failed: ${detail}`, bodyError:detail=>`Character runtime failed: ${detail}`, builtinError:detail=>`Cannot load the built-in character: ${detail}`, previewError:detail=>`Preview failed: ${detail}`, restoreError:detail=>`Built-in Whale restored: ${detail}`, loadError:detail=>`Character failed to load: ${detail}`,
  trayDisplay:'Move to display', display:'Display', trayOpen:'Open current conversation', traySwitch:'Choose companion conversation', trayChat:'Say something', trayCharacters:'Characters and colours', trayRoam:'Roam freely', traySleep:'Rest (new work wakes the pet)', trayNotices:'Task reminders', traySound:'Action and reply sounds', trayShow:'Show companion', trayQuit:'Close desktop pet', trayNeeds:' · Needs attention',
  trayUnread:n=>` · ${n} unread`, trayPending:(unread,pending)=>`Inbox · ${unread} replies · ${pending} need attention`, trayTooltip:(name,mood,label,busy,pending,unread)=>`${name} · ${mood}\nFocused: ${label}\n${busy} active · ${pending} need attention · ${unread} unread replies`,
};
export function petCopy(locale) { return petLanguage(locale) === 'zh' ? zh : en; }

/** Only application diagnostics are translated; conversation content stays verbatim. */
export function appNoticeCopy(notice, locale) {
  const copy = petCopy(locale);
  for (const key of ['settingFailed','sessionUnavailable','messageFailed']) {
    if (notice.title !== zh[key] && notice.title !== en[key]) continue;
    const bodyKey = key+'Body';
    return { title: copy[key], body: notice.body === zh[bodyKey] || notice.body === en[bodyKey] ? copy[bodyKey] : notice.body };
  }
  return { title: notice.title, body: notice.body };
}
export function appStatusBody(notice, locale) {
  for (const key of ['replyBody', 'progressBody', 'completeBody', 'goalPausedBody', 'goalBlockedBody']) {
    if (notice.body === zh[key] || notice.body === en[key]) return petCopy(locale)[key];
  }
  const key = {error:'issueError',blocked:'issueWaiting','max-tokens':'issueWaiting',stopped:'stoppedBody',interrupted:'interruptedBody'}[notice.category];
  if (!key || notice.body !== zh[key] && notice.body !== en[key]) return notice.body;
  return petCopy(locale)[key];
}

/** The Host category determines completion labels in menus and the native tray. */
export function sessionStateLabel(session, locale, mood = session?.mood) {
  const copy = petCopy(locale);
  if (!session?.active && mood === session?.mood && session?.completion) {
    const key = { reply: 'replyBody', 'goal-progress': 'progressBody', completed: 'completeBody' }[session.completion];
    if (key) return copy[key];
  }
  return copy.labels[mood] ?? copy.labels.idle;
}

function chatFailure(code, language) {
  const reasons = {
    'session/not-found': ['会话不存在或已删除', 'conversation missing or deleted'],
    'session/writer-held': ['会话正由其他进程占用', 'conversation held by another writer'],
    'session/subagent-owned': ['子代理会话不能直接续接', 'subagent conversation cannot be continued here'],
    'session/model-unavailable': ['会话没有可用模型', 'no available model for this conversation'],
    'session/provider-credentials-unavailable': ['会话的模型凭据不可用', 'model credentials unavailable'],
    'gateway/forbidden': ['没有此会话的操作权限', 'permission denied'],
    'gateway/cancelled': ['提交已取消', 'submission cancelled'],
    'coopanion/service-unavailable': ['会话服务缺失', 'conversation service unavailable'],
    'coopanion/request-conflict': ['请求身份与原消息不一致', 'request identity conflicts with the original message'],
    'coopanion/no-receipt': ['未收到接受回执，重试会复用原请求身份', 'no acceptance receipt; retry uses the same request identity'],
    'session/agent-busy': ['会话暂时不能接收消息', 'conversation cannot accept the message now'],
  };
  return reasons[code]?.[language === 'zh' ? 0 : 1] ?? (language === 'zh' ? `会话暂不可用 (${code ?? 'unknown'})` : `conversation unavailable (${code ?? 'unknown'})`);
}
