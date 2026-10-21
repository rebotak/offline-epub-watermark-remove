// test/make-fixture.mjs — builds test/fixtures/watermarked.epub
// Fixture: 3 watermark occurrences in chapter1, none in chapter2.
// Uses the vendored JSZip; run: node test/make-fixture.mjs
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const JSZip = require("../vendor/jszip.min.js");

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "fixtures");
mkdirSync(outDir, { recursive: true });

const WATERMARK = "Licensed to Alice Example";

const containerXml = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">urn:uuid:fixture-0001</dc:identifier>
    <dc:title>Watermarked Fixture Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="chapter2.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <h1>Chapter One</h1>
  <p>Chapter content here.</p>
  <p>${WATERMARK}</p>
  <p>More chapter content here.</p>
  <p>First footer line. ${WATERMARK} Second footer line.</p>
  <div class="notice"><span>${WATERMARK}</span></div>
</body>
</html>`;

const chapter2 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 2</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
  <h1>Chapter Two</h1>
  <p>Clean chapter content with no watermark at all.</p>
</body>
</html>`;

const css = `body { font-family: serif; margin: 1em; }`;

const zip = new JSZip();
zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
zip.file("META-INF/container.xml", containerXml);
zip.file("OEBPS/content.opf", opf);
zip.file("OEBPS/chapter1.xhtml", chapter1);
zip.file("OEBPS/chapter2.xhtml", chapter2);
zip.file("OEBPS/style.css", css);

const bytes = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 }
});
const outPath = join(outDir, "watermarked.epub");
writeFileSync(outPath, bytes);
console.log(`Wrote ${outPath} (${bytes.length} bytes), watermark: "${WATERMARK}", 3 occurrences in chapter1`);
