# 提醒接口：protocol 1

共享定义位于 [notification-contract.ts](../src/notification-contract.ts)，网页通知适配器位于 [system-notifications.ts](../src/client/system-notifications.ts)。Host、DSH Client 与桌宠随同一安装包消费这些定义。

## 身份与事件

提醒 id 使用 `[sessionId, turn, seq, category, stage]` 的 JSON 元组编码；请求 id 使用 `[sessionId, kind, nativeId]`。各字段保留完整值。稍后提醒使用可选调度轮次；无日志 callId 的运行请求使用完整 runtime UUID 并标记 `source: runtime`，上下文 turn／seq 保留已提交锚点。runtime 元组依次追加 UUID 与可选调度轮次。`stage` 区分 `initial` 和 `reminder`。

类别为 `reply`、`goal-progress`、`completed`、`approval`、`question`、`error`、`stopped`、`interrupted`、`blocked`、`max-tokens`。每条提醒带标题、预览、源时间和对应请求 id 列表；合并互动通过请求列表关联各自的结算状态。

审批从 `approval/asked` 与 `approval/decided` 的原生 id 配对。提问从公开 `user-questions/request` 获取运行中的提示，从 `ctx.sessionProjections.snapshot(session, ['userQuestions'])` 获取持久限时提问的 `open`、`continued` 和 `settled` 状态。具体请求由完整 `callId` 定位。

限时提问返回 pending 后，回合结束仍保持 `continued`。接收 `user-question-reply` 的 user message 后结算对应问题；补提醒按投影中的有效请求安排。阻塞请求在其答复／取消信号结算时结束等待。Host 对恢复状态进行折叠，实时事件产生新的提醒。

## 完成语义

Host 的共享 `CompletionTracker` 使用支持版本的 `@deepseek-ai/dsh-goal` 公共 `applyGoalProjection` 严格折叠已提交事件，不读取工具调用参数或工具输出作为成功依据。该宿主包声明为 peer；目标服务未运行、历史缺失、未知版本或投影折叠失败时立即使用 `reply`，不等待目标状态。失败后的流保持保守降级。

| 已提交事实 | 类别 / 角色 | 结果与文案 |
|---|---|---|
| 普通回合 completed、没有可确认的新目标完成 | reply / idle | 本轮回复已生成；保留全文、未读与继续入口 |
| 当前目标 active，回合 completed | goal-progress / idle | 本轮回复已生成，目标仍在进行中 |
| 本轮内同一完整目标身份提交 complete，回合 completed | completed / happy | 目标已完成；庆祝约 2.5 秒 |
| 当前目标 paused / blocked | stopped / idle 或 blocked / waiting | 目标暂停或受阻；保留结果及异常入口 |
| 回合 error / aborted / interrupted / blocked / max-tokens | 沿用相应异常类别 | 即使本轮提交过 complete，也不以回合结束报成功 |

提醒可附带 `goal: { id, revision, round }`，每个字段保留完整值；`round` 为严格投影中已接纳轮数。`completed` 专指确认的新目标完成，`reply` 和 `goal-progress` 都不触发成功神态。目标完成身份只结算一次，历史终态不把后续普通回合变成成功。宿主在回合外提交终态（如自动轮数耗尽后 block）也更新角色和提醒，以该 `goal/change` 的 seq 为锚点。

类别和可选 goal 字段是 protocol 1 的同包扩展，Host / Client / Electron 必须一起更新；不在持久配置中保存提醒，所以旧配置沿用默认值，旧通知不会迁移为新通知。历史恢复折叠目标及回复作为已读基线，不重放提醒。审批与 continued 提问仍独立结算，阅读和打开会话不代表审批或答复。角色、系统通知和托盘通过共享类别呈现，正文保持原文。

发送接受回执独立于提醒与任务结果，详见[会话续接契约](session-chat-contract.md)。阅读结果不改变关注会话；显式点击“继续对话”才选择来源会话并打开输入框。审批与提问仍只由 Harness 的实际处理结算。

## 运行与领取

`NotificationRuntime` 包含阶段、运行代次 `generation`、显示状态版本 `visibilityRevision`、原生可见性、休眠状态和有界错误。

包含 `recovering` 阶段与可选 `desiredVisible`、`recoveryAttempt`（0–3）、`retryAt`（Host 时间戳）。恢复等待不具备投递资格；显示意图不代表原生可见性。新代必须收到自己的 visibilityRevision，旧领取仅结算迟到证据，不再进入其他通道。具体启动、停止、锁屏及结果基线见[桌面恢复契约](desktop-recovery-contract.md)。旧配置没有新增持久字段，默认行为保持；Host / Client / Electron 随包同步。

