import esbuild from "esbuild";
import { readFile, writeFile } from "node:fs/promises";
import { epubBuild } from "./epub-build.mjs";

const notices = await Promise.all([
  ["EPUB.js", "node_modules/epubjs/license"],
  ["@xmldom/xmldom", "node_modules/@xmldom/xmldom/LICENSE"],
  ["pako", "node_modules/pako/LICENSE"],
  ["Lodash", "node_modules/lodash/LICENSE"],
].map(async ([name, path]) => `${name}\n${await readFile(path, "utf8")}`));

// JSZip is distributed here under its MIT option.
const jszipLicense = await readFile("node_modules/jszip/LICENSE.markdown", "utf8");
notices.push(`JSZip\n${jszipLicense.split("\n\nGPL version 3")[0]}`);

const { outputFiles: [bundle] } = await esbuild.build({
  plugins: [epubBuild],
  write: false,
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

const forbidden = [
  /createElement(?:NS)?\s*\([^)]*["']script["']/i,
  /\b(?:eval|Function)\s*\(/,
  /\ballow-scripts\b/,
];
if (forbidden.some((pattern) => pattern.test(bundle.text))) {
  throw new Error("The release bundle contains executable-script support.");
}
await writeFile(bundle.path, bundle.contents);
