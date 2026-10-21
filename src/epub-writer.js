/* epub-writer.js — rebuild an edited EPUB as a spec-conformant ZIP
 *
 * EPUB ZIP requirements handled here:
 *  - `mimetype` is the FIRST archive entry and is STORED (uncompressed)
 *  - no directory entries (like `zip -D`), no macOS junk (.DS_Store, __MACOSX)
 *  - all other entries are DEFLATE level 9; unedited entries are copied
 *    byte-for-byte from the original archive
 */
"use strict";

const EpubWriter = {
  MIMETYPE_PATH: "mimetype",
  MIMETYPE_CONTENT: "application/epub+zip",

  isMacJunk(path) {
    return (
      path.endsWith(".DS_Store") ||
      path.startsWith("__MACOSX/") ||
      path === "__MACOSX"
    );
  },

  /**
   * Rebuild the archive with the approved edits applied.
   * @param {{zip: JSZip}} epub        opened EPUB (from EpubReader.open)
   * @param {Array} edits              [{ path, source }] — edited documents
   * @returns {Promise<Blob>}          the new .epub bytes
   */
  async rebuild(epub, edits) {
    const editMap = new Map(edits.map((e) => [e.path, e.source]));
    const out = new JSZip();

    // 1) mimetype first, stored — must precede every other entry.
    out.file(this.MIMETYPE_PATH, this.MIMETYPE_CONTENT, {
      compression: "STORE",
      createFolders: false
    });

    // 2) Remaining entries in original archive order.
    for (const [path, entry] of Object.entries(epub.zip.files)) {
      if (path === this.MIMETYPE_PATH) continue;
      if (this.isMacJunk(path)) continue;
      if (entry.dir) continue; // no directory entries

      if (editMap.has(path)) {
        out.file(path, editMap.get(path), { createFolders: false });
      } else {
        const data = await entry.async("uint8array");
        out.file(path, data, { binary: true, createFolders: false }); // byte-for-byte content copy
      }
    }

    return await out.generateAsync({
      type: "blob",
      compression: "DEFLATE",
      compressionOptions: { level: 9 }
    });
  }
};