Host 按运行状态、显示状态及用户设置选择通道。系统投递需要 Host 颁发的 `DeliveryClaim`，其中包含不可推断的 token、完整提醒、客户端 id、运行代次、显示状态版本及过期时间。

| Connection 方法 | 请求 | Host 返回／行为 |
|---|---|---|
| `coopanion/notification-state` | 空对象或可选 locale | `NotificationSnapshot`：protocol、运行状态及待处理请求 |
| `coopanion/notification-claim` | clientId、generation | 当前有效 `DeliveryClaim` 或 null |
| `coopanion/notification-receipt` | `DeliveryReceipt` | 验证 token、客户端、提醒及代次后记录回执 |
| `coopanion/notification-test` | clientId、generation | 用户操作创建或复用公开源会话，返回对应完整提醒的领取；角色运行且隐藏时可用 |
| `coopanion/notification-snooze` | interactionId、generation | 为当前有效请求重新安排到期时间 |

方法使用对应 `/api/coopanion/<endpoint>` 的公开 Connection 载体。请求按共享严格 schema 校验。Host 负责服务端领取令牌、单次领取、停止取消、迟到回执处理与请求结算；入口装配见 [index.ts](../src/index.ts)。

## 网页通知

`SystemNotifications` 提供 `status()`、`requestPermission()`、`deliver(claim)` 和 `dispose()`。运行时注入实际 Web Notification API、回执函数、源会话操作与时钟。

`status()` 报告网页权限，系统授权保持 `unknown`。`requestPermission()` 由启用按钮触发。`deliver()` 验证领取期限、网页权限和本客户端的 token 去重，使用提醒 id 作为通知 tag，并保持系统通知静音。

回执分为 `requested`、`shown`、`clicked`、`failed`、`unknown`。构造通知产生 requested；实际 onshow 产生 shown；实际 onclick 产生 clicked 并调用对应完整 sessionId 的会话操作；onerror 和构造失败产生 failed。回执字段完整关联原领取。OS 授权、通知中心留存及窗口激活以实机结果记录。

`dispose()` 释放事件回调和本地引用，已送达通知由 OS 管理留存。Client 按 Host 运行代次管理适配器生命周期，并接入权限说明、测试反馈及状态刷新。

## 配置与动作

通知配置包括 `notifications=true`、`systemNotifications=false`、`reminders=true`、`reminderDelayMs=600000`。提醒延迟允许 1 分钟至 24 小时。关闭提醒取消主动投递与计时，状态和结果继续随会话更新。

打开会话、确认回复已读和稍后提醒分别操作对应会话、结果和请求。查看动作保留请求的待答／待审批状态；实际结算来自 Harness 的处理结果。

通用异常的查看回执：点击异常／暂停条目的“去处理／Take a look”打开源会话后，当前 Renderer 按完整会话 id、状态修订、神态、文案及完成类别记住这一轮已查看。相同快照重发不恢复该条信封与持续悲伤／等待神态；查看前已经排队的同源无请求异常提示同步撤下，旧 id 仍保留投递去重，后续新提示不被屏蔽；新的修订、重新工作、会话移除或新审批／提问使旧回执失效。其他未读回复与待处理项继续保留。这个回执只影响桌宠的注意力呈现，原始任务状态、聊天来源、未读回复和 Host 托盘事实不改写；不能将异常标为任务成功。存在真实未结审批／提问或仍在工作的会话不接受通用异常回执。回执仅在当前 Renderer 内保留，窗口重载／进程恢复后按 Host 的当前事实重新呈现。

## 检查

`npm run test:n0` 检查共享协议和网页适配器，并构建私有原型。`npm run test:n0:host -- --runtime <runtime-dir> --version <dsh-version>` 在实际安装的宿主包上检查公开请求、投影、审批配对和取消语义。

三平台 CI 执行共享检查并保留原型摘要；十八组实际安装检查分别执行对应宿主版本的接口检查并上传报告。每份 Host 报告记录源码 commit、插件版本、包实现摘要及实际控制样本事件。

独立 `textScale` 是呈现偏好，不改变类别、提醒身份、已读/结算或驻留时间；详见[文字契约](text-readability-contract.md)。

[陪伴邀请](companionship-contract.md)是独立本地互动，不进入本 protocol 的提醒类别、领取、收件箱、已读或审批结算；任务及阅读占用出现时立即撤去邀请。今天安静只影响陪伴，不更改本契约的任务通知偏好。
