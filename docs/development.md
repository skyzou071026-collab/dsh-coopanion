# 开发与验证

先从[文档索引](README.md)阅读对应行为契约。工具链分别固定在 `.node-version` 和 `package.json#packageManager`，依赖锁为随包提供的 `npm-shrinkwrap.json`。

## 准备与验证入口

```bash
npm ci --ignore-scripts
npm run verify:metadata
npm run setup:electron
npm run typecheck
npm test
npm run build
npx playwright-core install chromium
npm run character:pack -- examples/star paper-star.zip
npm run test:ui
npm run test:notification-ui
npm run test:inbox-ui
npm run test:keyboard-native
npm run test:desktop
npm pack
node scripts/check-package.mjs
npm run test:install
```

按改动选择检查；完整发布门槛见[发布流程](releasing.md)。Linux 原生窗口需要 X11／Xvfb 和窗口管理器，测试光标还需要 Python 3 与 libX11；浏览器及网格动画需要 Chromium WebGL。CI 的 Linux 显示准备由 `.github/actions/setup-linux-display` 完成。

`npm run dev` 打开浏览器演示（默认 `http://127.0.0.1:4173`），`npm run demo` 启动桌面演示，二者的任务事件均为模拟。首页素材的重拍见[素材说明](assets/README.md)。

浏览器检查真实 API 2 动画、聊天、完整阅读、角色导入及脚本隔离；桌面检查真实 Electron 窗口、IPC、托盘和恢复；安装检查使用官方 DSH loader 安装实际 `.tgz`。用 `DSH_TEST_VERSION=<支持版本>` 选择宿主，用 `DSH_TEST_PACKAGE_DIR=<规范包目录>` 消费已有规范包及校验文件。完整平台／宿主列表以 CI 矩阵为准。

macOS CI 固定使用 `macos-15` Apple Silicon 标准 runner。浏览器回归结束后再执行原生桌面检查，保留既有执行顺序，系统桌面操作串行进行。三平台测试和十八组宿主安装保留全部断言与期限；本地 VM 验证仍单独记录实际系统、提交与包摘要。

真实轻抚回归在角色宽度的 20%／80% 位置间往返，保持每次十八个可信移动，避免窄幅轨迹在输入调度迟缓时衰减为无效手势。伪造事件拒绝、二十次反馈、增长冷却、500 ms 响应和原有等待期限继续检查，产品判定规则不变。

帧时间戳先于点击事件的回归使用角色已有的 `happy → nod → neutral` 短配方，专门检查时钟顺序、完成前不增长及完成后只增长一次。长舞蹈在低帧率下的物理播放可能合法超过该用例的十秒等待；长配方的完成、打断和增长仍由其他陪伴回归覆盖。产品二十秒活动期限及所有测试等待期限不变。

完成、打断与存档回归保留默认 `happy → dance → neutral` 长配方。该用例使用调度虚拟时钟，并通过 API 2 补充有效 `tick` 输入推进真实角色物理；每次等待输入处理回执，再读取角色实际报告的 `moving`。额外物理输入最多 400 × 50ms，回执与进度检查仍保留原十秒等待。角色实现、真实布局／事件及存档服务共同参与验证；渲染帧率与交互延迟继续由真实时间用例检查。

原生测试和安装使用隔离数据目录，系统桌面操作串行执行。CI 测试沙箱参数仅供隔离实例；普通安装保留 Chromium sandbox 与 contextIsolation，关闭 Node integration。测试通知适配器和模型答复器属于受控边界，不能代替通知中心实机送达或真实模型会话验收。

## 关键行为回归

