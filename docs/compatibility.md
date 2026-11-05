# DSH 兼容性自动检查

`.github/workflows/dsh-compatibility.yml` 每小时第 37 分钟读取官方 GitHub Release（含候选版）、npm latest/next 和官方 macOS ARM64 Desktop feed。手动执行可提供精确版本或 dsh-v tag，当前最高已支持版本也可演练。默认只检查高于当前精确支持列表最高版本的目标，每轮最多三个版本。定时运行在工作流合入 main 后生效，平台调度可能延迟。

## 检查与状态

每个版本一个 Issue；发布物身份包含 npm integrity、上游 Release/commit 与 Desktop ZIP SHA-512。只有仓库所有者及 GitHub Actions 机器人的有效状态标记参与去重。执行前先记录 running 与尝试次数；npm 和 Desktop 独立结算。

- 同一发布物已完成时不重复安装；仅新增 Release 元数据时更新报告。
- Desktop 后到时只补 Desktop，保留原 npm 检查的提交与运行身份。
- 网络或安装准备暂时失败、超时、中断及缺报告为 retry；至少六小时后重试，同一组件身份最多自动三次。明确断言、依赖冲突或完整性错误为 failed。手动精确版本可复验。
- 候选检查成功为 partial，不能替代最终提交的常规 CI 或正式支持声明。未知 Desktop 运行时必须审阅，不能自动放宽。

准备 job 在隔离副本更新精确 DSH 开发依赖、peer/engines 声明及 npm-shrinkwrap.json。保留原有支持和其他顶层依赖；旧 Host 锁解析重建，其他锁条目保留。正式源码与工作区在前后做摘要核对。若新版需要新的 Cordis／Schemastery 等依赖基线，报告冲突，由维护者审阅后调整。

基线和候选分别执行类型及单元检查，候选执行完整浏览器、通知与 test:inbox-ui。Linux 只构建一次候选 .tgz，三个安装 job 下载同一字节，验证摘要后分别在 Linux x64、Windows x64 与 macOS ARM64 运行真实 Loader、网页设置、通知／目标／会话契约、原生桌宠与恢复。未改声明的原包仍须通过官方准入判断拒绝未支持宿主。既有完整安装断言保留，候选没有跳过完成或接受回执检查。

Desktop job 在独立目录下载匹配的官方 macOS ARM64 ZIP，检查摘要、路径及符号链接、完整代码签名和 DeepSeek Team ID。当前审阅载体为 Electron 44.7.0 / Node 24.21.0 / libuv 1.52.1 / ABI 149。验证真实 ASAR 的 Host 契约，目标完成与会话契约也单独运行于真实 ASAR；随后在官方 Electron 中运行同包安装与桌宠联动，此完整 GUI 流程的 Web Host／Client 由对应 npm 产物提供，桌宠按产品正常路径使用其声明的独立 Electron 依赖。该自动化不声称驱动原生 Desktop shell、通知中心、真实账号模型或物理多屏／输入设备。

## 报告与提案

检查 job 仅有读取权限，环境剔除令牌及 API 凭据，使用临时 HOME、DSH_HOME 与 profile。默认分支的报告 job 才能更新 Issue、创建分支与 Draft PR；pull_request 只检查。流程直接串联候选验证，不依赖机器人 PR 触发第二轮 CI。

依赖提案只允许 package.json 与 npm-shrinkwrap.json，严格核对目标版本、基线 manifest、锁内 registry 来源和 integrity。已有提案或人工修改不自动覆盖。候选报告不自动修改正式分支、标记 Ready、合并、打标签或发布。报告保留来源提交、目标身份、包摘要、平台、阶段及对应 Actions 链接；报告、必要日志、失败截图和候选包保留 14 天，应用 ZIP、依赖、浏览器和测试会话不上传。

当前发布资格仍由 [发布流程](releasing.md) 的最终提交全量 CI、十八组同包安装和 npm／Release 字节核验决定。

## 本地执行

使用 `.node-version` 和 packageManager 固定工具链，先 npm ci --ignore-scripts。可只读发现：

```bash
npm run compat:discover -- --local
DSH_VERSION=0.2.1-rc.5 npm run compat:prepare
```

准备输出目录含 candidate.json、proposal.json、候选包、paper-star.zip 和 report.json。随后设置 DSH_TARGET_JSON 为发现的完整目标 JSON，DSH_CANDIDATE_DIR 为该输出目录，再运行 npm run compat:check；Desktop 检查使用 npm run compat:desktop，只接受匹配的官方 feed 身份。浏览器依赖须提前安装，使用 PLAYWRIGHT_BROWSERS_PATH 指向测试缓存。原生检查串行执行。

本地命令不写 Issue 或 PR。发现、状态与提案机制复用 dsh-session-bin / dsh-usage-state，MIT 许可保留在 scripts/compatibility/LICENSE；本流程不调用付费 AI 服务。
