/* validator.js — reopen-and-verify checks on the generated EPUB (spec epub-repack)
 *
 * Checks:
 *  1. output reopens as a readable EPUB (container + OPF resolvable)
 *  2. `mimetype` is the first archive entry and STORED (byte-level central dir)
 *  3. container.xml and the OPF package document are byte-identical to the original
 *  4. every unedited entry is byte-identical to the original (paths + contents)
 *  5. approved edits landed: selected blocks absent, per-document watermark
 *     counts match what the selection implies
 *  6. unapproved occurrences remain untouched (their blocks still present)
 */
"use strict";

const Validator = {
  /**
   * @param {Object} args
   * @param {Blob} args.blob           generated EPUB
   * @param {{zip: JSZip, opfPath: string}} args.originalEpub
   * @param {Array} args.matches       Matcher results for every scanned doc
   * @param {Map} args.selection       "docIdx:occIdx" -> { mode }
   * @param {string} args.watermark
   * @param {Array} args.editedPaths   paths the editor rewrote
   * @returns {Promise<{ok: boolean, checks: Array<{name, pass, detail}>}>}
   */
  async validate({ blob, originalEpub, matches, selection, watermark, editedPaths }) {
    const checks = [];
    const add = (name, pass, detail) => checks.push({ name, pass, detail });

    // --- 1. Reopen as EPUB ---
    let outZip = null;
    try {
      const reopened = await EpubReader.open(blob);
      outZip = reopened.zip;
      add("Output reopens as a valid EPUB", true, `package document: ${reopened.opfPath}`);
    } catch (err) {
      add("Output reopens as a valid EPUB", false, err.message);
      return { ok: false, checks };
    }

    // --- 2. mimetype first + STORED (central directory bytes) ---
    try {
      const entries = this.parseCentralDir(await blob.arrayBuffer());
      if (!entries || entries.length === 0) throw new Error("no central directory");
      const first = entries[0];
      const pass = first.name === "mimetype" && first.method === 0;
      add(
        "mimetype is the first entry and stored uncompressed",
        pass,
        `first entry: ${first.name}, method: ${first.method === 0 ? "STORE" : "DEFLATE/" + first.method}`
      );
    } catch (err) {
      add("mimetype is the first entry and stored uncompressed", false, err.message);
    }

    // --- 3. container.xml + OPF byte-identical ---
    const pathsToCompare = ["META-INF/container.xml", originalEpub.opfPath];
    for (const path of pathsToCompare) {
      try {
        const orig = originalEpub.zip.file(path);
        const next = outZip.file(path);
        if (!orig || !next) throw new Error(`${path} missing in ${!orig ? "original" : "output"}`);
        const [a, b] = await Promise.all([orig.async("uint8array"), next.async("uint8array")]);
        add(`${path} unchanged`, this.bytesEqual(a, b));
      } catch (err) {
        add(`${path} unchanged`, false, err.message);
      }
    }

    // --- 4. Unedited entries byte-identical ---
    try {
      const edited = new Set(editedPaths);
      const diffs = [];
      for (const [path, entry] of Object.entries(originalEpub.zip.files)) {
        if (entry.dir) continue;
        if (path === "mimetype" || EpubWriter.isMacJunk(path)) continue;
        if (edited.has(path)) continue;
        const next = outZip.file(path);
        if (!next) { diffs.push(`${path} (missing)`); continue; }
        const [a, b] = await Promise.all([entry.async("uint8array"), next.async("uint8array")]);
        if (!this.bytesEqual(a, b)) diffs.push(path);
      }
      add(
        "All unedited entries preserved byte-for-byte",
        diffs.length === 0,
        diffs.length ? `changed: ${diffs.join(", ")}` : "no unexpected changes"
      );
    } catch (err) {
      add("All unedited entries preserved byte-for-byte", false, err.message);
    }

    // --- 5 + 6. Approved edits present; unapproved occurrences untouched ---
    // Block-signature comparisons only run for EDITED documents: their output
    // source was produced by the same XMLSerializer, so signatures are
    // comparable. Unedited documents are already proven untouched by the
    // byte-for-byte check above.
    try {
      const editedSet = new Set(editedPaths);
      const expected = this.expectedCounts(matches, selection, watermark);

      for (let docIdx = 0; docIdx < matches.length; docIdx++) {
        const match = matches[docIdx];
        if (!editedSet.has(match.path)) continue;
        const outEntry = outZip.file(match.path);
        if (!outEntry) {
          add(`Document ${match.path}: edits verified`, false, "document missing from output");
          continue;
        }

        const outSource = await outEntry.async("string");
        const outScan = Matcher.scanDocument(match.path, outSource, watermark);

        // 5a. occurrence count matches what the selection implies
        const want = expected.byDoc[match.path];
        if (outScan.occurrences.length !== want) {
          add(
            `Document ${match.path}: approved removals landed`,
            false,
            `expected ${want} watermark occurrence(s), found ${outScan.occurrences.length}`
          );
          continue;
        }

        // 5b. approved element blocks absent; unapproved blocks present.
        // Signatures are fragment serializations (xmlns declared locally) while
        // the output source serializes the full document (xmlns inherited), so
        // compare with namespace declarations stripped from both sides.
        const norm = (s) => s.replace(/\s+xmlns(:[\w-]+)?="[^"]*"/g, "");
        const outNorm = norm(outSource);
        let approvedAbsent = true;
        let unapprovedPresent = true;
        const problems = [];
        match.occurrences.forEach((occ, occIdx) => {
          if (!occ.element) return; // raw-fallback occurrences are covered by 5a
          const sel = selection.get(`${docIdx}:${occIdx}`);
          const covered = expected.coveredByElement[`${docIdx}:${occIdx}`];
          if (sel && sel.mode === "element") {
            // The approved scope element (per ancestor picker) must be gone.
            const scopeEl = Matcher.scopeElement(occ, sel);
            const sig = norm(Matcher.serializeBlock(scopeEl));
            if (sig && outNorm.includes(sig)) {
              approvedAbsent = false;
              problems.push("approved block still present");
            }
          } else if (!covered) {
            // Unapproved: the default block must survive untouched.
            const sig = norm(Matcher.serializeBlock(occ.element));
            if (sig && !outNorm.includes(sig)) {
              unapprovedPresent = false;
              problems.push("unapproved block was altered");
            }
          }
        });
        add(
          `Document ${match.path}: approved blocks removed, unapproved blocks untouched`,
          approvedAbsent && unapprovedPresent,
          problems.length ? problems.join("; ") : "block-level checks pass"
        );
      }
    } catch (err) {
      add("Approved edits verified in output", false, err.message);
    }

    const ok = checks.every((c) => c.pass);
    return { ok, checks };
  },

  /** Per-document expected watermark counts implied by the selection. */
  expectedCounts(matches, selection, watermark) {
    const byDoc = {};
    const coveredByElement = {}; // "docIdx:occIdx" -> removed by an approved element

    matches.forEach((match, docIdx) => {
      const removed = new Set();
      match.occurrences.forEach((occ, occIdx) => {
        const sel = selection.get(`${docIdx}:${occIdx}`);
        if (!sel) return;
        if (sel.mode !== "element") {
          removed.add(occIdx);
          return;
        }
        if (occ.element) {
          // DOM: whole-element removal of the *approved scope* covers every
          // occurrence inside that scope element.
          const scopeEl = Matcher.scopeElement(occ, sel);
          if (scopeEl) {
            match.occurrences.forEach((other, otherIdx) => {
              if (other.element === scopeEl || this.elementContains(scopeEl, other)) {
                removed.add(otherIdx);
                if (otherIdx !== occIdx) coveredByElement[`${docIdx}:${otherIdx}`] = true;
              }
            });
          } else {
            removed.add(occIdx);
          }
        } else {
          // Raw fallback: the enclosing source block covers occurrences inside it.
          const span = Editor.rawBlockSpan(match.source, occ.index);
          if (span) {
            match.occurrences.forEach((other, otherIdx) => {
              if (other.index >= span[0] && other.index + other.length <= span[1]) {
                removed.add(otherIdx);
                if (otherIdx !== occIdx) coveredByElement[`${docIdx}:${otherIdx}`] = true;
              }
            });
          } else {
            removed.add(occIdx);
          }
        }
      });
      byDoc[match.path] = match.occurrences.length - removed.size;
    });

    return { byDoc, coveredByElement };
  },

  elementContains(approvedElement, occ) {
    if (!occ.element) return false;
    if (occ.element === approvedElement) return true;
    return approvedElement.contains ? approvedElement.contains(occ.element) : false;
  },

  bytesEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  },

  /** Parse the ZIP central directory → [{ name, method }] in archive order. */
  parseCentralDir(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd === -1) return null;
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const entries = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const name = new TextDecoder().decode(new Uint8Array(buf, off + 46, nameLen));
      entries.push({ name, method });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }
};
