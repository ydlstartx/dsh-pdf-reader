# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的结构，并使用语义化版本号。

## [Unreleased]

## [0.1.0-beta.5] - 2026-11-01

### Added

- 选中文字后弹出菜单里的“译”按钮：直接用 Harness 默认模型给出中英文单词/短语译文，结果显示在选段旁，不写入对话，也不需要输入框
- 新增主机路由 `/plugins/dsh-pdf-reader/translate`（同源、限长、20 秒超时）与共享的译文规整逻辑

### Changed

- 快速翻译复用默认模型的低推理档，避免长思考拖慢取词
- “译”按钮移到选区菜单的第一位，并保留与高亮工具之间的分隔

### Fixed

- 修复带命名目的地（`/Dest (锚点名)`）的 PDF 书签无法跳转：名称树的扫描不再有固定窗口上限，实测 193 条书签全部可跳转（此前 90 条失效）
- 修复双击取词无效：双击/三击时不再执行阅读器的光标归拢，浏览器原生的单词/整行选择得以保留并弹出菜单
- 书签目标额外兼容直接写页码索引的 PDF 生产工具
- 翻译返回非 JSON（例如主机进程尚未加载该路由，返回空 404）时改为报告 HTTP 状态，并提示重启 `dsh web`

## [0.1.0-beta.4] - 2026-11-01

### Changed

- 兼容性基线升级到 DeepSeek Harness `0.2.2-alpha.2`：`dsh.client` 契约、`engines.dsh`、Node.js 24 与 pnpm 11.28
- 阅读器改用右侧栏页签（`sidebar.right.pane.tab`）作为会话级宿主，浮动入口按右侧栏当前会话打开该页签；移除已删除的 `details` 插槽与 `ctx.layout.closeDetails()`
- 会话与对话访问迁移到 `ctx.sessions` / 作用域对话服务；主输入框附件接口由 `addImages` 改为 `addAttachments`
- 回答中的 `[图 N]` / `[文 N]` 回链改用对话行上的 `data-chat-turn` 定位来源批次，兼容折叠的过程分组
- 浮动入口只要求右侧栏已有会话，不再要求会话属于某个工作区

### Fixed

- 插件 bundle 的浏览器平台模块清单与 Harness 0.2 的一致（只保留 `PLATFORM_MODULES` 中的模块），修复 `require` 命中失败导致的加载失败
- `engines`/`peerDependencies` 与新运行时对齐，修复 profile 启动时因版本不满足而整包跳过的问题

## [0.1.0-beta.3] - 2026-08-22

### Added

- 多 PDF 标签、横向滚动标签栏和对话级恢复
- PDF 目录、可编辑标准书签、文本搜索、缩略图、旋转和缩放
- 高亮、下划线、删除线、备注、批注中心，以及另存为和显式覆盖原文件
- 图片选区、原生文字、跨 PDF 图文资料和可点击来源回链
- 用户明确授权、AI 选择页面的按需 OCR 与长文档资源预算
- 对话级 PDF 索引、共享资料和本地缓存的有界清理

### Changed

- 长 PDF 的原生文字索引改为空闲时分批构建；图片型长 PDF 只探测有限页数，后续页面仍须用户明确授权 OCR
- 主机索引按对话保留，允许同一对话包含多份 PDF，同时保留单对话文档数与全局文字容量边界
- OCR 页面缓存增加约 64 MiB、512 页的双重上限，并按最近使用顺序淘汰
- 更新开发依赖与兼容性基线至 DeepSeek Harness `0.1.1-rc.2` 和 pnpm 11
- 使用新版 Harness 界面重新生成 Dive into Deep Learning README 演示截图
- CI 在 Node 24 增加正式 bundle 冒烟，并提供每周及手动 Harness 浏览器兼容回归

### Fixed

- 虚拟化缩略图离开可视窗口后及时释放 pdf.js 页面资源
- Harness 浏览器兼容回归会先完成首次引导，并在全新 profile 中建立工作区和会话，再打开 PDF

### Security

- PDF 内容、批注与图片均作为不可信资料进入 AI 链路
- 文件头、大小、来源、请求方法和 OCR 授权均进行显式校验
- 浏览器侧资源对 PDF 字节、页面窗口、Canvas、资料数量和索引输出设置上限
