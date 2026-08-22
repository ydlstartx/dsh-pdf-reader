# Security policy

## Supported versions

项目当前处于 Beta 阶段，只为最新发布版本提供安全修复。

## Reporting a vulnerability

请优先使用 GitHub 仓库 Security 页面中的 **Report a vulnerability** 私下报告。报告中请包含受影响版本、复现条件、潜在影响和最小复现样例。

如果仓库尚未启用私有漏洞报告，可以先创建一个不包含利用细节、凭据、真实 PDF 或个人数据的普通 Issue，请维护者提供私下沟通方式。不要在公开 Issue 中粘贴密钥、恶意 PDF 或可直接利用的完整步骤。

## Trust boundary

- PDF 字节、提取文字、批注和图片均视为不可信输入。
- 插件只在用户明确操作后把选定资料发送给当前 Harness 会话。
- OCR 默认关闭，并由单次、有时限且有预算的用户授权控制。
- 插件不会要求修改 DeepSeek Harness 源码，也不实现独立遥测。
