# 本地诊断与独立采样契约

本契约定义本地诊断接口与采样报告。诊断只用于解释资源与活动状态，不参与工作、互动、预算、成长或完成结算。

## 开关与数据

`diagnostics: boolean` 默认 `false`，沿 Host schema、设置表单、完整 DesktopOptions 与 ready／configure 热同步。热切不重建角色、阅读或输入 DOM，不重置草稿、选区、请求身份或气泡时钟。诊断与陪伴模式、通知及音效独立。

关闭时不提供诊断接口，不保存活动历史。开启时仅维护固定大小的活动／邀请计数，由外部请求拉取当前摘要；不新增周期采样定时器。关闭立即停止受理读请求，撤下发现文件和本地 socket，清空诊断活动计数；关系存档不受影响。

摘要包含可选 `npc` 固定字段：phase=home／prepare／outbound／observe／return／yield／resume；reason=none／disabled／input／unknown／pointer／work／user／lifecycle／geometry／capability；keyboard=active／idle／unknown；targetValid 与 compact 为布尔值。当前固定尺寸策略保持 compact=false；字段保留用于读取既有诊断格式，旧记录的 true 仍按旧包行为解释。不输出具体坐标、目标身份、按键内容或输入历史。另有可选 keyboardBackend=macos／windows／x11／none 和 keyboardStatus=disabled／starting／available／unsupported-platform／unsupported-session／missing-dependency／failed／stale／unavailable／protocol-error；仅说明适配器状态，不代表物理输入验收或已获某项权限。旧采样结果没有这些字段，不能据此推断 NPC 行为。

运行状态保留 screenLocked／systemAsleep 和可选 lockStateKnown 布尔值；启动前已经锁屏时先校验系统状态，不能只等待后续锁屏事件。macOS 只读取 CoreGraphics 当前会话的三个固定状态标记，Windows／Linux 使用原生系统空闲状态 API；初始状态未知时保持挂起，收到明确的锁屏／解锁事件后更新已知状态。隔离原生测试显式控制初态，正常安装不采纳测试覆盖值。启用诊断后用固定 locks／unlocks／suspends／resumes 计数记录系统事件，关闭诊断清零，进程重启另段结算。计数能反映两次读取之间的锁屏／休眠／唤醒，但不提供事件精确发生时间；休眠期间未采到的时间仍记为缺口。旧包缺少这些字段时不推断状态。

macOS 的字典键按 SDK `CGSession.h` 取值：`kCGSessionOnConsoleKey` 宏对应字符串 `kCGSSessionOnConsoleKey`，不能直接把宏名作为键。普通沙箱下，已解锁控制台启动应取得 `lockStateKnown=true`、`suspended=false` 并启动键盘感知；锁屏和不可确定状态仍挂起。开启 Interactive／漫游但持续显示 `reason=lifecycle` 时，先核对此状态，不能认作正常空闲或只要求用户等待。

摘要只含运行可见性／挂起、当前陪伴模式与片段、邀请状态、固定活动计数、有限队列／集合规模、存档修订与规模、Renderer 堆／DOM 数量及包版本／构建摘要。不得包含聊天／草稿正文、会话／互动身份、角色名字、文件内容、提示词或凭证。计数为有限诊断范围，不证明所有对象、定时器或队列。

## 只读接口

原生 main 拥有接口。POSIX 使用短路径 Unix domain socket，Windows 使用命名管道，不监听新的 TCP 端口，不开启 Chromium 调试端口，也不改变普通安装沙箱。每次启用生成新的随机会话和鉴权 token；发现文件位于用户目录 `.dsh-coopanion/diagnostics`，按数据目录摘要及 PID 区分实例。POSIX 目录为 0700，发现文件和 socket 为 0600。Windows 依赖用户目录 ACL，并仍要求随机 token。

仅支持带 Bearer token 的 `GET /snapshot`，拒绝 Origin、写方法和其他路径；不提供 CORS。单次响应不超过 32 KiB，一次至多一个进行中的读取，读取有界超时。关闭后的迟到结果不得继续返回成功或重新发布发现文件。主 frame 的有限 IPC 读取 Renderer 摘要，角色 iframe 没有该权限；响应按随机请求身份和固定 schema 校验，不执行角色代码。

