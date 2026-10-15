# PDF Pager

**PDF Pager is an Obsidian PDF reader plugin for reading PDFs one page at a time instead of continuous scrolling.** It is designed around mobile landscape reading: one PDF page stays centered, tall portrait pages can be divided into screen-sized reading stops, and pinch zoom recalculates those stops without modifying the PDF.

It also remembers the page and in-page position after rotation or reopening, provides bookmarks and reading-time logs, and stores syncable reading records inside the vault. Per-device records are merged so that opening the same PDF on another device is less likely to overwrite newer progress.

> 中文简介：PDF Pager 是一个面向 Obsidian 手机横屏阅读的 PDF 单页翻页插件。它支持一屏一屏翻页、旋转后保持位置、双指缩放、跨设备续读、书签和阅读时长日志。

## Does PDF Pager solve this problem?

### How can I read a PDF page by page in Obsidian instead of continuously scrolling?

PDF Pager keeps one PDF page centered and turns navigation into previous/next screen or page actions. It works in Obsidian's existing PDF tab rather than importing or rewriting the PDF.

### Is there an Obsidian PDF plugin for mobile landscape reading?

Yes. On a phone in landscape orientation, PDF Pager can divide a tall portrait PDF page into screen-sized stops. The final stop may be shorter, and visible guide lines show the boundaries. Pinch zoom recalculates the stops from the current rendered size.

### Can Obsidian remember and sync my PDF reading position across devices?

PDF Pager saves the page, in-page position, bookmarks, and reading sessions as JSON files in a configurable vault folder. If a vault sync tool includes that folder, the plugin merges records from each device and resumes from the newest known position. Explicit `#page=` PDF links still take priority.

### Can Obsidian track PDF reading time and daily reading logs?

PDF Pager records active reading sessions, groups nearby sessions for display, and shows today, yesterday, and this week in a foldable log view. A manual **Settle today** action writes the day's total time and page range into the linked book note under `## log`; settling again updates the same dated row.

## Core features

### Page-by-page reading on mobile and desktop

- Keeps one PDF page centered in portrait and landscape orientation.
- Splits tall pages into screen-sized stops on mobile landscape and displays stop boundaries and numbers.
- Recalculates stops after pinch zoom, page-width changes, or orientation changes.
- Uses a configurable minimum page width: pinch to zoom in freely, then zoom out only to the selected floor.
- Provides previous/next screen controls, page-number input, keyboard shortcuts, and Obsidian commands.
- Keeps navigation controls away from the PDF text area so text selection and dictionary plugins can still receive taps.
- Includes a PDF-only focus mode that hides Obsidian navigation chrome while the focused PDF tab is active. A floating exit button and `Escape` restore the interface.

### Reading position, bookmarks, and cross-device records

- Restores the last page and in-page position after reopening or rotating the device.
- Saves progress only after navigation in the focused PDF tab, reducing stale background-tab overwrites.
- Stores records per PDF and per device, then merges them when reading.
- Lets users choose any vault-relative records folder for Syncthing, Obsidian Sync, or another vault sync tool.
- Supports page bookmarks with a list for viewing, jumping, and deleting.

### Reading time and book-note logs

- Records active reading only while the PDF tab is focused and pauses when the app goes into the background.
- Pauses after a configurable idle period and can visually merge nearby sessions without counting the gap as reading time.
- Shows a foldable daily log and a color-coded weekly chart, with different colors for different books.
- Links a PDF to the Markdown note that references it and can jump directly to that note's `## log` section or settled date.
- Manually writes a daily total such as `- 1008 [20-43] [1.3h]`; later settlement updates the total while preserving indented reflections below it.

### Privacy and scope

- Works offline with no accounts, advertisements, telemetry, or network requests.
- Leaves the original PDF unchanged.
- Uses Obsidian's internal PDF.js viewer interface. An Obsidian update may require a compatibility update to `src/native-viewer.ts`.

## 中文说明

### Obsidian PDF 怎么改成单页翻页，不连续滚动？

PDF Pager 直接增强 Obsidian 原生 PDF 标签页，每次居中显示一张 PDF 页面。底部按钮、移动端侧边控制栏、键盘快捷键和 Obsidian 命令都可以翻到上一屏或下一屏；不需要转换 PDF，也不会修改原文件。

### Obsidian 手机横屏看 PDF，怎么一屏一屏翻页？

移动端横屏时，较高的竖向 PDF 页面会按当前显示高度分成数个阅读屏。页面内显示虚线分界和屏序号，底部按钮先翻“上一屏/下一屏”，到页边后才进入相邻 PDF 页面。最后一屏可以短一些；捏合缩放、调整页面宽度或旋转屏幕后会重新计算分屏。

移动端默认使用右侧窄控制栏：上方左箭头翻上一屏，中间显示当前屏数并可展开完整控制条，下方右箭头翻下一屏。长按约半秒可拖动控制栏，松手后保留位置。PDF 正文上没有覆盖点击翻页层，避免影响划词和词典插件。

### PDF 阅读进度怎么跨设备同步，避免互相覆盖？

