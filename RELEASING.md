# Release process

首个公开版本以 GitHub **Pre-release** 发布。不要从有本地残留产物的工作区直接上传 `lib/` 或手工压缩包。

## 发布前

1. 确认 `git status --short` 只包含计划发布的文件，且没有 `.env`、真实 PDF、用户对话或私人截图。
2. 更新 `package.json` 版本和 `CHANGELOG.md`，把 Unreleased 内容移入对应版本。
3. 运行低资源检查：

   ```sh
   pnpm verify
   git diff --check
   ```

4. 推送分支，等待 `CI` 工作流在 Node 24.9 和 Node 24 上通过。
5. 手工触发一次 `Harness browser compatibility smoke`，确认插件可在受支持的 Harness 版本中加载并完成浏览器兼容回归。
6. 手工触发一次 `Build release package`，确认正式构建和包内容检查通过。
7. 在干净的 DeepSeek Harness `0.2.2-alpha.2` profile 中安装工作流产物，完成阅读、批注、另存为、跨 PDF 图文提问和显式 OCR 授权的冒烟测试。

## 创建预发布版本

确认上述检查后创建并推送标签：

```sh
package_version="$(node -p 'require("./package.json").version')"
git tag -a "v${package_version}" -m "dsh-pdf-reader v${package_version}"
git push origin "v${package_version}"
```

标签会触发 `Build release package`：工作流从干净 checkout 安装依赖、验证、构建、检查 tarball，并创建带安装包的 GitHub Pre-release。

## 发布后

- 从 GitHub Release 下载而不是复用本地包，重新安装一次。
- 验证 README 安装步骤和包内 `LICENSE`/`THIRD_PARTY_NOTICES.md`。
- 记录已知问题；稳定性得到实际使用验证前不要去掉 Pre-release 标记。
