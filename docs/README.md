# 文档索引

本目录维护当前产品行为与开发契约。安装入口见 [项目首页](../README.md)，各版本改动见 [版本记录](release-notes.md)。实际版本、依赖、命令和支持的宿主列表以 `package.json`、`npm-shrinkwrap.json` 与 `.github/workflows/` 为准。

## 按任务阅读

| 任务 | 资料 |
|---|---|
| 安装、配置、操作与升级 | [使用指南](usage.md) |
| 开发、构建、测试与录制回归 | [开发指南](development.md) |
| 完成判断、通知身份与请求结算 | [提醒契约](notification-contract.md) |
| 会话续接、接受回执、草稿与去重 | [会话契约](session-chat-contract.md) |
| 进程退出、有限恢复与临时状态 | [恢复契约](desktop-recovery-contract.md) |
| 字号、阅读与输入状态保持 | [文字契约](text-readability-contract.md) |
| 显示器归属、坐标与拖放切屏 | [多屏契约](multi-display-contract.md) |
| NPC 日常、小窝、邀请与关系存档 | [自主陪伴契约](companionship-contract.md) |
| 本地诊断、采样与资源报告 | [诊断契约](diagnostics-contract.md) |
| 角色制作、API 2 与动作回退 | [角色接口](characters.md) |
| DSH 新版发现、隔离候选与兼容性报告 | [兼容性检查](compatibility.md) |
| 同包安装验证、npm 与 GitHub Release | [发布流程](releasing.md) |
| 首页展示素材的来源与重拍 | [素材说明](assets/README.md) |
| 源码、素材与依赖许可 | [第三方声明](../THIRD_PARTY_NOTICES.md)、[上游版本](../web/upstream/UPSTREAM.md) |

## 验证与产物身份

源码实现、自动化通过、安装成功、系统实机验收和用户体验分别报告。CI 的三平台测试及宿主安装矩阵以工作流实际结果为准；物理多屏／混合 DPI、通知中心送达、真实模型会话及长期资源表现需要对应设备和场景的记录。

正式发布使用 [GitHub Release](https://github.com/takboo/dsh-coopanion/releases) 中的版本、提交和包摘要核验；`verification.json`、`SHA256SUMS` 与版本包一起提供。本地试装包不代表该版本的正式分发产物。

仓库的 `docs/evidence/` 只保留历史原始证据，普通搜索及安装包均排除它。追溯时先读其说明并核对实际产物身份。`.cache/`、`artifacts/` 与 `dist/` 属于本机或生成内容，可能来自其他提交。
