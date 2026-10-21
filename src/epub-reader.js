/* epub-reader.js — ZIP loading and EPUB file discovery
 * EpubReader.open(file)  → validates the file is an EPUB and returns { zip, opfPath, ... }
 * EpubReader.listContentDocuments(epub) → XHTML/HTML documents in spine reading order
 * No network access; the File stays on this machine.
 */
"use strict";

const EpubReader = {
  /** Friendly, user-displayable error type. */
  error(message) {
    const e = new Error(message);
    e.isUserFacing = true;
    return e;
  },

  /**
   * Open a File/Blob as an EPUB.
   * Validation: readable ZIP + META-INF/container.xml + resolvable OPF package document.
   * Throws an error with a user-facing message when validation fails.
   */
  async open(file) {
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch (err) {
      throw this.error(
        "This file is not a readable EPUB (it could not be opened as a ZIP archive)."
      );
    }

    const containerEntry = zip.file("META-INF/container.xml");
    if (!containerEntry) {
      throw this.error(
        "This file is not a valid EPUB: META-INF/container.xml is missing."
      );
    }

    let containerXml;
    try {
      containerXml = await containerEntry.async("string");
    } catch (err) {
      throw this.error("Could not read META-INF/container.xml from the archive.");
    }

    const opfPath = this.parseContainer(containerXml);
    if (!opfPath) {
      throw this.error(
        "This file is not a valid EPUB: container.xml does not name a package document."
      );
    }

    const opfEntry = zip.file(opfPath);
    if (!opfEntry) {
      throw this.error(`This file is not a valid EPUB: package document "${opfPath}" is missing.`);
    }

    const opfText = await opfEntry.async("string");

    return { zip, opfPath, opfText, fileName: file.name || "book.epub" };
  },

  /** Extract the full-path of the package (OPF) document from container.xml. */
  parseContainer(containerXml) {
    const doc = new DOMParser().parseFromString(containerXml, "application/xml");
    if (doc.querySelector("parsererror")) return null;
    const rootfile = doc.getElementsByTagName("rootfile")[0];
    if (!rootfile) return null;
    const fullPath = rootfile.getAttribute("full-path");
    return fullPath && fullPath.trim() ? fullPath.trim() : null;
  },

  /** Resolve a relative href against the OPF's directory (POSIX-style). */
  resolvePath(baseOpfPath, href) {
    const baseDir = baseOpfPath.includes("/")
      ? baseOpfPath.slice(0, baseOpfPath.lastIndexOf("/"))
      : "";
    const combined = baseDir ? `${baseDir}/${href}` : href;
    const parts = [];
    for (const seg of combined.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return parts.join("/");
  },

  /**
   * Parse the OPF package document and return XHTML/HTML content documents
   * in spine reading order (falls back to manifest HTML items if the spine
   * lists nothing usable).
   * Returns: [{ path, mediaType, id }]
   */
  listContentDocuments(epub) {
    const doc = new DOMParser().parseFromString(epub.opfText, "application/xml");
    if (doc.querySelector("parsererror")) {
      throw this.error(
        `The package document (${epub.opfPath}) could not be parsed.`
      );
    }

    const isHtmlType = (mediaType) =>
      mediaType === "application/xhtml+xml" || mediaType === "text/html";

    // Manifest: id → { href, mediaType }
    const manifest = new Map();
    for (const item of doc.getElementsByTagName("item")) {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      const mediaType = item.getAttribute("media-type") || "";
      if (!id || !href) continue;
      manifest.set(id, {
        path: this.resolvePath(epub.opfPath, href),
        mediaType,
        id
      });
    }

    // Spine reading order
    const ordered = [];
    const seen = new Set();
    for (const itemref of doc.getElementsByTagName("itemref")) {
      const idref = itemref.getAttribute("idref");
      const entry = manifest.get(idref);
      if (!entry || seen.has(entry.path)) continue;
      if (isHtmlType(entry.mediaType)) {
        ordered.push(entry);
        seen.add(entry.path);
      }
    }

    // Other XHTML/HTML manifest items not in the spine (e.g. the EPUB3 nav
    // document, covers). Spec: every content document reachable from the
    // package document is scanned, not just spine items.
    for (const entry of manifest.values()) {
      if (isHtmlType(entry.mediaType) && !seen.has(entry.path)) {
        ordered.push(entry);
        seen.add(entry.path);
      }
    }

    return ordered;
  }
};
