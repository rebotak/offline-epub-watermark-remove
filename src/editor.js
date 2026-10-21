/* editor.js — apply approved edits to scanned content documents
 *
 * Two operations (spec watermark-removal):
 *  - mode "element": remove the whole enclosing HTML element (default).
 *    Never leaves an empty <p></p> behind.
 *  - mode "text": explicit text-only replacement — remove just the matched
 *    characters, preserving surrounding markup.
 *
 * Editing runs on the parsed DOM from Matcher.scanDocument; only occurrences
 * present in the selection are touched.
 */
"use strict";

const Editor = {
  /**
   * Apply the user's selection to the scanned documents.
   * @param {Array} matches      scan results from Matcher.scanDocument (with .dom)
   * @param {Map}   selection    "docIdx:occIdx" -> { mode: 'element' | 'text' }
   * @returns {{ edits: Array, removedCount: number }}
   *   edits: [{ path, source, count }] — only documents that changed
   */
  applyEdits(matches, selection) {
    const edits = [];
    let removedCount = 0;

    matches.forEach((result, docIdx) => {
      // Malformed XHTML: DOM editing is impossible — fall back to text-level
      // removal on the original source so approved edits are never skipped.
      if (result.parseError || !result.dom) {
        const edit = this.applyRawFallback(result, docIdx, selection);
        if (edit) {
          edits.push(edit);
          removedCount += edit.count;
        }
        return;
      }

      const elementTargets = []; // selected occurrences for whole-element removal
      const textRanges = [];     // [start, end) in text-stream coords for text-only

      result.occurrences.forEach((occ, occIdx) => {
        const sel = selection.get(`${docIdx}:${occIdx}`);
        if (!sel) return;
        if (sel.mode === "text") textRanges.push([occ.index, occ.index + occ.length]);
        else elementTargets.push({ occ, el: Matcher.scopeElement(occ, sel) });
      });

      if (elementTargets.length === 0 && textRanges.length === 0) return;

      let docEdits = 0;

      // 1) Whole-element removal. Occurrences sharing an enclosing element
      //    collapse into a single removal; later ones are already detached.
      const removedElements = new Set();
      for (const { occ, el } of elementTargets) {
        if (!el) continue;
        if (!el.isConnected) continue; // removed together with a previous block
        el.remove();
        removedElements.add(el);
        docEdits++;
      }

      // 2) Text-only removal. Ranges are non-overlapping and expressed in
      //    scan-time text-stream coordinates; per node apply from the highest
      //    offset down so earlier offsets stay valid.
      if (textRanges.length > 0) {
        const slicesByNode = new Map(); // text node -> [{start, end}] node-relative
        result.occurrences.forEach((occ, occIdx) => {
          const sel = selection.get(`${docIdx}:${occIdx}`);
          if (!sel || sel.mode !== "text") return;
          const [from, to] = [occ.index, occ.index + occ.length];
          for (const seg of occ.nodeSegments || []) {
            if (!seg.node.isConnected) continue; // its element was removed above
            const s = Math.max(from, seg.start);
            const e = Math.min(to, seg.end);
            if (s >= e) continue;
            const rel = { start: s - seg.start, end: e - seg.start };
            if (!slicesByNode.has(seg.node)) slicesByNode.set(seg.node, []);
            slicesByNode.get(seg.node).push(rel);
          }
          docEdits++;
        });

        for (const [node, slices] of slicesByNode) {
          const sorted = slices.sort((a, b) => b.start - a.start); // descending
          let data = node.data;
          for (const sl of sorted) {
            data = data.slice(0, sl.start) + data.slice(sl.end);
          }
          node.data = data;
        }
      }

      if (docEdits > 0) {
        edits.push({
          path: result.path,
          source: new XMLSerializer().serializeToString(result.dom),
          count: docEdits
        });
        removedCount += docEdits;
      }
    });

    return { edits, removedCount };
  },

  /**
   * Text-level fallback for malformed XHTML (no usable DOM).
   * mode "element": remove the raw span of the enclosing tag (e.g. the whole
   *   `<p ...>...</p>` block found in the source text).
   * mode "text": remove only the matched characters.
   * Occurrence ranges are applied high-to-low so earlier indices stay valid;
   * overlapping block spans are merged. Returns { path, source, count } or null.
   */
  applyRawFallback(result, docIdx, selection) {
    const selected = [];
    result.occurrences.forEach((occ, occIdx) => {
      const sel = selection.get(`${docIdx}:${occIdx}`);
      if (sel) selected.push({ occ, mode: sel.mode });
    });
    if (selected.length === 0) return null;

    const spans = []; // [start, end) spans to delete from the raw source
    for (const { occ, mode } of selected) {
      if (mode === "text") {
        spans.push([occ.index, occ.index + occ.length]);
      } else {
        spans.push(this.rawBlockSpan(result.source, occ.index) ||
                   [occ.index, occ.index + occ.length]);
      }
    }

    // Sort ascending, merge overlaps (two occurrences may share one block).
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const span of spans) {
      const last = merged[merged.length - 1];
      if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
      else merged.push(span.slice());
    }

    let source = result.source;
    for (let i = merged.length - 1; i >= 0; i--) {
      const [start, end] = merged[i];
      source = source.slice(0, start) + source.slice(end);
    }

    return { path: result.path, source, count: selected.length, fallback: true };
  },

  /**
   * Locate the raw source span of the element enclosing `index`.
   * Scans backward through tags before the occurrence and only accepts a
   * candidate whose matching closing tag lies after the occurrence — so
   * self-closing tags and closing tags are skipped, and an element that
   * already ended before the watermark is not (wrongly) treated as its block.
   * Returns [start, end) or null when no enclosing tag exists.
   */
  rawBlockSpan(source, index) {
    let from = index - 1;
    while (from >= 0) {
      const openStart = source.lastIndexOf("<", from);
      if (openStart === -1) return null;
      const openEnd = source.indexOf(">", openStart);
      if (openEnd === -1) return null;

      const tagStr = source.slice(openStart, openEnd + 1);

      // Only a complete opening tag fully before the occurrence can enclose it.
      if (openEnd < index && /^<[A-Za-z][\w:-]*/.test(tagStr) && !tagStr.startsWith("</")) {
        if (tagStr.endsWith("/>")) {
          from = openStart - 1; // self-closing: cannot wrap the text
          continue;
        }
        const tag = tagStr.match(/^<([A-Za-z][\w:-]*)/)[1];
        // Find this tag's closing tag AFTER the occurrence.
        let closeIdx = source.indexOf(`</${tag}`, openEnd);
        while (closeIdx !== -1 && closeIdx < index) {
          closeIdx = source.indexOf(`</${tag}`, closeIdx + 1);
        }
        if (closeIdx !== -1) {
          const closeEnd = source.indexOf(">", closeIdx);
          if (closeEnd !== -1) return [openStart, closeEnd + 1];
        }
        // Element ends before the occurrence (or never closes): keep looking back.
      }
      from = openStart - 1;
    }
    return null;
  }
};