| 改动 | 检查入口与范围 |
|---|---|
| 完成、通知与请求结算 | `npm test`、`test:n0`、`test:notification-ui`；宿主接口检查由安装入口执行 |
| 聊天、收件箱、字号、多屏、NPC 日常 | `test:inbox-ui`；会话与字号浏览器用例串行，初始化失败保留有界状态、控制台与截图 |
| NPC 配置 | `tests/npc-controls-ui.mjs`：关闭许可、quiet／interactive、热切状态保持与禁用上游随机漫游 |
| 异常查看与尺寸 | `tests/attention-size-ui.mjs`：通用异常回执、新修订、审批／提问与固定角色尺寸 |
| 拖放与小窝 | `tests/npc-drag-ui.mjs`：真实指针轨迹、两侧边缘、区域外停留、旧路线取消、按住及释放后小窝锚点 |
| 自主循环与互动存档 | `tests/npc-life.test.js`、`tests/npc-life-native.mjs`、`tests/companionship-ui.mjs`、`tests/companionship-native.mjs` |
| 原生冷启动 | `tests/lifecycle-startup-native.mjs`：受控 unknown／locked 与实际系统状态分别检查 |
| Windows 置顶 | `tests/always-on-top.test.js`、`tests/windows-topmost-native.mjs`：平台策略、寿命清理与真实 Win32 TOPMOST 丢失／恢复 |

原生 NPC 用例控制时钟、粗粒度输入和鼠标感知；身体移动及 arrived／interrupted 保持真实。受控循环通过与物理输入、自然体验分别报告。

Windows 置顶回归由 CI 的隔离 Windows runner 串行运行 `node tests/windows-topmost-native.mjs`。它启动真实 Electron 窗口，用 Win32 读取 `WS_EX_TOPMOST`，主动清除标志后核对恢复和前台焦点保持，并检查隐藏／显示、最小化／还原与正常退出。失败也保留 `artifacts/windows-topmost-native.json`，绑定实际提交、构建与 Electron 版本。系统置顶丢失为受控注入；它不代替 Windows 11 物理设备、独占全屏游戏或长期桌面体验验收。本地缺少 Windows VM 时可使用此 CI 检查，本地 macOS 原生测试仍使用主项目虚拟机。

Windows 的 125% 缩放与任务栏回归可在已登录、解锁的隔离控制台运行 `node tests/windows-geometry-native.mjs`。先通过系统显示设置选择 125%；脚本核对 Electron 读取的真实 DPI，不强制 Chromium 比例。它通过 Windows Shell API 切换任务栏自动隐藏、核对实际工作区及 viewport，再注入过期边界检查重同步与角色保持，结束时恢复原任务栏状态。NPC 时钟和感知为受控输入；这项 VM 检查不代替物理多屏或用户体验验收。RDP 会话不允许更改显示缩放时，先在虚拟机控制台设置并验证实际比例。

同一控制台运行 `node tests/windows-pointer-native.mjs` 可核对真实 125% 下的右键菜单及面板点击；在 100% 下用 `DSH_WINDOWS_EXPECT_SCALE=1` 明确对应预期比例。Windows 输入辅助线程先启用 Per-Monitor V2 DPI 感知，再使用 Electron 换算出的物理坐标移动并读回光标，避免 DPI-unaware 辅助进程的坐标虚拟化造成误判。此检查同时使用 OS 光标和 CDP 点击，不代替物理混合 DPI 实机验收。

小窝回归支持录制隔离页面，不录桌面其他窗口或音频：

```bash
DSH_HOME_MARKER_VIDEO=/absolute/path/drag.webm \
DSH_HOME_MARKER_TRACE=/absolute/path/drag.json \
node --test --test-name-pattern="home marker" tests/npc-drag-ui.mjs
```

默认不录视频。断言同时检查按住、拖动及松手后的锚点，并覆盖大尺寸及两端小窝设置。

## 键盘与生命周期

`test:keyboard-native` 启动当前系统的真实辅助进程，检查固定枚举、停用和清理，报告写入 `artifacts/keyboard-activity-native.json`。macOS 与可用 X11 需取得 active／idle；不支持的会话保守 unknown。Linux CI 在隔离 Xvfb 中设置 `DSH_KEYBOARD_TEST_X11_INPUT=1`，用 XTest 验证键盘触发、仅鼠标不触发和恢复 idle；日常会话不使用这个注入开关。

macOS 可在已解锁桌面运行普通沙箱探针：

```bash
DSH_LIFECYCLE_NATIVE_REAL=1 DSH_LIFECYCLE_EXPECT_STATE=unlocked \
node tests/lifecycle-startup-native.mjs
```

