# 多屏几何契约

支持的宿主版本见 `package.json`。一个透明原生窗口只覆盖一块显示器的 workArea；不使用所有屏幕的包围矩形，任务栏、菜单栏、负坐标、上下错位与工作区空洞不成为角色活动区域。保留 API 2 角色 frame、现有物理系统及脚本沙箱。

## 坐标与原生归属

Electron 44 的 `screen.getAllDisplays().workArea`、`getCursorScreenPoint()`、`BrowserWindow.setBounds/getContentBounds` 均以桌面全局 DIP 为单位。Renderer viewport、角色 bounds / layout / hit、指针 clientX/Y、面板锚点均以窗口本地 CSS 像素为单位。默认页面缩放 1 下，一 DIP 对应一 CSS 像素；`scaleFactor` / `devicePixelRatio` 表示栅格比例，不再次乘到窗口或角色坐标上。原生 cursor 减去**实际 contentBounds** 的原点后按 viewport 与 contentBounds 尺寸比换算，避免使用 DOM screen.availLeft 或全局 DIP × DPR。

Windows 的物理输入工具必须使用 Electron `screen.dipToScreenPoint`，不能把多屏全局 DIP 原点乘目标屏比例；macOS CoreGraphics 光标使用逻辑全局点；Linux X11 输入应按 Electron 转换（Wayland 的光标查询/转换能力未声明支持）。隔离测试 profile 只有同时启用测试沙箱参数与 debug port 时才加载只读坐标探针，preload 通过额外启动参数开放测试测量；普通安装及角色 frame 均没有该入口。不添加强制设备缩放参数。混合 DPI 的真实转换和点击必须另列原生实测，受控比例不能代替物理显示器。

Windows 测试输入与物理坐标读回在 Per-Monitor V2 DPI-aware 辅助线程中执行。停放光标也先将窗口内 CSS 点经同一原生探针转换为物理坐标。DPI-unaware 辅助进程的读数不能直接作为物理基准再次缩放。

原生归属记录完整显示器 ID。布局变化优先保留仍存在的当前 ID；移除当前屏后，从旧工作区中心选择最近有效 workArea，同距保持稳定。新增、移除其他屏不移动当前窗口；workArea / bounds / scaleFactor / rotation 更新重新核对当前屏与实际内容矩形。任务栏条带与布局空洞按到各 workArea 的距离选择，不能按所有屏幕包围盒命中。

拖拽在本地松手或取消时通过 API 2 drop 放下，不延续抛掷惯性；普通松手发出本地 `move-display`，主进程从真实原生光标选择目标，覆盖左右、上下与错位屏。托盘提供按显示器标签及 ID 的显式切屏入口，隐藏时切屏不改变显示意图；不依赖拖拽跨过空洞。显示器 ID 只在本进程保留，不新增持久配置。自由跨屏漫游、抛掷与贴边休息不在本项范围。

## 跨层消息与状态

Main → Renderer 使用同包消息 `display-changed { revision, displayId, workArea, contentBounds, scaleFactor }`；revision 在本代单调增加，初始化完成后补发最新状态。`cursor { x, y, revision }` 中 x/y 是该 contentBounds 内的 DIP，只有匹配 revision 的消息参与命中测试。Renderer 依据实际 viewport 做本地换算，丢弃旧几何和旧 cursor；不复用变更前的 stationary cursor / hit-state。

Renderer 订阅完成后通过独立的 `pet:geometry-request` 请求当前几何；Main 验证发送者是主 frame 后，重新读取实际 contentBounds 再重发。窗口 resize／resized／move 也重新核对边界。缺少几何或 viewport 与边界尺寸不一致时，Renderer 最多每秒重试一次，暂停 NPC 直到收到匹配状态；不以虚构显示器或零原点替代原生坐标，也不重载角色或正文。

窗口 resize 与显示消息可先后到达。只用当前实际 viewport 更新角色 bounds，角色异步返回新 frame 后重置面板锚点；跨屏按先前水平比例放回新工作区地面，当前屏缩放或工作区调整只夹入新 bounds，不启动新角色。几何变化打断正在拖拽的角色时，释放本地指针捕获，等新 bounds 到达后用 API 2 的 drop 直接安全落地，不先 pointer(cancel) 生成 throw；避免上游 place 在 drag 下被忽略而留下屏外命中区。已经松手的空中角色沿原物理系统在新 bounds 内落地，不扩展跨屏抛掷。面板按实际尺寸夹入 viewport，保留文字三档和长代码/表格的滚动。

切屏与布局变化只更新几何，不重建 Renderer、角色 frame 或正文，不调用内容 render；保留捕获阅读 DOM/正文、滚动像素偏移、草稿、焦点/选择、在途请求身份与气泡时钟，不增加 read/select/chat。不改变完成语义、准入去重、generation/visibilityRevision 和恢复基线、文字配置；崩溃后的临时状态丢失边界保持。

原生窗口销毁后解除显示器监听；已排队的布局刷新、回放、切屏与光标查询直接停止，不再访问已销毁的窗口或发送新几何。受控原生退出回归在窗口关闭后强制派发显示器更新，仍要求无异常、无强制终止并在原期限内退出。

## 验证边界

纯几何及原生控制器的注入布局测试由 `npm test` 执行；浏览器覆盖不规则布局、混合 DPR、状态保持与命中；原生／安装检查核对实际 screen、窗口、viewport、文字放大后点击及布局更新。三平台与宿主安装矩阵以工作流结果为准。

物理多屏、混合 DPI 与真实跨屏点击需要独立设备验证。Electron 坐标定义参见[官方 screen 文档](https://www.electronjs.org/docs/latest/api/screen)。
