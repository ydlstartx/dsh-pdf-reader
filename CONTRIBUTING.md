# Contributing

感谢你帮助改进 dsh-pdf-reader。项目当前处于 Beta 阶段，提交应尽量保持插件与 DeepSeek Harness 源码解耦。

## 开发环境

1. 使用 Node.js `^22.19.0` 或 `>=24.0.0`，以及 pnpm `>=11`。
2. 运行 `pnpm install --frozen-lockfile`。
3. 日常验证运行 `pnpm verify`。
4. 只有在资源充足时运行 `pnpm check`；它会构建大型 PDF.js 和 OCR bundle。

## 提交要求

- 不要提交 `.env`、真实 PDF、用户对话、模型凭据或包含私人信息的截图。
- 不要通过修改 DeepSeek Harness 源码实现插件能力。
- 新增边界逻辑时补充 Node 测试；UI 交互改动应记录手工或自动化回归步骤。
- 保持 PDF 的阅读操作非破坏性；写入必须继续由明确的“另存为”或“覆盖原文件”触发。
- 说明对内存、Canvas、IndexedDB、AI token 和 OCR 页数边界的影响。

提交 Pull Request 前请运行：

```sh
pnpm verify
git diff --check
```

完整生产构建和浏览器回归会在发布环境中完成。
