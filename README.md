# DeepSeek 大肥鱼

**让 Harness 的工作，有个看得见的小伙伴。**

大肥鱼住在你的桌面上，陪你一起用 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 工作。她会思考、挥手、陪你等结果，也会把回复和待办捎到桌边。双击她，就能接着刚才的对话聊下去。

[![Release](https://img.shields.io/github/v/release/takboo/dsh-coopanion?color=4d6bfe)](https://github.com/takboo/dsh-coopanion/releases/latest)
[![CI](https://github.com/takboo/dsh-coopanion/actions/workflows/ci.yml/badge.svg)](https://github.com/takboo/dsh-coopanion/actions/workflows/ci.yml)
[![License: AGPL v3+](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)](LICENSE)

[**下载插件**](https://github.com/takboo/dsh-coopanion/releases/latest/download/dsh-coopanion.tgz) · [快速开始](#开始一起工作) · [使用指南](docs/usage.md) · [更新记录](https://github.com/takboo/dsh-coopanion/releases/latest)

![大肥鱼从思考到收到回复，双击打开聊天并继续输入](docs/assets/showcase/companion.gif)

<sub>实际浏览器界面演示：思考 → 收到回复 → 双击继续聊。演示中的 Harness 任务事件为模拟。</sub>

## 她会做些什么？

### 桌边有个会回应你的小伙伴

眨眼、看向你、挥挥手，拖起来还会晃动、落地。点点她、打个招呼，或者换个模样继续工作。想安静一会儿，可以让她休息、关掉音效，或暂时隐藏。

还可以开启默认关闭的「自主陪伴」：从小窝出发，在屏幕底部慢走、观察、停留并返回；互动模式偶尔邀请你一起活动。你在工作、阅读或输入时，她会先让位。

### 工作到哪一步，一眼就知道

思考、生成回复、使用工具，都有对应的表情和动作。目标真正完成时，她才会开心庆祝；需要审批、回答问题或查看异常时，小信封会为你留着入口。

角色隐藏后，还可以按需开启 Harness 系统通知。审批和问题始终由你在 Harness 中处理。

### 把回复带回来，也把对话接下去

小信封收好不同会话的回复与待办。长回复可以展开阅读，支持 Markdown、表格和代码块；新消息到来时，正在读的内容保持原样。

双击打开聊天，选择一段会话就能继续，包括还没在 Harness 中打开的历史会话。消息沿用该会话的模型、工具和权限，后台任务不会抢走你正在聊的对象。

<p align="center">
  <img src="docs/assets/showcase/conversation.png" width="340" align="top" alt="大肥鱼聊天面板，保留选中的会话并继续输入">
  <img src="docs/assets/showcase/inbox.png" width="340" align="top" alt="多会话回复收件箱，提供完整阅读和继续对话入口">
</p>

### 换个模样，照你的习惯来

内置大肥鱼提供多套配色，可以预览动作，也能导入社区制作的角色包。角色大小和文字大小分别调整，小小一只也能把回复看清楚。

<p align="center">
  <img src="docs/assets/showcase/appearance.png" width="340" alt="角色面板中预览 Claude 配色与跳舞动作">
</p>

想制作自己的角色？从 [API 2 角色指南](docs/characters.md) 和 [最小示例](examples/star) 开始。

## 开始一起工作

需要 **DeepSeek Harness Desktop 0.2.0-rc.2、0.2.1-alpha.1、0.2.1-rc.1、0.2.1-rc.2、0.2.1-rc.3 或 0.2.1-rc.5**。这是 Harness 插件，聊天使用你在 Harness 中配置的模型，无需另填 API Key。

### 在 Harness 中从 npm 安装（推荐）

打开侧边栏 **插件 → 添加插件**，在「包名或地址」中填入：

```text
@takboo/dsh-coopanion@0.4.18
```

点击安装，完成后启用 `dsh-coopanion`，再完全退出并重新打开 Harness。

发布首日请保留上面的版本号。pnpm 11 默认等待新版本发布满 24 小时；仅输入包名可能选到旧版，即使详情显示最新版本。详见[安装版本与发布时间保护](docs/usage.md#安装版本与发布时间保护)。

### 使用 dsh 命令行安装

使用 **Desktop 自带的 `dsh` 命令**。先启动 Desktop 一次完成初始化，完全退出应用后执行：

```bash
dsh plugin --profile desktop add @takboo/dsh-coopanion@0.4.18
```

完成后重新打开 Desktop。其他 profile 的安装方法见[使用指南](docs/usage.md#通过-dsh-命令行安装)。

### 下载压缩包安装

[下载最新插件包 `dsh-coopanion.tgz`](https://github.com/takboo/dsh-coopanion/releases/latest/download/dsh-coopanion.tgz)，在 **插件 → 添加插件** 中填入压缩包的绝对路径，安装并启用，然后重启 Harness。

安装后在 **Settings → 桌宠** 查看运行状态。首次启动会在后台下载并校验 Electron 运行时，期间桌宠显示“正在启动”，Harness 可继续使用；网络受限时可按[运行时准备说明](docs/usage.md#electron-运行时准备)配置镜像或提前安装。

| 操作 | 会发生什么 |
|---|---|
| 单击角色 | 和她互动 |
| 双击角色 | 打开聊天；点击当前会话可换一段聊 |
| 右键角色 | 换装、休息、音效和其他偏好 |
| 点击小信封 | 查看回复、审批、问题和异常 |

系统通知与自主陪伴默认关闭，可在设置中开启。安静陪伴和互动陪伴统一使用小窝出发、探索并返回的 NPC 日常；关闭陪伴即停止自主活动。更多配置、CLI 安装和旧角色迁移见[使用指南](docs/usage.md)。

## 了解更多与参与

- **使用遇到问题：** 查看[使用指南](docs/usage.md)，或[提交 Issue](https://github.com/takboo/dsh-coopanion/issues)。
- **参与开发：** 从[开发指南](docs/development.md)开始，完整行为契约与验证边界见[工程文档索引](docs/README.md)。
- **查看改动：** 阅读[版本记录](docs/release-notes.md)。

支持平台为 Windows、macOS 和 Linux。物理多屏／混合 DPI、系统通知中心实机体验、真实模型会话及长期资源表现的验证范围见[验证说明](docs/README.md#验证与产物身份)。

## 致谢与许可

大肥鱼的动画与角色运行时来自 [Pal-AI-Lab / Coopanion](https://github.com/Pal-AI-Lab/Coopanion)。感谢原作者与角色创作者，让她有了灵动的表情、动作和配色。

组合程序采用 [AGPL-3.0-or-later](LICENSE)，保留原项目的 [MIT 署名](LICENSE-MIT)。角色贴图和商标有独立权利声明，详见[第三方声明](THIRD_PARTY_NOTICES.md)与[上游版本记录](web/upstream/UPSTREAM.md)。
