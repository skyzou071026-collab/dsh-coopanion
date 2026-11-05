# 角色对接：Coopanion API 2

插件直接使用 [Coopanion 固定版本](../web/upstream/UPSTREAM.md) 的角色运行时和沙箱协议。新角色通过 `figure.json` API 2 对接，不使用旧 `.dshpet` 或关键帧 schema。

## 包结构与导入

```text
my-character/
  figure.json
  figure.js
  model.json       # 可选
  textures/        # 可选
  sounds/          # 可选
  README.md
  LICENSE
```

压缩为 ZIP 后从角色面板导入。清单可以位于根目录，也可以包含最多三层外包装目录；一个 ZIP 只放一个角色。相同 id 的导入更新该角色，点击使用后应用新版本。内置 `whale`、`coo` id 保留。

压缩与解压总量均不超过 128 MiB，最多 2048 项，单文件最多 16 MiB，清单最多 256 KiB。拒绝绝对路径、目录穿越、反斜线、控制字符及特殊 URL 路径。打包脚本拒绝符号链接。

```bash
npm run build
npm run character:pack -- examples/star paper-star.zip
```

## 清单

最小示例见 [examples/star/figure.json](../examples/star/figure.json)。必填版本是 `manifest: 2`、`api: 2`；id 使用小写字母、数字和连字符，最多 32 字符。`name`、`about` 为语言到文本的映射，展示优先中文，回退英文或第一个值。

`entry` 指向包内 JavaScript ES 模块，`export` 是工厂函数名。`model` 可选，指向包内 JSON，由宿主读出后传给工厂。

`vocab` 声明角色理解的表情和动作，每项有 `id`、`kind`（expression / motion）、`names`、`about`、`seconds`，可选 `lasting`。面板按词表提供动作预览；宿主只调用清单和角色实际声明支持的词。

`axes` 定义换装维度及选项，`presets` 定义各轴的组合。预设使用自身 id；自定义组合使用各轴选项 id，按 axes 顺序以 `-` 连接。选项 id 本身不能包含连字符。面板支持预设及多轴独立选择，搭配随角色选择保存。

`sounds` 将音效名映射到 `{ file, kind, volume }`，文件为 OGG / MP3 / WAV，kind 为 move / touch / face / snore。宿主加载并播放，遵循统一音效开关。`can.walk` 声明是否支持移动。

## 工厂接口

```js
export async function createMyBody(base, { model, scheme, kit, loadImage, asset, host }) {
  const figure = await createMyFigure({ model, scheme, loadImage, asset });
  return kit.createBody(host, { figure });
}
```

`base` 是该角色资源的 URL；`asset(path)` 生成包内资源 URL，`loadImage(url)` 加载可用于 WebGL 的图像。角色不能自行 `fetch()` 模型或外部数据，应使用传入的 `model`、`loadImage` 和 `asset`；包内模块之间可以相对 import。模型和音效由可信宿主读取。

`host` 提供：

- `root`：绘制根元素，覆盖活动区域。
- `bounds()`：`{ W, H, floorY, S }`，单位为屏幕像素；角色逻辑坐标在 256 单位空间内，S 为缩放。
- `start`：初始 x、朝向等。
- `emit(kind, detail)`：动作结束、抵达、触摸或模式事件。
- `sound(name, kind, ...args)`：请求宿主播放音效。

推荐复用 `kit.createBody()`，即可获得共享动作、表情、粒子、视线、说话脉冲、走动、拖拽和重力。角色负责绘制；[SVG 星星示例](../examples/star/figure.js) 展示 `figure.draw(group, face, frame)`，其中 frame 包括 `face`、`mode`、`t`、`blink`、`look`、`talk`、`gesture` 等。网格角色可使用 `kit.createRig()`；完整实现见 [原生大肥鱼](../web/upstream/whale/figure.js)。

也可实现自己的 body。必需方法是 `step(dt)`、`layout()`、`do(word)`；其余接口为可选：

```text
resize(), walk(x, run, id), stopWalk(id), pointer(type, point),
drop(point), shift(dx, dy), place(x, facing), set(state), cue(kind),
talk(), setScheme(id, {fade}), dispose()
```

`layout()` 返回位置、模式和交互区域：

