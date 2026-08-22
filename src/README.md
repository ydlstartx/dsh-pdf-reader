# Source architecture

`dsh-pdf-reader` 是一个 DeepSeek Harness 双面插件：根目录下的 TypeScript 运行在主机侧，`client/` 构建为浏览器侧阅读器。两侧通过 Harness 提供的公开接口交换有界索引、OCR 授权和页面结果。

## 主机侧

- `index.ts`：插件入口，注册 PDF 文档工具、OCR 授权代理和惰性资源路由
- `limits.ts`：文件、Canvas、索引和资料等共享资源边界
- `pdf-format.ts`：PDF 输入格式校验
- `pdf-document-index.ts`：按对话保留的多文档原生文字索引、容量边界与来源链接协议
- `pdf-ocr.ts`：OCR 授权、预算和浏览器代理协议

## 浏览器侧

- `client/index.ts`：浏览器入口，注册 Harness 插槽并连接主输入框
- `client/PdfPanel.tsx`：多文档标签、文件生命周期和阅读窗口
- `client/PdfViewer.tsx`：pdf.js 页面渲染、选择、截图、缩放、旋转和虚拟化
- `client/PdfOutlineSidebar.tsx`：目录、书签和搜索入口
- `client/PdfAnnotationDrawer.tsx`：批注中心
- `client/PdfEvidenceDrawer.tsx`：跨 PDF 图文资料及批量 AI 操作
- `client/PdfThumbnailDrawer.tsx`：虚拟化缩略图导航
- `client/PdfToggle.tsx`：打开或收起阅读器的浮动入口

## 主要模块

- `client/composer-*.ts`：文字、图片和图文联合请求与 Harness composer 的兼容边界
- `client/pdf-annotations.ts`、`client/pdf-annotation-save.ts`：批注模型、恢复与标准 PDF 写入
- `client/pdf-bookmarks.ts`、`client/pdf-outline.ts`：书签编辑和目录投影
- `client/pdf-evidence.ts`、`client/pdf-citations.ts`：图文资料、来源编号和回答回链
- `client/pdf-session-store.ts`：按对话持久化 PDF 标签、阅读状态和共享资料
- `client/pdf-document-index-sync.ts`、`client/pdf-background-index.ts`、`client/pdf-index-policy.ts`：浏览器与主机间的有界文字索引同步、空闲分批与图片文档探测策略
- `client/pdf-ocr-client.ts`、`client/ocr-runtime.ts`：用户授权后的按需 OCR、有界 LRU 页面缓存和运行时释放
- `client/pdf-search.ts`、`client/pdf-text-selection.ts`：原生文字搜索与选择
- `client/pdf-page-layout.ts`、`client/pdf-rotation.ts`、`client/geometry.ts`、`client/render-constraints.ts`：页面布局、坐标变换和资源约束
- `client/pdfjs.ts`：pdf.js、Worker 和内置二进制资源入口

构建由根目录的 `tsdown.config.ts` 生成主机入口、浏览器 bundle 和惰性 OCR 运行时；插件清单位于 `package.json` 与 `cordis.yml`。
