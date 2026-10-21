// test/make-malformed-fixture.mjs — builds test/fixtures/malformed.epub
// chapter1.xhtml has a bare "&" (not XML-well-formed) containing the watermark,
// so DOMParser fails and the editor must fall back to text-level removal.
// Run: node test/make-malformed-fixture.mjs
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
    <dc:identifier id="uid">urn:uuid:fixture-malformed-0001</dc:identifier>
    <dc:title>Malformed Fixture Book</dc:title>
    <dc:language>en</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`;

// Bare "&" inside the paragraph → not well-formed XML.
const chapter1 = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>Chapter 1</title></head>
<body>
  <h1>Chapter One</h1>
  <p>Chapter content here.</p>
  <p>${WATERMARK} & Sons</p>
  <p>More chapter content here.</p>
</body>
</html>`;

const zip = new JSZip();
zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
zip.file("META-INF/container.xml", containerXml);
zip.file("OEBPS/content.opf", opf);
zip.file("OEBPS/chapter1.xhtml", chapter1);

const bytes = await zip.generateAsync({
  type: "nodebuffer",
  compression: "DEFLATE",
  compressionOptions: { level: 9 }
});
const outPath = join(outDir, "malformed.epub");
writeFileSync(outPath, bytes);
console.log(`Wrote ${outPath} (${bytes.length} bytes) with non-well-formed chapter1`);
