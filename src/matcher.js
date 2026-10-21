/* matcher.js — exact watermark matching and enclosing-element resolution
 *
 * Matching runs over the document's *text stream* (DOM text nodes concatenated),
 * so an exact string is found even when inline markup splits it. Every occurrence
 * records the deepest element that wraps all of its text — the "HTML block" the
 * user will review and remove.
 *
 * Malformed XHTML falls back to a raw-source scan (occurrences flagged with
 * element: null, used by the editor's text-level fallback).
 */
"use strict";

const Matcher = {
  SNIPPET_RADIUS: 60,

  /** Elements that read as a "block" — the default removal scope. */
  BLOCK_TAGS: new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DIV", "DL", "DT",
    "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3",
    "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
    "SECTION", "TABLE", "TR", "TD", "TH", "UL"
  ]),

  /**
   * Scan one content document for exact occurrences of `watermark`.
   * @param {string} path     archive path (for reporting)
   * @param {string} source   raw XHTML/HTML text
   * @param {string} watermark exact string to find
   * @returns {{path, source, watermark, occurrences: Array, parseError: boolean, dom: (Document|null)}}
   *   occurrence: { index, length, snippet, element, nodeSegments }
   *   Only exact matches of the full watermark string are reported.
   */
  scanDocument(path, source, watermark) {
    if (!watermark) {
      return { path, source, watermark, occurrences: [], parseError: false, dom: null };
    }

    const dom = new DOMParser().parseFromString(source, "application/xhtml+xml");
    const isParseError =
      !dom.documentElement || dom.documentElement.nodeName === "parsererror" ||
      !!dom.querySelector("parsererror");

    if (isParseError) {
      return {
        path, source, watermark, parseError: true, dom: null,
        occurrences: this.rawOccurrences(source, watermark)
      };
    }

    // Build the text stream: concatenated text with node→offset segments.
    const segments = [];
    let concat = "";
    const walker = dom.createTreeWalker(dom, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const start = concat.length;
      concat += node.data;
      segments.push({ node, start, end: concat.length });
    }

    const occurrences = [];
    let from = 0;
    let idx;
    while ((idx = concat.indexOf(watermark, from)) !== -1) {
      const end = idx + watermark.length;
      const nodeSegments = segments.filter((s) => s.start < end && s.end > idx);
      const ancestors = this.resolveElementChain(nodeSegments);
      const defaultEl =
        ancestors.find((el) => this.BLOCK_TAGS.has(el.nodeName.toUpperCase())) ||
        ancestors[0] ||
        null;
      occurrences.push({
        index: idx,
        length: watermark.length,
        snippet: this.snippet(concat, idx, watermark.length),
        element: defaultEl,               // default scope: nearest block-level
        ancestors,                        // innermost → outermost (excl. html/body)
        defaultIndex: ancestors.indexOf(defaultEl),
        nodeSegments
      });
      from = idx + watermark.length; // non-overlapping occurrences
    }

    return { path, source, watermark, occurrences, parseError: false, dom };
  },

  /** Exact occurrences in raw source (fallback for malformed XHTML). */
  rawOccurrences(source, watermark) {
    const occurrences = [];
    let from = 0;
    let idx;
    while ((idx = source.indexOf(watermark, from)) !== -1) {
      occurrences.push({
        index: idx,
        length: watermark.length,
        snippet: this.snippet(source, idx, watermark.length),
        element: null,
        nodeSegments: null
      });
      from = idx + watermark.length;
    }
    return occurrences;
  },

  /** Surrounding-text snippet centered on the match. */
  snippet(text, index, length) {
    const start = Math.max(0, index - this.SNIPPET_RADIUS);
    const end = Math.min(text.length, index + length + this.SNIPPET_RADIUS);
    return (
      (start > 0 ? "…" : "") +
      text.slice(start, end).replace(/\s+/g, " ") +
      (end < text.length ? "…" : "")
    );
  },

  /**
   * Chain of elements that contain every text segment of a match, innermost
   * → outermost, excluding html/body. The innermost entry (index 0) is the
   * deepest element wrapping the match; the default review block is the first
   * block-level entry (see scanDocument).
   * For a match inside <div><p><a><i>W</i></a></p></div> this is [i, a, p, div].
   * NOTE: XML-parsed nodeName is case-preserving, so compare uppercased.
   */
  resolveElementChain(nodeSegments) {
    const chain = [];
    if (!nodeSegments || nodeSegments.length === 0) return chain;

    let candidate = nodeSegments[0].node.parentElement;
    while (candidate) {
      const name = candidate.nodeName.toUpperCase();
      if (name === "BODY" || name === "HTML") break;
      const containsAll = nodeSegments.every((s) =>
        this.isDescendant(s.node, candidate)
      );
      if (!containsAll) break;
      chain.push(candidate);
      candidate = candidate.parentElement;
    }
    return chain;
  },

  /**
   * Resolve the element an approved occurrence actually removes.
   * @param {Object} occ occurrence (with ancestors chain)
   * @param {Object} sel selection entry { mode, scope } — scope is an index
   *   into occ.ancestors chosen in the review UI; omitted/null means the
   *   default (nearest block-level) element.
   */
  scopeElement(occ, sel) {
    if (!occ) return null;
    if (!occ.ancestors || occ.ancestors.length === 0) return occ.element || null;
    let idx =
      sel && Number.isInteger(sel.scope) && sel.scope >= 0
        ? sel.scope
        : occ.defaultIndex >= 0
          ? occ.defaultIndex
          : 0;
    idx = Math.min(idx, occ.ancestors.length - 1);
    return occ.ancestors[idx] || occ.element || null;
  },

  isDescendant(node, ancestor) {
    let current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parentNode;
    }
    return false;
  },

  /** Serialized HTML of an occurrence's block — shown in the review UI. */
  serializeBlock(element) {
    if (!element) return null;
    return new XMLSerializer().serializeToString(element);
  }
};
