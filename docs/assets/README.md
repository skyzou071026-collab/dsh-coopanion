# 项目首页素材

`showcase/` 的动图和三张截图来自本仓库的实际浏览器演示，使用内置大肥鱼和真实角色／聊天／收件箱界面。任务事件和会话内容由演示入口模拟，不是正式宿主或系统通知的验收证据。画面未替换产品文案或拼接虚构界面；静态图裁剪到角色与对应面板，动图缩放为 960×640。

素材使用的角色、贴图和运行时权利见[第三方声明](../../THIRD_PARTY_NOTICES.md)。

重新拍摄需先构建项目，安装 Playwright Chromium 和 FFmpeg；使用隔离的临时角色数据及随机回环端口，不访问用户的 Harness profile：

```sh
npm run build
npx playwright-core install chromium
# 使用现有 Chromium 时可设置 CHROMIUM_PATH 为可执行文件的绝对路径。
node scripts/capture-showcase.mjs
```

拍摄脚本会覆盖 `showcase/` 中的展示素材，并检查 Renderer 是否有未捕获错误；完成后关闭浏览器及本地服务，清理临时数据。macOS 若沙箱禁止 Chromium 的系统进程注册，应在允许启动浏览器的环境中运行。