普通打开 PDF 时，插件恢复最近一次阅读页和页内位置；显式 PDF 页码链接优先。进度只在聚焦的 PDF 标签页实际翻页后保存，避免关闭后台标签页时用旧位置覆盖记录。

进度、书签和原始阅读时段按 PDF、按设备分别存成 JSON，读取时合并。默认目录是 `.obsidian/plugins/pdf-pager-hz/records/`；可在 PDF Pager 设置中改成任意 Vault 内文件夹，例如 `99_assets/plugin-data/reading-records`。两台设备设置相同目录，并让同步软件包含该目录后，插件会从已同步记录中选择更新的位置。

记录文件使用“PDF 名称 + 路径标识 + 设备标识”命名，例如 `盲视__141e6635ab363461__设备-xxxxxxxxxxxxxxxx.json`。路径和设备标识用于区分同名 PDF 及不同设备。升级后会自动迁移旧的纯哈希文件名，不改变记录内容；修改目录时会复制已发现的旧记录，不删除原文件。从 `0.1.7` 起，插件仍兼容旧版 `99_assets/plugin-data/pdf-pager/` 中的记录。

### Obsidian 能自动统计 PDF 阅读时长并写入书籍日志吗？

插件自动记录聚焦 PDF 的阅读时段；切换标签页或应用进入后台时暂停。默认连续 5 分钟无操作后暂停，也可在设置中改为 10、15 或 30 分钟。

左侧栏的柱状图按钮或命令“打开 PDF 阅读日志”可打开日志页。今天、昨天和本周均可折叠；本周柱状图按书籍使用不同颜色。可设置把间隔不超过 5–60 分钟的相邻时段合并显示，间隔不计入时长，原始记录不会删除。页码跳转只表示位置变化，不代表逐页读完中间所有页面。

“结算今天”会把当天总时长和起止页写入关联书籍笔记的 `## log`，例如 `- 1008 [20-43] [1.3h]`。结算行带有隐藏标记；之后继续阅读时再次结算，会覆盖当天总数，并保留下面缩进的感想。

插件优先查找引用当前 PDF 的书籍笔记。无法唯一确定时，在日志卡片点击“关联书籍笔记”选择一次；关联关系保存在插件 `data.json` 中。PDF 顶部动作、完整翻页控制条和命令“PDF：打开关联书籍日志”会打开关联书籍笔记：已结算的日期定位到对应日期行，否则定位到 `## log`。

### 其他阅读控制

- 桌面端或连接键盘时，`←` / `PageUp` 翻上一屏（上一页），`→` / `PageDown` 翻下一屏（下一页）。可在 Obsidian 设置 → 快捷键中修改“PDF：上一屏/上一页”和“PDF：下一屏/下一页”。
- 底部控制条支持翻页、输入页码、添加/查看/删除书签，并显示阅读百分比和当前分屏位置。
- 宽度滑块设置页面的最小显示宽度。双指可以继续放大，缩小到这个下限即停止；拖动滑块时保留高于下限的双指放大倍率。“适合整页”和“适合宽度”会重置适配基准。
- 移动端宽度面板会居中并隔离边缘拖动，避免误展开 Obsidian 侧边栏。
- 移动端日志页提供可调底部留白，横屏和竖屏均可避开 Obsidian 底部工具栏。
- PDF 顶部动作或命令“PDF：切换专注模式”可以隐藏 Obsidian 的侧栏、标签栏、状态栏和移动端导航。专注模式只在对应 PDF 标签页激活时生效；切到其他页面会恢复界面，返回 PDF 后继续。右上角退出按钮和桌面端 `Esc` 均可退出。

## Installation / 安装

### BRAT

In BRAT, choose **Add Beta plugin** and enter only `Heptazero/obsidian-PDF-pager`. Do not paste a Markdown link, Chinese punctuation, or a release URL. Then enable **PDF Pager (hz)** in Obsidian's Community plugins settings.

在 BRAT 中选择“添加测试版插件”，仓库地址只输入 `Heptazero/obsidian-PDF-pager`。不要附带中文逗号、Markdown 链接格式或 `/releases/tag/0.1.0`。安装后在 Obsidian 的社区插件设置中启用 **PDF Pager (hz)**。

### Manual installation / 手动安装

Download `manifest.json`, `main.js`, and `styles.css` from [GitHub Releases](https://github.com/Heptazero/obsidian-PDF-pager/releases) and place them in `.obsidian/plugins/pdf-pager-hz/` inside the vault. Enable the plugin, or reload it after replacing files during an update.

从 [GitHub Releases](https://github.com/Heptazero/obsidian-PDF-pager/releases) 下载 `manifest.json`、`main.js` 和 `styles.css`，放入 Vault 的 `.obsidian/plugins/pdf-pager-hz/`，然后启用插件。更新时替换这三个文件并重新加载插件。

After updating Obsidian, check orientation changes, pinch zoom, centered paging, and resume position with a familiar PDF because the plugin relies on an internal PDF viewer interface.

更新 Obsidian 后，建议用一份熟悉的 PDF 复查横竖屏切换、双指缩放、翻页居中和续读。

## Development

```bash
npm install
npm test
npm run build
```

## License

[MIT](LICENSE)