```js
{
  x, facing, mode, busy, moving, pressing, cursor,
  box: {x, y, w, h},
  hit: [{x, y, r}],
  bubble: {x, y},
  side: {x, y, reach}
}
```

宿主校验区域大小和位置，仅在 box 与命中圆内接收角色点击；气泡跟随 `bubble`。角色移动和拖拽由 body 负责，宿主不再维护另一套运动轨道。

## Harness 状态映射

| Harness 状态 | 请求的角色词 | 附加状态 |
|---|---|---|
| 待机 | neutral | 可进行闲时活动 |
| 思考 | thinking | thinking=true |
| 生成 / 工具工作 | determined | expression=determined，生成时嘴部脉冲 |
| 等待确认 | worried | expression=worried，停止闲时活动 |
| 已提交目标完成 | happy | 2.5 秒后回待机 |
| 普通回合／目标中间轮回复 | neutral | 保留全文及未读，不触发成功庆祝 |
| 出错 | sad | expression=sad，停止闲时活动 |
| 用户休息 | sleep | 唤醒时 stand |

共享 kit 支持可选 `set({ expression })`（kit 表情名或 null）来保持任务神态，不重复触发表情音效；独立实现的 API 2 body 可处理或忽略该扩展。流式片段只驱动嘴部，最终回复用于说话和阅读。事件互动提示独立呈现审批、提问和各类回合结束，提供源会话与待处理列表入口。

未声明的词不会调用。拖动或空中动作结束后再应用待处理的任务表情。逐字显示每个非标点字符时调用 `body.talk()`，共享 kit 将其转换为嘴部脉冲；配合 Web Audio 合成音效，不是 TTS。点击、换装及动作预览不会发模型消息。

## 提醒动作与回退

角色显示时，每次事件互动按下表从左到右选择清单与 body 都支持的第一个词。若没有可用词，保留文字提示和待处理入口。持续任务神态仍按上表设置。

| 事件 | 候选词（按优先级） | 提示／入口 |
|---|---|---|
| 已提交目标完成 | happy → wave → neutral | 当前最终回复优先进入阅读气泡；其他目标完成可显示互动提示 |
| 普通回合／目标中间轮回复 | 无庆祝动作 | 保留阅读气泡及未读，文案见[提醒契约](notification-contract.md) |
| 审批 | worried → thinking → neutral | 下一步需要你确认；返回源会话处理 |
| AI 提问 | curious → thinking → worried → neutral | 问题预览及待处理列表 |
| 回合出错 | sad → worried → neutral | 返回源会话查看详情 |
| 用户停止（aborted） | nod → neutral | 先停在这里，随时继续 |
| 中断（interrupted） | confused → worried → neutral | 这段任务中断了，陪你回去看看 |
| 阻塞／输出上限 | worried → thinking → neutral | 查看下一步如何继续 |
| 待处理请求补提醒 | wave → worried → neutral | 刚才那件事，还等你看看；同一会话同时到期时显示数量 |

提示等待输入、阅读、拖拽及当前动作结束后呈现；减少动态效果时保留提示和状态，跳过提醒动作。打开或收起提示不会决定审批、回答问题或把最终回复标记已读。请求处理状态由 Harness 同步，已结算请求不会再次呈现排队提示。

## 隔离与许可

角色模块仅在 opaque-origin iframe 中执行，不具备外部网络、Node、Electron 桥或访问父页面 DOM 的权限。宿主只提供包资源、模型、边界和有限消息接口。原生 IPC 只接受主页面调用。

应用与上游代码采用 AGPL-3.0-or-later。角色作者应在清单和 LICENSE 中注明自己的代码与素材许可；应用许可不改变独立素材的权利。大肥鱼贴图在上游 AGPL 授权之外，完整声明见 [第三方说明](../THIRD_PARTY_NOTICES.md)。

[自主陪伴](companionship-contract.md)按词表组合有限日常，宿主负责动机、邀请和成长；角色包不持有这些权限。抚摸成长需要可信页面验证的真实轨迹，角色自行上报 touch 或预览动作不计入关系。当前任务神态／提醒动作仍优先。

NPC 日常复用水平定点 `walk`、按身份 `stopWalk`、姿态、表情与合成音效；输入感知和调度由可信宿主管理。缺词或无移动能力的角色按其清单和 body 能力降级，详见[自主陪伴契约](companionship-contract.md)。
