# 会话直接续接契约

支持 DSH `0.2.0-rc.2`、`0.2.1-alpha.1`、`0.2.1-rc.1` 、`0.2.1-rc.2`、`0.2.1-rc.3` 和 `0.2.1-rc.5`。共享线协议定义在 [chat-contract.js](../web/chat-contract.js) 和[类型声明](../web/chat-contract.d.ts)，Host 准入在 [chat.ts](../src/chat.ts)，Client 草稿状态在 [session-ui.js](../web/session-ui.js)。

## 消息与回执

Renderer 生成一次提交的请求身份，经 preload → Electron main → Host 原样传递：

```json
{"type":"chat","sessionId":"exact-session-id","requestId":"client-generated-uuid","text":"用户消息","clientTimeZone":"Asia/Shanghai"}
```

文本去除首尾空白，非空且不超过 2000 个 JS 字符；请求 ID 为 1–128 个字母、数字、冒号、下划线或连字符。时区规范化为有效 IANA 时区或 UTC。目标身份不截断、不从当前关注会话重新推导。未知字段、无效身份和空文本不准入。主进程同时验证 IPC 来自自身主 frame，Host 再验证共享请求。

Host 返回同一完整 `sessionId` 和 `requestId`：

```json
{"type":"chat-result","sessionId":"exact-session-id","requestId":"client-generated-uuid","status":"accepted"}
{"type":"chat-result","sessionId":"exact-session-id","requestId":"client-generated-uuid","status":"failed","code":"session/writer-held"}
```

`accepted` 只证明消息已进入目标 Agent 收件队列，或同一身份已经准入。它不是任务完成、模型成功或磁盘 flush 屏障。完成、错误、目标状态、审批及提问继续以 Harness 的正式事件结算；没有自动审批或额外 Agent 调度。

## Host 准入和重试

1. 通过公开 `sessionQuery.observeSession` 读取目标普通会话，检查完整 header 身份和 cwd，拒绝子代理。查询缺失服务、缺失或已删除目标均反馈失败。
2. 同一目标的准入串行执行。复核 `user/message` 和所有 `agent/inbox/spliced.inserted` 中客户端 `source.rpcId` 对应的文本及时区；完全相同返回接受，不再写入，身份冲突返回 `coopanion/request-conflict`。检查包括已经领取或取消的收件记录；重试不会复活用户另行取消的队列消息。
3. 新请求核对公开模型投影 `modelSelection.next`（未选择时使用公开模型目录的默认项）是否仍在可路由目录。没有可用模型明确返回 `session/model-unavailable`，不为会话替换模型。
4. 调用公开 `sessionController.prompt`，固定 `mode: queue`、准确文本和时区。由控制器恢复冷会话及其正式 preset、模型、工具和权限；不创建替代会话、不使用已有 Agent 的直接 `followup()` 作为回退。
5. 保留控制器错误码，包括占用、权限限制、缺失会话与暂时不能接收。其他失败使用明确的不可用反馈。取消在准入前生效；宿主控制器在 `prompt` 开始之后不再观察 caller signal，已接受消息仍报告接受，后续取消任务由 Harness 负责。

宿主控制器仅检查当前 inbox 和 `user/message`，无法覆盖“已领取、尚未写入 user/message”的间隙，异步准入也存在并发窗口。持久收件记录复核与串行化均为必要行为，不能删除为单纯依赖控制器去重。Host 内保留最近 512 个请求身份用于跨目标冲突检查；重启后的去重依据目标会话中实际保留下来的正式记录。不同目标使用不同请求 ID。

## 草稿和显示

每个会话独立保存当前窗口内的草稿与提交状态。发送时固定请求内容、时区和目标，快速重复点击被发送状态拦截；切换关注会话不改变在途请求。草稿在收到完全匹配的接受回执后才清空。失败或 15 秒未收到回执保留草稿，重试使用原身份；修改正文再发送成为新请求，新消息即使正文相同也使用新 ID。接受状态不被迟到失败覆盖。

从收件箱或完整回复选择“继续对话”会显式选择该来源会话并打开桌宠输入框；“打开源会话”仍可从聊天框返回 Harness。显式切换后保留最近一次选择，直到 Host 快照确认目标或目标从列表消失；切换前排队的已读或状态快照不能把输入、草稿及导航退回旧目标。确认后继续接收 Host 的后续选择变化。阅读本身不切换关注会话，正在阅读的正文保持其捕获快照，新结果另计未读。草稿只保留在当前窗口运行期，重载或关闭后丢失。

启动时通过正式列表与查询恢复最多 100 个最近的普通会话，不激活冷 Agent、不调用模型，历史回复作为已读基线。Agent 分离不证明持久会话被删除，保留其续接入口；实际提交时重新核对目标是否仍存在。不可用目标保留明确失败反馈，不改投其他会话。

恢复只重建原生视图，Host 重新发送当前快照，不重新执行上述历史查询或聊天提交。崩溃前已接受消息仍在 Harness 队列，未收到接受回执的 renderer 草稿会随窗口丢失；恢复不会推断成功或自动重放输入，用户可回到源会话核对。跨进程草稿持久化仍在范围外，详见[恢复契约](desktop-recovery-contract.md)。

[文字缩放](text-readability-contract.md)只改变当前 Renderer 的样式与面板测量，保留草稿、在途请求及捕获正文；不产生新的发送、关注切换或已读确认。
