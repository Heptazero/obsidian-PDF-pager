import { readFile } from "node:fs/promises";

export async function buildStylesheet() {
  const [styles, font, license] = await Promise.all([
    readFile("src/pager.css", "utf8"),
    readFile("assets/noto-serif-cjk-sc-gb2312.woff2"),
    readFile("assets/noto-serif-cjk-OFL.txt", "utf8"),
  ]);
  // WebViews limit the size of a single CSS custom property.
  const encoded = font.toString("base64");
  const chunks = encoded.match(/.{1,65536}/g);
  const properties = chunks.map((chunk, index) => `  --epub-serif-${index}: "${chunk}";`).join("\n");
  return `${styles}
/*!
Noto Serif CJK SC Regular 2.003. Subset to GB2312 and basic Latin, encoded as WOFF2.
Copyright 2017–2024 Adobe (http://www.adobe.com/).
Source: https://github.com/notofonts/noto-cjk/tree/Serif2.003/Serif
${license}
*/
.epub-pager {
  --epub-serif-chunks: ${chunks.length};
${properties}
}
`;
}