它要求真实初态已知、未挂起且键盘适配器 available。锁屏场景使用 `DSH_LIFECYCLE_EXPECT_STATE=locked`，在实际锁屏环境单独执行；探针不改变锁屏状态。物理键盘、跨应用、锁屏／休眠、远程会话与平台资源分别验证。

CI 的受控冷启动检查先启用 `DSH_LIFECYCLE_TRACE=1`，在退出消息、窗口关闭与进程退出边界记录阶段和资源类型，不记录路径、URL 或正文；随后关闭诊断入口再次检查，避免诊断代码的时序变化掩盖退出问题。两次均保留原有断言和退出期限，报告分别写入 `lifecycle-startup-traced.json` 和 `lifecycle-startup-native.json`。失败也写报告；原始断言与清理错误分别保留。普通沙箱实测不加载该诊断入口。

受控 macOS 检查退出超过 1.5 秒时，用系统 `sample` 对本次启动的隔离原生进程采样一秒，采集器自身最多运行三秒；原有十秒退出期限和失败断言保持不变，耗时只计进程退出。堆栈随 `lifecycle-shutdown-*.txt` 上传，用于定位窗口已关闭、`quit` 已触发后的原生停留；该探针没有用户会话或模型内容。

同一诊断入口通过 `uncaughtExceptionMonitor` 观察默认异常路径，只记录分类、错误码与源码文件名／函数帧，不拦截异常或关闭原生错误框；出现异常也判为失败。Windows 手动几何探针先等待首个本地页面加载完成，再刷新以注入受控时钟，避免窗口刚创建便取消尚未完成的首次导航。

CI 额外用 `DSH_LIFECYCLE_LATE_DISPLAY=1` 在原生窗口关闭后强制派发显示器更新，复现排队回调的寿命竞态；同样要求正常退出、无未处理异常，报告单独写入 `lifecycle-startup-late-display.json`。这是受控事件验证，不改变系统显示设置。

## 资源与诊断

先按[使用指南](usage.md#自主陪伴)核对开关，再按[诊断契约](diagnostics-contract.md)解释时长、缺口和报告状态。独立采样器 `scripts/sample-companion.mjs` 使用本地诊断接口及 OS 指标，不操作窗口、不读取聊天正文、不启动模型。

`scripts/measure-idle.mjs` 支持 `off`、`npc-day`、`npc-night` 的同机短时对照，使用固定随机种子与真实时间；`npc-controlled` 强制粗粒度 keyboard=idle，只用于区分输入阻塞。短测不能作为两小时或其他平台资源结论。

受控 Linux 观察使用 `scripts/run-resource-observation.sh`；按脚本参数提供隔离 DSH runtime、冻结包、完整来源提交和尚不存在的输出目录：

```bash
bash scripts/run-resource-observation.sh \
  --runtime /path/to/dsh-runtime \
  --package /path/to/frozen-package.tgz \
  --source-commit <包实际来源的完整提交> \
  --output artifacts/resource-observation-unique
```

VM 需图形依赖、Xvfb、Openbox、Python 3、procps 及固定工具链。观察器核对包内采样脚本，使用独立 profile，设置 `roam=true`、`companionship=interactive`、`diagnostics=true`；开始时用 CDP 证明渲染并设置随机源，周期采样交给同一独立采样器。默认预热 20 秒、采样至少 7200 秒、每 5 秒一次，首末各 1800 秒时间加权 RSS 增量 ≤20 MiB；NPC 覆盖、邀请落盘、存档与队列边界另行检查。`--seconds 60 --window 20` 仅做短检。

## 运行时与隔离

高频事件只发送动画元数据，完整结果在结果或已读状态变化时传输。角色脚本运行于 `sandbox="allow-scripts"` 的 opaque-origin iframe，仅通过有限协议交互；没有 Node、Electron 桥、外部网络或顶层导航权限。本地资源服务只监听 `127.0.0.1`，原生实例使用随机路径，写入校验可信页面来源。

上游代码和资源固定在仓库，不在启动时在线拉取；Electron 首次准备仍下载并校验运行时。插件不收集遥测，也不提供独立模型 API。许可及对应源码要求见[第三方声明](../THIRD_PARTY_NOTICES.md)。
