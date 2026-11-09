import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const requireFromEpub = createRequire(require.resolve("epubjs/package.json"));

function replaceOnce(source, original, replacement = "") {
  const first = source.indexOf(original);
  if (first === -1 || source.indexOf(original, first + original.length) !== -1) {
    throw new Error(`Recheck EPUB dependency patch: ${original.split("\n")[0]}`);
  }
  return source.replace(original, replacement);
}

function removeMethod(source, declaration) {
  const start = source.indexOf(declaration);
  const end = source.indexOf("\n\t}", start);
  if (start === -1 || end === -1) throw new Error(`Recheck EPUB dependency patch: ${declaration}`);
  const comment = source.lastIndexOf("\t/**", start);
  return source.slice(0, comment === -1 ? start : comment) + source.slice(end + 3);
}

// Obsidian's supported browsers already have Promise and timers. Use JSZip's
// modular entry to omit the legacy browser polyfills in its prebuilt bundle.
export const epubBuild = {
  name: "epub-reader-dependencies",
  setup(build) {
    build.onResolve({ filter: /^jszip(?:\/dist\/jszip)?$/ }, (args) => {
      if (!args.importer.includes("/epubjs/") && !args.importer.includes("\\epubjs\\")) return;
      return { path: requireFromEpub.resolve("jszip") };
    });
    build.onResolve({ filter: /^stream$/ }, (args) => {
      if (!/[\\/]jszip[\\/]lib[\\/]readable-stream-browser\.js$/.test(args.importer)) return;
      // EPUB archives are opened from ArrayBuffers, without Node streams.
      return { path: "node-stream", namespace: "epub-browser" };
    });
    build.onLoad({ filter: /^node-stream$/, namespace: "epub-browser" }, () => ({ contents: "module.exports = {};" }));
    build.onLoad({ filter: /[\\/]jszip[\\/]lib[\\/](external|utils)\.js$/ }, async ({ path }) => {
      if (path.endsWith("external.js")) return { contents: "module.exports = { Promise };" };
      let contents = await readFile(path, "utf8");
      contents = replaceOnce(contents, 'require("setimmediate");');
      contents = replaceOnce(contents, "setImmediate(function () {", "setTimeout(function () {");
      return { contents };
    });
    build.onLoad({ filter: /[\\/]lodash[\\/]_root\.js$/ }, async ({ path }) => ({
      contents: replaceOnce(await readFile(path, "utf8"), "Function('return this')()", "globalThis"),
    }));
    build.onLoad({ filter: /[\\/]epubjs[\\/]src[\\/](book|contents|locations|rendition|managers[\\/]views[\\/]iframe)\.js$/ }, async ({ path }) => {
      let contents = await readFile(path, "utf8");
      if (path.endsWith("book.js")) {
        // The reader opens Vault files directly and has no separate offline cache.
        contents = replaceOnce(contents, 'import Store from "./store";');
        contents = replaceOnce(contents, '\t\tif (this.settings.store) {\n\t\t\tthis.store(this.settings.store);\n\t\t}\n');
        contents = removeMethod(contents, "\tstore(name) {");
      } else if (path.endsWith("contents.js")) {
        contents = removeMethod(contents, "\taddScript(src) {");
      } else if (path.endsWith("locations.js")) {
        // Index a separate document so background work cannot unload a rendered chapter.
        const start = contents.indexOf("\tprocess(section) {");
        const end = contents.indexOf("\n\t}", start);
        if (start === -1 || end === -1) throw new Error("Recheck EPUB locations patch");
        let process = contents.slice(start, end);
        process = replaceOnce(process, "section.load(this.request)", "this.request(section.url)");
        process = replaceOnce(process, "function(contents) {", "function(doc) {\n\t\t\t\tif (!this._locations) return [];");
        process = replaceOnce(process, "this.parse(contents, section.cfiBase)", "this.parse(doc.documentElement, section.cfiBase)");
        process = replaceOnce(process, "\n\t\t\t\tsection.unload();\n", "");
        process = replaceOnce(process, "}.bind(this));", "}.bind(this)).catch(() => []);");
        contents = contents.slice(0, start) + process + contents.slice(end);
      } else if (path.endsWith("rendition.js")) {
        contents = replaceOnce(contents, '\t\tif (this.settings.script) {\n\t\t\tthis.book.spine.hooks.content.register(this.injectScript.bind(this));\n\t\t}\n');
        contents = removeMethod(contents, "\tinjectScript(doc, section) {");
      } else {
        contents = replaceOnce(contents, '\t\tif (this.settings.allowScriptedContent) {\n\t\t\tthis.iframe.sandbox += " allow-scripts";\n\t\t}\n');
      }
      return { contents };
    });
  },
};
