import esbuild from "esbuild";
import { readFile } from "node:fs/promises";

const notices = await Promise.all([
  ["EPUB.js", "node_modules/epubjs/license"],
  ["@xmldom/xmldom", "node_modules/@xmldom/xmldom/LICENSE"],
].map(async ([name, path]) => `${name}\n${await readFile(path, "utf8")}`));

await esbuild.build({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2018",
  platform: "browser",
  external: ["obsidian"],
  minify: true,
  logLevel: "info",
  banner: { js: `/*!\n${notices.join("\n\n")}\n*/` },
});
