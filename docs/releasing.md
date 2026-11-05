# 发布流程

发布使用仓库固定工具链和 `npm-shrinkwrap.json`。npm 包为 `@takboo/dsh-coopanion`，公开发布；配置 id 和设置 namespace 为 `dsh-coopanion`。分发保留 AGPL 对应源码、构建脚本、锁文件及第三方声明；历史证据和临时交接内容不进入安装包。

## 准备发布

1. 完成实现、测试与当前文档，按[开发指南](development.md)运行相关检查。
2. 增加 `package.json` 和 shrinkwrap 的版本，在 `docs/release-notes.md` 顶部新增对应 `# v<版本>` 节；同步首页与使用指南的精确安装版本。
3. 执行 `npm run verify:metadata`，提交并将发布提交合入 main，等待 main CI 通过。
4. 对实际发布提交创建新的稳定标签并推送：

```bash
git tag v<实际版本> <发布提交>
git push origin v<实际版本>
```

稳定标签新建 push 会派发 **main 上的 `release.yml`**。也可在 Actions → Release → Run workflow 选择 main，输入已有标签；默认 `mode=verify` 仅验证，选择 `publish` 才发布。发布授权应覆盖合并、标签及随后执行的 npm／GitHub Release 发布。

## 自动检查与同包分发

CI 在 Linux、macOS、Windows 上运行元数据、类型、单元、浏览器、键盘辅助进程及真实 Electron 窗口检查；宿主安装矩阵使用 `package.json` 声明支持的六版 DSH，三平台共十八组。实际配置以 `.github/workflows/ci.yml` 为准。Linux 窗口检查由 Xvfb + Openbox 提供隔离显示，原生桌面步骤保留进程日志并设置六分钟上限。

发布验证标签是 `origin/main` 的祖先、包与 shrinkwrap 版本一致且当前发布说明存在，然后检出不可变提交并重新执行完整 CI。PR 或 main 的先前测试结果不能代替标签上的发布检查。

Linux 构建并打包一次，成为规范产物。`npm pack` 产生的 `takboo-dsh-coopanion-<版本>.tgz` 只重命名为 `dsh-coopanion-<版本>.tgz`；固定别名通过复制获得。十八组安装、npm 和 Release 都消费这份压缩包，发布使用 `--ignore-scripts`，不会再次构建。

`verification.json` 绑定完整源码提交、版本、SHA-256 与 npm SHA-512 integrity；`dist/build-info.json` 记录产品输入摘要。生成正式报告要求干净、已提交的 checkout。构建摘要不代替完整 `.tgz` 的身份。

发布顺序为 **完整 CI → npm → GitHub Release**。npm job 使用 Trusted Publisher OIDC；Release job 独立拥有内容写权限。发布前再次核对标签没有移动。fork、其他分支、移动／删除标签和预发布标签不进入稳定版自动发布路径。

Release 附件包括：

- `dsh-coopanion-<版本>.tgz` 与相同字节的 `dsh-coopanion.tgz`。
- 示例角色 `paper-star.zip`。
- `SHA256SUMS`、`verification.json` 与仅当前版本的 `release-notes.md`。

`docs/release-notes.md` 是 Release 正文源；工作流提取当前版本节，不能只上传附件而省略正文。固定包名供市场的 `latest/download/dsh-coopanion.tgz` 使用。

## 失败与重跑

npm 上传后可能异步处理。发布后的 `--require-published` 对 404 每十秒重试、最多五分钟；不同字节占用版本、其他 HTTP 错误或超时均失败。上传前的版本检查只查询一次。

npm 成功但 Release 附档失败时，优先在 artifact 的七天保留期内重跑失败 job。重跑 publish 仅在 npm integrity 与规范包完全相同时跳过上传；字节冲突必须增加版本。已发布标签、包和原始报告保持不可变，不能本地重打包替换。

OIDC 认证失败时核对实际 Trusted Publisher 绑定和 job 日志。认证修复后仍沿用同一规范包；本地构建和安装成功分别记录，不能代替发布成功。

## 发布后核验

核对 npm 版本和 `latest`、Release 正文、版本包、固定别名、`verification.json` 及 `SHA256SUMS`。下载字节应与通过安装矩阵的规范包相同。新的核验使用独立记录并绑定本次提交和包摘要。

安装入口使用精确 `@takboo/dsh-coopanion@<版本>`。pnpm 的发布时间保护可能使裸包名暂时解析为旧版，详情页显示新版不证明安装了新版；检查隔离 profile 中的精确版本安装及实际日志。原因与操作见[使用指南](usage.md#安装版本与发布时间保护)。

## 社区市场

市场从社区目录读取条目，npm 发布本身不完成收录。仓库维护的条目为 [takboo__dsh-coopanion.yml](market/takboo__dsh-coopanion.yml)，使用固定 Release 下载地址；投稿按[社区贡献规范](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)核对，不修改生成文件。

新增版本继续维护 npm metadata、稳定标签、Release 正文与固定下载别名，无需重复提交目录条目。目录构建、版本探测和市场修改记录可能异步更新；若报告市场状态，应核对实际在线结果，不能从 npm 发布或目录 PR 推断已同步。
