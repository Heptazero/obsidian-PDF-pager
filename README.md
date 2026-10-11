# PDF Pager

Read PDFs page by page in Obsidian, with mobile landscape paging, resume position, bookmarks, and page-width controls.

## Features

- Keeps one PDF page centered and restores the page and in-page position after rotation or reopening.
- Splits tall pages into screen-sized stops on mobile landscape, recalculating stops after pinch zoom.
- Provides compact mobile controls, keyboard paging, bookmarks, reading progress, and a minimum-width zoom floor.
- Records active reading sessions per device and provides a foldable daily log with a color-coded weekly chart.
- Manually settles a day's total time and page range into the linked book note; settling again updates the same row.
- Stores reading records per device and supports a custom vault-relative records folder for third-party sync tools.
- Works offline and contains no network requests, accounts, advertisements, or telemetry.

The plugin uses Obsidian's internal PDF.js viewer interface. An Obsidian update may require a compatibility update to this plugin.

## 中文说明

在 Obsidian 原生 PDF 标签页上提供单页阅读、阅读进度、书签和页面显示宽度控制。插件不修改 PDF 文件。

- 默认每次只显示一张 PDF 页面，横竖屏都居中；旋转后保持同一页和页内位置。
- 移动端横屏时，较高的竖向 PDF 页面会按屏幕高度分成数个阅读屏；底部按钮先翻“上一屏/下一屏”，到页边后才进入相邻 PDF 页面。
- 分屏按当前缩放后的实际像素位置计算，页面内会显示虚线分界和屏序号；捏合缩放后分界会重新计算。
- 移动端默认用右侧窄控制栏导航：上方左箭头翻上一屏，中间显示当前屏数并可展开完整控制条，下方右箭头翻下一屏；长按约半秒可拖动控制栏，松手后保留位置；不在 PDF 正文上铺点击翻页层，避免影响划词。
- 桌面端或连接键盘时，`←` / `PageUp` 翻上一屏（上一页），`→` / `PageDown` 翻下一屏（下一页）；也可在 Obsidian 设置 → 快捷键中修改“PDF：上一屏/上一页”和“PDF：下一屏/下一页”。
- 底部按钮翻页、输入页码、添加/查看/删除书签，显示阅读百分比和当前分屏位置。
- 宽度滑块设置页面的最小显示宽度（当前适配方式为 100%）。双指可以继续放大，缩小到这个下限即停止；拖动滑块时保留高于下限的双指放大倍率。“适合整页”和“适合宽度”会重置到新的适配基准。移动端宽度面板会居中并隔离边缘拖动，避免误展开 Obsidian 侧边栏。
- 普通打开 PDF 时恢复最近一次阅读页；显式 PDF 页码链接优先。
- 仅在聚焦的 PDF 标签页实际翻页后保存进度，避免后台标签页关闭覆盖记录。
- 自动记录聚焦 PDF 的阅读时段；切换标签页或应用进入后台时暂停。默认连续 5 分钟无操作后暂停，也可在设置中改为 10、15 或 30 分钟。
- 左侧栏的柱状图按钮或命令“打开 PDF 阅读日志”可打开日志页。今天、昨天和本周均可折叠；本周柱状图按书籍使用不同颜色，书籍卡片可展开查看每次阅读的时间、时长和起止位置。页码跳转只表示位置变化，不代表逐页读完中间所有页面。
- “结算今天”会把当天总时长和起止页写入关联书籍笔记的 `## log`。例如 `- 1008 [20-43] [1.3h]`。结算行带有隐藏标记；之后继续阅读时再次结算，会覆盖当天总数并保留下面缩进的感想。
- 插件会优先查找引用当前 PDF 的书籍笔记。无法唯一确定时，在日志卡片点击“关联书籍笔记”选择一次；关联关系保存在插件 `data.json` 中。

进度、书签和原始阅读时段按 PDF、按设备分别存成 JSON，读取时合并。默认目录是 `.obsidian/plugins/pdf-pager-hz/records/`；可在 PDF Pager 设置中改成任意 Vault 内文件夹，例如 `99_assets/plugin-data/reading-records`。记录文件使用“PDF 名称 + 路径标识 + 设备标识”命名，例如 `盲视__141e6635ab363461__设备-xxxxxxxxxxxxxxxx.json`；路径和设备标识用于区分同名 PDF 及不同设备。升级后会在插件加载时自动迁移旧的纯哈希文件名，不改变记录内容。修改目录时会把已发现的旧记录复制过去，不删除原文件。两台设备必须设置相同目录，并让同步软件包含该目录；等待同步后重新打开 PDF 或再次结算即可使用最新数据。设备写入新进度时会先读取已同步记录并生成更高版本时间，减少设备时钟偏差导致旧进度获胜的问题。从 `0.1.7` 起，插件仍兼容旧版 `99_assets/plugin-data/pdf-pager/` 中的记录。

本插件使用 Obsidian 未公开的 PDF.js 阅读器接口。Obsidian 更新后，如单页模式或页码获取失效，需要调整 `src/native-viewer.ts`。

## 安装

### BRAT

在 BRAT 中选择“添加测试版插件”，仓库地址只输入 `Heptazero/obsidian-PDF-pager`。不要附带中文逗号、Markdown 链接格式或 `/releases/tag/0.1.0`。安装后在 Obsidian 的社区插件设置中启用 **PDF Pager (hz)**。

### 手动安装

从 [GitHub Releases](https://github.com/Heptazero/obsidian-PDF-pager/releases) 下载 `manifest.json`、`main.js` 和 `styles.css`，放入 vault 的 `.obsidian/plugins/pdf-pager-hz/`，然后启用插件。更新时替换这三个文件并重新加载插件。

更新 Obsidian 后，建议用一份熟悉的 PDF 复查横竖屏切换、双指缩放、翻页居中和续读，因为插件依赖未公开的 PDF 阅读器接口。

开发：`npm install && npm test && npm run build`。

## License

[MIT](LICENSE)
