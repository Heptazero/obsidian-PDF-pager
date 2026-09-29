# PDF Pager (hz)

在 Obsidian 原生 PDF 标签页上提供单页阅读、阅读进度、书签和页面显示宽度控制。插件不修改 PDF 文件。

- 默认每次只显示一张 PDF 页面，横竖屏都居中；旋转后保持同一页。
- 底部按钮翻页、输入页码、添加/查看/删除书签，显示阅读百分比。
- 宽度滑块设置页面的最小显示宽度（当前适配方式为 100%）。双指可以继续放大，缩小到这个下限即停止；拖动滑块时保留高于下限的双指放大倍率。“适合整页”和“适合宽度”会重置到新的适配基准。
- 普通打开 PDF 时恢复最近一次阅读页；显式 PDF 页码链接优先。
- 仅在聚焦的 PDF 标签页实际翻页后保存进度，避免后台标签页关闭覆盖记录。

进度和书签按 PDF、按设备分别存放在 vault 的 `99_assets/plugin-data/pdf-pager/*.json`，读取时合并。因此同步软件必须包含该目录和 JSON 文件；Obsidian Sync 需要允许同步“其他文件类型”。同时离线阅读同一 PDF 时，以设备记录的时间戳较新者为准，设备时钟严重不一致会影响判断。

本插件使用 Obsidian 未公开的 PDF.js 阅读器接口。Obsidian 更新后，如单页模式或页码获取失效，需要调整 `src/native-viewer.ts`。

## 安装

### BRAT

在 BRAT 中选择“添加测试版插件”，仓库地址只输入 `Heptazero/obsidian-PDF-pager`。不要附带中文逗号、Markdown 链接格式或 `/releases/tag/0.1.0`。安装后在 Obsidian 的社区插件设置中启用 **PDF Pager (hz)**。

### 手动安装

从 [GitHub Releases](https://github.com/Heptazero/obsidian-PDF-pager/releases) 下载 `manifest.json`、`main.js` 和 `styles.css`，放入 vault 的 `.obsidian/plugins/pdf-pager-hz/`，然后启用插件。更新时替换这三个文件并重新加载插件。

首次公开版本尚未完成真实手机触控验收。建议先用一份熟悉的 PDF 测试横竖屏切换、双指缩放、翻页居中和续读。

开发：`npm install && npm test && npm run build`。
