import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import JSZip from "jszip";
import { epubBuild } from "../epub-build.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "pager-epub-browser-"));
const zip = new JSZip();
zip.file("mimetype", "application/epub+zip");
zip.file("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
zip.file("book.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>测试</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-11-02T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>');
zip.file("nav.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="a.xhtml">第一章</a><ol><li><a href="a.xhtml#p30">第一节</a></li></ol></li><li><a href="b.xhtml">第二章</a></li></ol></nav></body></html>');
for (const chapter of ["a", "b"]) zip.file(`${chapter}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter}</title><script>document.body.dataset.executed = "yes";</script><style>body { margin: 80px; } p { font-size: 14px; font-family: monospace !important; }</style></head><body><h1>${chapter}</h1>${Array.from({ length: 100 }, (_, i) => `<p id="p${i}"><span style="font-family: monospace">段落 ${chapter}-${i}：这是一段测试文字，用来验证横屏分页、字号、边距、稳定的位置和章节跳转。${"翻到下一屏仍然可以继续阅读。".repeat(5)}</span></p>`).join("")}</body></html>`);
const fixture = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
await build({ plugins: [epubBuild], entryPoints: ["tests/browser/epub-harness.ts"], bundle: true, outfile: path.join(directory, "test.js"), platform: "browser", format: "iife", alias: { obsidian: path.resolve("tests/browser/obsidian-stub.ts") } });
const script = await readFile(path.join(directory, "test.js"));
const css = await readFile("styles.css");
const font = process.env.PAGER_TEST_SERIF_FONT ? await readFile(process.env.PAGER_TEST_SERIF_FONT) : null;
const server = http.createServer((request, response) => {
  if (request.url === "/test.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); }
  else if (request.url === "/styles.css") { response.setHeader("Content-Type", "text/css"); response.end(css); }
  else if (request.url === "/fixture.epub") response.end(fixture);
  else if (request.url === "/fixture.otf" && font) response.end(font);
  else response.end('<html><head><meta name="viewport" content="width=device-width,initial-scale=1"/><link rel="stylesheet" href="/styles.css"/><style>:root{--background-primary:#fff;--background-primary-alt:#eee;--text-normal:#222;--background-modifier-border:#ccc;--text-muted:#666}body{margin:0}#host,.view-content{height:100dvh;width:100%;}button{cursor:pointer}</style></head><body><div id="host"></div><script src="/test.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.PAGER_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.evaluate(async () => {
    document.querySelector("#host").hidden = true;
    await window.harness.open();
  });
  assert.equal(await page.locator("iframe").count(), 0, "a hidden reader must not start at zero size");
  await page.locator("#host").evaluate((host) => { host.hidden = false; });
  await page.waitForFunction(() => window.harness.view.ready && !window.harness.view.reformatting, undefined, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.harness.view.toc.length), 3);
  assert.equal(await page.locator("iframe").count(), 1);
  const frame = page.locator("iframe");
  assert.equal(await frame.getAttribute("sandbox"), "allow-same-origin");
  assert.equal(await frame.evaluate((element) => element.contentDocument.body.dataset.executed), undefined);
  for (let attempt = 0; attempt < 4; attempt++) {
    const before = await page.evaluate(() => {
      const view = window.harness.view;
      view.turn(1);
      return view.location.cfi;
    });
    await page.waitForFunction((cfi) => window.harness.view.location.cfi !== cfi && !window.harness.view.moving, before, { timeout: 2500 });
    if (await page.evaluate(() => window.harness.view.location.percentage > 0)) break;
  }
  assert.ok(await page.evaluate(() => window.harness.view.location.percentage > 0));
  await page.evaluate(() => window.harness.view.flushProgress());
  const saved = await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress.epub);
  assert.ok(saved.cfi.startsWith("epubcfi("));
  const savedProgress = await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => !window.harness.view.reformatting && window.harness.view.rendition._layout.divisor === 2);
  await page.locator('[aria-label="展开阅读设置"]').click();
  await page.locator('[aria-label="单栏"]').click();
  await page.waitForFunction(() => !window.harness.view.reformatting && window.harness.view.rendition._layout.divisor === 1);
  assert.ok(await page.locator(".epub-pager-area").evaluate((element) => element.clientWidth <= 720), "single page keeps book-like line lengths on wide screens");
  await page.locator('[aria-label="双栏"]').click();
  await page.waitForFunction(() => !window.harness.view.reformatting && window.harness.view.rendition._layout.divisor === 2);
  await page.locator('[aria-label="双栏中缝"]').evaluate((slider) => { slider.value = "80"; slider.dispatchEvent(new Event("input")); });
  await page.waitForFunction(() => !window.harness.view.reformatting && window.harness.view.rendition._layout.gap === 80);
  const gap = await page.evaluate(() => { const frame = document.querySelector("iframe"); return frame.contentWindow.getComputedStyle(frame.contentDocument.body).columnGap; });
  assert.equal(gap, "80px", "double layout uses the actual requested column gap");
  assert.deepEqual(await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress), savedProgress, "column switches never advance synced progress");
  await page.locator('[aria-label="自动"]').click();
  await page.waitForFunction(() => !window.harness.view.reformatting);
  await page.locator('[aria-label="展开阅读设置"]').click();
  await page.screenshot({ path: "/tmp/pager-hz-epub-book-spread.png" });
  await page.locator('[aria-label="展开阅读设置"]').click();
  await page.locator('[aria-label="单栏"]').click();
  await page.waitForFunction(() => !window.harness.view.reformatting && window.harness.view.rendition._layout.divisor === 1);
  await page.setViewportSize({ width: 844, height: 390 });
  await page.evaluate(async () => {
    window.harness.mobile();
    document.querySelector("#host").style.cssText = "position:absolute;top:36px;bottom:0;height:auto";
    window.harness.view.contentEl.style.height = "100%";
    await window.harness.view.onUnloadFile();
    await window.harness.open();
    const toolbar = document.body.createDiv("mobile-navbar");
    toolbar.style.cssText = "position:fixed;inset:auto 0 0;height:56px;z-index:100";
    window.harness.layoutChanged();
  });
  await page.waitForFunction(() => window.harness.view.ready && !window.harness.view.reformatting && window.harness.view.rendition._layout.divisor === 2);
  await page.locator('[aria-label="展开阅读设置"]').click();
  assert.equal(await page.getByRole("group", { name: "页面栏数" }).count(), 0, "mobile hides the desktop layout controls");
  assert.equal(await page.getByLabel("双栏中缝").count(), 0);
  const focus = page.getByRole("button", { name: "进入专注模式" });
  await focus.tap();
  assert.equal(await page.getByRole("button", { name: "退出专注模式" }).getAttribute("data-icon"), "minimize-2");
  await page.getByRole("button", { name: "退出专注模式" }).tap();
  await page.getByRole("button", { name: "目录", exact: true }).tap();
  const chapter = page.locator(".epub-pager-toc-row", { hasText: "第一节" });
  await chapter.getByText(/\d+\.\d+%/).waitFor();
  assert.equal(await chapter.evaluate((row) => row.style.getPropertyValue("--epub-toc-indent")), "12px");
  assert.equal(await chapter.locator(".epub-pager-toc-dot").count(), 1);
  assert.equal(await chapter.evaluate((row) => getComputedStyle(row).borderRadius), "0px");
  await page.getByLabel("搜索章节").fill("第二章");
  assert.equal(await page.locator(".epub-pager-toc-row:visible").count(), 1);
  await page.evaluate(() => document.querySelector(".epub-pager-toc-list").parentElement.remove());
  for (const [label, value] of [["顶部留白", "16"], ["底部留白", "8"]]) {
    await page.getByLabel(label, { exact: true }).evaluate((slider, value) => {
      slider.value = value;
      slider.dispatchEvent(new Event("input"));
    }, value);
  }
  const positioned = await page.locator(".epub-pager-area").boundingBox();
  assert.equal(positioned.y, 52, "the top margin is added to the native leaf origin");
  const toolbar = page.locator(".mobile-navbar");
  const toolbarTop = (await toolbar.boundingBox()).y;
  for (const selector of [".epub-pager-area", ".epub-pager-panel"]) {
    const bounds = await page.locator(selector).boundingBox();
    assert.ok(bounds.y + bounds.height <= toolbarTop, "the toolbar cannot overlap the EPUB page or settings");
  }
  await page.locator('[aria-label="展开阅读设置"]').click();
  const status = page.getByRole("button", { name: "展开阅读设置" });
  const start = await status.boundingBox();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: start.x + start.width / 2, y: start.y + start.height / 2 }] });
  await page.waitForFunction(() => document.querySelector(".epub-pager-controls.is-dragging"));
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 200, y: 382 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  const rail = await page.locator(".epub-pager-controls").boundingBox();
  assert.equal(await page.locator(".epub-pager-controls.is-horizontal").count(), 1);
  assert.ok(rail.x < start.x - 100 && rail.y + rail.height <= toolbarTop, "long press moves the rail and keeps it above the toolbar");
  assert.equal(await status.getAttribute("aria-expanded"), "false", "dragging does not open settings");
  await status.tap();
  assert.equal(await status.getAttribute("aria-expanded"), "true", "a tap still opens settings after dragging");
  const grip = page.locator(".pager-panel-grip");
  const handle = await grip.boundingBox();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: handle.x + 50, y: handle.y + 16 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 90, y: 65 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.equal(await page.locator(".epub-pager-panel.is-placed").count(), 1);
  await page.getByRole("button", { name: "关闭阅读设置" }).tap();
  await toolbar.evaluate((element) => {
    element.hidden = true;
    document.querySelector("#host").style.top = "56px";
  });
  await page.waitForFunction(() => {
    const viewport = document.querySelector(".epub-pager-viewport").getBoundingClientRect();
    return viewport.top === 36 && viewport.bottom === 390;
  });
  const expanded = await page.locator(".epub-pager-area").boundingBox();
  assert.equal(expanded.y, positioned.y, "toolbar collapse does not move the top margin");
  assert.equal(expanded.height - positioned.height, 56);
  await page.screenshot({ path: "/tmp/pager-hz-epub-mobile-spread.png" });
  await page.evaluate(() => { document.querySelector("#host").style.cssText = ""; window.harness.view.contentEl.style.height = ""; });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  assert.equal(await page.evaluate(() => window.harness.view.rendition._layout.divisor), 1, "portrait falls back to one column");
  assert.equal(await page.evaluate(() => window.harness.view.preferences.spread), "single", "mobile does not overwrite a saved desktop layout choice");
  await page.evaluate(() => { const slider = document.querySelector('[aria-label="字号"]'); slider.value = "28"; slider.dispatchEvent(new Event("input")); });
  await page.waitForTimeout(800);
  const fontSize = await page.evaluate(() => {
    const frame = document.querySelector("iframe");
    return frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector("p")).fontSize;
  });
  assert.equal(fontSize, "28px", "font slider changes actual book typography");
  const family = () => page.locator("iframe").evaluate((frame) => frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector("p span")).fontFamily);
  assert.match(await family(), /Songti/);
  await status.tap();
  await page.getByRole("button", { name: "黑体类" }).tap();
  await page.waitForFunction(() => !window.harness.view.reformatting);
  assert.match(await family(), /PingFang/);
  await page.getByRole("button", { name: "原字体" }).tap();
  await page.waitForFunction(() => !window.harness.view.reformatting);
  assert.equal(await family(), "monospace", "original restores the book's font");
  await page.getByRole("button", { name: "关闭阅读设置" }).tap();
  assert.deepEqual(await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress.epub), saved, "reflow must not overwrite synced progress");
  const anchorVisible = await page.evaluate((cfi) => {
    const view = window.harness.view;
    const rect = view.rendition.getRange(cfi).getBoundingClientRect();
    const frame = view.area.querySelector("iframe");
    return rect.right >= 0 && rect.left <= frame.clientWidth && rect.bottom >= 0 && rect.top <= frame.clientHeight;
  }, saved.cfi);
  assert.ok(anchorVisible, "the original text anchor remains visible after rotation and font change");
  await page.screenshot({ path: "/tmp/pdf-pager-epub-portrait.png" });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.waitForTimeout(700);
  await page.waitForFunction(() => !window.harness.view.reformatting);
  const readingArea = await page.locator(".epub-pager-area").boundingBox();
  const centerY = readingArea.y + readingArea.height / 2;
  await page.touchscreen.tap(readingArea.x + readingArea.width / 2, centerY);
  assert.equal(await status.getAttribute("aria-expanded"), "true", "center tap opens settings from inside the iframe");
  await page.getByRole("button", { name: "关闭阅读设置" }).tap();
  const currentAnchor = () => page.evaluate(() => window.harness.view.location.cfi);
  const waitTurn = (cfi) => page.waitForFunction((before) => window.harness.view.location.cfi !== before && !window.harness.view.moving, cfi);
  const beforeTap = await currentAnchor();
  await page.touchscreen.tap(readingArea.x + readingArea.width * 0.87, centerY);
  await waitTurn(beforeTap);
  const afterTap = await currentAnchor();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: 295, y: centerY }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: 495, y: centerY }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await waitTurn(afterTap);
  await page.touchscreen.tap(readingArea.x + readingArea.width / 2, centerY);
  await page.getByRole("button", { name: "目录", exact: true }).tap();
  await page.locator(".epub-pager-toc-row", { hasText: "第一节" }).tap();
  await page.waitForFunction(() => window.harness.view.location.cfi.includes("[p30]"));
  assert.ok(await page.evaluate(() => {
    const area = document.querySelector(".epub-pager-area").getBoundingClientRect();
    const frame = document.querySelector("iframe");
    const section = frame.contentDocument.getElementById("p30").getBoundingClientRect();
    const offset = frame.getBoundingClientRect();
    return section.left + offset.left < area.right && section.right + offset.left > area.left
      && section.top + offset.top < area.bottom && section.bottom + offset.top > area.top;
  }), "the exact TOC fragment is on the visible spread");
  await page.evaluate(() => window.harness.view.jump("b.xhtml"));
  await page.waitForFunction(() => window.harness.view.location.chapter === "第二章");
  await page.evaluate(() => window.harness.view.addBookmark());
  assert.equal(await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).bookmarks.length), 1);
  await page.waitForTimeout(600);
  const last = await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress.epub);
  await page.evaluate(() => window.harness.pause());
  await page.evaluate(() => window.harness.view.onUnloadFile());
  assert.equal(await page.locator("iframe").count(), 0);
  await page.evaluate(() => { window.harness.holdNextIndex(); window.harness.resume(); return window.harness.open(); });
  await page.waitForFunction(() => window.harness.view.ready && !window.harness.view.reformatting);
  assert.equal(await page.evaluate(() => window.harness.view.location.chapter), "第二章");
  assert.deepEqual(await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress.epub), last, "reopening never updates the saved timestamp or position");
  await page.waitForFunction(() => window.resumeIndex && window.harness.view.location);
  assert.equal(await page.evaluate(() => window.harness.view.indexReady), false);
  const earlyArea = await page.locator(".epub-pager-area").boundingBox();
  const earlyCfi = await currentAnchor();
  await page.touchscreen.tap(earlyArea.x + earlyArea.width * 0.87, earlyArea.y + earlyArea.height / 2);
  await waitTurn(earlyCfi);
  assert.equal(await page.evaluate(() => window.harness.view.location.estimated), true);
  await page.evaluate(() => window.resumeIndex());
  await page.waitForFunction(() => window.harness.view.indexReady);
  assert.equal(await page.evaluate(() => window.harness.view.location.estimated), undefined);
  await page.screenshot({ path: "/tmp/pdf-pager-epub-landscape.png" });
  await page.locator('[aria-label="展开阅读设置"]').click();
  const panel = await page.locator(".epub-pager-panel").boundingBox();
  assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= 844 && panel.y + panel.height <= 390, "reading controls stay within the landscape viewport");
  if (font) {
    await page.getByRole("button", { name: "下载中文宋体（约 25 MB）" }).tap();
    await page.waitForFunction(() => {
      const doc = document.querySelector("iframe")?.contentDocument;
      return doc && [...doc.fonts].some((face) => face.family === "Pager HZ Chinese Serif" && face.status === "loaded");
    });
    await page.locator("iframe").evaluate((frame) => {
      const doc = frame.contentDocument;
      const probe = doc.createElement("span");
      probe.id = "chinese-font-probe";
      probe.textContent = "中文宋体测试";
      doc.body.append(probe);
    });
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    function findProbe(node) {
      if (node.attributes?.includes("chinese-font-probe")) return node.nodeId;
      for (const child of [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]) {
        const found = findProbe(child);
        if (found) return found;
      }
    }
    const nodeId = findProbe(root);
    assert.ok(nodeId, "the Chinese-only probe exists in the EPUB frame");
    const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
    assert.ok(fonts.some((font) => font.isCustomFont && /Noto Serif CJK SC/.test(font.familyName) && font.glyphCount >= 6), JSON.stringify(fonts));
    await page.evaluate(async () => {
      await window.harness.view.onClose();
      await window.harness.open();
    });
    await page.waitForFunction(() => window.harness.view.ready && window.harness.view.serifFontUrl);
    assert.equal(await page.evaluate(() => window.harness.fontRequests()), 1, "reopening restores the Chinese serif font offline");
  }
  await page.evaluate(async () => {
    await window.harness.view.onUnloadFile();
    await Promise.all([window.harness.open(), window.harness.view.onUnloadFile()]);
  });
  assert.equal(await page.locator("iframe").count(), 0, "a cancelled open cannot resurrect the iframe");
  assert.equal(await page.evaluate(() => window.harness.view.ready), false);
  await page.evaluate(() => window.harness.mountPdf());
  await page.locator(".pager-reader-status").tap();
  await page.getByRole("button", { name: "调整页面宽度" }).tap();
  assert.equal(await page.getByLabel("PDF 最小显示宽度").count(), 1);
  await page.locator(".pager-reader-panel").getByRole("button", { name: "进入专注模式" }).tap();
  assert.equal(await page.locator(".pager-reader-panel").getByRole("button", { name: "退出专注模式" }).getAttribute("data-icon"), "minimize-2");
  await page.evaluate(() => { window.unmountPdf(); window.harness.mountLog(); });
  await page.setViewportSize({ width: 390, height: 844 });
  const cards = page.locator(".pdf-pager-log-book");
  assert.equal((await cards.nth(0).boundingBox()).x, (await cards.nth(1).boundingBox()).x, "mobile log uses one column");
  const longTitle = cards.first().locator(".pdf-pager-log-book-title");
  assert.ok(await longTitle.evaluate((el) => getComputedStyle(el).whiteSpace === "normal" && el.scrollWidth <= el.clientWidth));
  await longTitle.tap();
  assert.match(await page.evaluate(() => window.openedFromLog[0]), /\.epub$/);
  assert.deepEqual(await page.evaluate(() => window.notices.filter((notice) => notice !== "已添加书签")), [], "reader notices must not hide layout errors");
  assert.deepEqual(errors, []);
  console.log("EPUB browser checks passed: hidden tabs, mobile auto layout, toolbar clearance, touch drag, touch tap/swipe, exact TOC anchors, pagination, font reflow, stable CFI, sync writes, chapters, bookmarks, close/reopen.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