存档 `inspect()` 直接读取已拥有的内存状态，不初始化存档、不获取写锁、不加入业务队列、不改修订和日期。Renderer 诊断同样不调用 read/select/chat、邀请预留或成长请求。正常退出清理本进程的发现文件；崩溃遗留文件不能使采样器误选其他实例。

发现列表是瞬时快照。枚举后已撤销的文件视为无可用实例；Windows 在撤销期间可能短暂返回 `EPERM`，0.4.12 起最多读取三次、间隔 50ms。持续不可读、无效描述符与 POSIX 不安全权限仍报错，不用旧描述符推断接口继续可用。

## 独立采样器

`scripts/sample-companion.mjs` 使用 Node 内置模块，通过本地接口及操作系统采集，不依赖 Playwright／Electron／CDP，不操作窗口或鼠标、不截图、不防休眠、不启动模型。当前 OS 资源采样支持 macOS／Linux；Windows 使用命名管道提供同一只读接口；独立 OS 资源采样尚未实现。

发现多个活动实例时要求 `--instance`，不猜测目标。读取身份与发现文件必须一致；输出采用字段白名单，排除 token、socket 路径及未知文字。进程／诊断会话／版本变化、接口关闭或长采样中断分段记录；不能拼接不同生命周期来声称连续两小时通过。

默认每 10 秒采样，默认请求时长 604800 秒（七天）；`--seconds` 可显式指定其他时长，并非硬性七天上限。原始日志默认上限 128 MiB，达到上限停止并明确标记。原始数据流式落盘，只在内存保留有界首／末窗口及至多 64 段摘要。数据可读时约每分钟更新 `progress.json`，不可用等状态变化写入 `events.ndjson`；最终 `summary.json` 记录完成、手动停止、缺口或失败。

采样时长与资源差分使用单调时钟；该时钟在部分平台的系统休眠中可能停走，固定日历截止可使用 `--until <含时区的 ISO 时间>`；到期按墙钟停止，包括接口不可用时，休眠跨过截止则在首次唤醒后停止。`--until` 和 `--seconds` 谁先到达谁结束；日历截止标为 reason=deadline，不能据此声明连续资源验收通过。脚本不安装后台服务或开机恢复；终端关闭、主机重启及托管方式属于启动方的责任。

日常模式的 `recorded` 只表示已记录数据，不代表验收通过；`fullTwoHourObservation` 表示时长、单段与窗口要求满足，也须结合 `status`、活动／邀请覆盖、队列边界和环境审阅。自主陪伴观察开始前，另从 Host 设置核对[开关组合](usage.md#自主陪伴)及实际活动可用性；当前诊断摘要不提供 `roam` 字段，仅凭 mode=interactive 或进程存活不能确认。配置漏开或持续占用的时间只保留为资源记录，不能补记为有效体验。

受控 VM 使用同一份包内采样器，开启严格模式，每 5 秒采样、20 秒预热后实际运行至少 7200 秒。首／末半小时的时间加权进程树 RSS 增量仍须 ≤20 MiB；中断／换代／不可用不计为连续通过。采样器逐段记录固定 NPC 阶段，完整覆盖需见 home／outbound／observe／return；旧三类片段计数不能代替 NPC 日常覆盖。严格模式若键盘为 active／unknown 会明确报场景不可用，不能把静止视为可用探索。退让／恢复由独立定向用例验证。旧版本按其三类片段范围判断，不能混用。还需检查邀请出现条件、邀请落盘与每日预算、存档边界和请求排空。CPU steal、内存压力与交换作为环境证据审阅，不从 VM 软件渲染数值推定实物 GPU 耗电。

## 来源与验收

`dist/build-info.json` 记录源码提交、是否有未提交变更和产品输入摘要；无 Git 的对应源码导出仍可重建，提交状态记为未知。实际 `.tgz` SHA-256 与采样器脚本摘要另行记录；不能用构建摘要代替完整包身份。

新诊断包重新运行受控观察；旧包只为其原始范围提供证据。日常体验通过实际使用和自然反馈判断，采样器的默认时长不构成体验验收要求。系统通知、多屏、锁屏／休眠及其他平台分别验收。诊断原始记录保持本地，不新增遥测或上传。
