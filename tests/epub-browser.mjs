import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { build } from "esbuild";
import { chromium } from "playwright";
import JSZip from "jszip";

const directory = await mkdtemp(path.join(tmpdir(), "pager-epub-browser-"));
const zip = new JSZip();
zip.file("mimetype", "application/epub+zip");
zip.file("META-INF/container.xml", '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
zip.file("book.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test</dc:identifier><dc:title>测试</dc:title><dc:language>zh</dc:language><meta property="dcterms:modified">2026-11-02T00:00:00Z</meta></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>');
zip.file("nav.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>目录</title></head><body><nav epub:type="toc"><ol><li><a href="a.xhtml">第一章</a></li><li><a href="b.xhtml">第二章</a></li></ol></nav></body></html>');
for (const chapter of ["a", "b"]) zip.file(`${chapter}.xhtml`, `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>${chapter}</title><style>body { margin: 80px; } p { font-size: 14px; }</style></head><body><h1>${chapter}</h1>${Array.from({ length: 100 }, (_, i) => `<p>段落 ${chapter}-${i}：这是一段测试文字，用来验证横屏分页、字号、边距、稳定的位置和章节跳转。${"翻到下一屏仍然可以继续阅读。".repeat(5)}</p>`).join("")}</body></html>`);
const fixture = await zip.generateAsync({ type: "nodebuffer" });
await build({ entryPoints: ["tests/browser/epub-harness.ts"], bundle: true, outfile: path.join(directory, "test.js"), platform: "browser", format: "iife", alias: { obsidian: path.resolve("tests/browser/obsidian-stub.ts") } });
const script = await readFile(path.join(directory, "test.js"));
const css = await readFile("styles.css");
const server = http.createServer((request, response) => {
  if (request.url === "/test.js") { response.setHeader("Content-Type", "text/javascript"); response.end(script); }
  else if (request.url === "/styles.css") { response.setHeader("Content-Type", "text/css"); response.end(css); }
  else if (request.url === "/fixture.epub") response.end(fixture);
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
  await page.evaluate(() => window.harness.open());
  await page.waitForFunction(() => window.harness.view.ready && !window.harness.view.reformatting, { timeout: 20000 });
  assert.equal(await page.evaluate(() => window.harness.view.toc.length), 2);
  assert.equal(await page.locator("iframe").count(), 1);
  await page.evaluate(() => window.harness.view.turn(1));
  await page.waitForFunction(() => window.harness.view.location.percentage > 0);
  await page.waitForFunction(() => window.harness.files.size > 0);
  const saved = await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress.epub);
  assert.ok(saved.cfi.startsWith("epubcfi("));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.evaluate(() => { const slider = document.querySelector('[aria-label="字号"]'); slider.value = "28"; slider.dispatchEvent(new Event("input")); });
  await page.waitForTimeout(800);
  const fontSize = await page.evaluate(() => {
    const frame = document.querySelector("iframe");
    return frame.contentWindow.getComputedStyle(frame.contentDocument.querySelector("p")).fontSize;
  });
  assert.equal(fontSize, "28px", "font slider changes actual book typography");
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
  await page.evaluate(() => window.harness.view.jump("b.xhtml"));
  await page.waitForFunction(() => window.harness.view.location.chapter === "第二章");
  await page.evaluate(() => window.harness.view.addBookmark());
  assert.equal(await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).bookmarks.length), 1);
  await page.waitForTimeout(600);
  const last = await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress.epub);
  await page.evaluate(() => window.harness.pause());
  await page.evaluate(() => window.harness.view.onUnloadFile());
  assert.equal(await page.locator("iframe").count(), 0);
  await page.evaluate(() => { window.harness.resume(); return window.harness.open(); });
  await page.waitForFunction(() => window.harness.view.ready && !window.harness.view.reformatting);
  assert.equal(await page.evaluate(() => window.harness.view.location.chapter), "第二章");
  assert.deepEqual(await page.evaluate(async () => (await window.harness.store.load("fixture.epub")).progress.epub), last, "reopening never updates the saved timestamp or position");
  await page.screenshot({ path: "/tmp/pdf-pager-epub-landscape.png" });
  await page.locator('[aria-label="展开阅读设置"]').click();
  const panel = await page.locator(".epub-pager-panel").boundingBox();
  assert.ok(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= 844 && panel.y + panel.height <= 390, "reading controls stay within the landscape viewport");
  await page.evaluate(async () => {
    await window.harness.view.onUnloadFile();
    await Promise.all([window.harness.open(), window.harness.view.onUnloadFile()]);
  });
  assert.equal(await page.locator("iframe").count(), 0, "a cancelled open cannot resurrect the iframe");
  assert.equal(await page.evaluate(() => window.harness.view.ready), false);
  assert.deepEqual(await page.evaluate(() => window.notices.filter((notice) => notice !== "已添加书签")), [], "reader notices must not hide layout errors");
  assert.deepEqual(errors, []);
  console.log("EPUB browser checks passed: mobile landscape/portrait, pagination, font reflow, stable CFI, sync writes, chapters, bookmarks, close/reopen.");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
