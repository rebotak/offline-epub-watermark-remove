/* app.js — UI and orchestration
 * Stages: 1 Input (this task) → 2 Review → 3 Process/Export
 * All processing is local; no network calls anywhere in this file.
 */
"use strict";

const App = {
  state: {
    file: null,          // File object chosen by the user
    watermark: "",       // exact watermark string
    epub: null,          // opened EPUB (from EpubReader.open)
    matches: [],         // scan results (from Matcher.scanDocument)
    selection: new Map() // occurrenceId -> { mode: 'element' | 'text' }
  },

  els: {},

  init() {
    const ids = [
      "error-banner", "epub-file", "watermark-input", "scan-btn",
      "input-error", "file-info", "stage-input", "stage-review",
      "stage-process", "scan-summary", "review-list", "apply-btn",
      "rescan-btn", "progress", "validation-status", "download-btn",
      "restart-btn", "selection-error"
    ];
    for (const id of ids) this.els[id] = document.getElementById(id);

    this.els["epub-file"].addEventListener("change", (e) => this.onFileSelected(e));
    this.els["scan-btn"].addEventListener("click", () => this.onScanClicked());
    this.els["rescan-btn"].addEventListener("click", () => this.showStage("input"));
    this.els["apply-btn"].addEventListener("click", () => this.onApplyClicked());
    this.els["download-btn"].addEventListener("click", () => this.onDownloadClicked());
    this.els["restart-btn"].addEventListener("click", () => window.location.reload());
  },

  showStage(name) {
    this.els["stage-input"].classList.toggle("hidden", name !== "input");
    this.els["stage-review"].classList.toggle("hidden", name !== "review");
    this.els["stage-process"].classList.toggle("hidden", name !== "process");
  },

  setInputError(message) {
    this.els["input-error"].textContent = message || "";
  },

  setBanner(message) {
    const banner = this.els["error-banner"];
    banner.textContent = message || "";
    banner.classList.toggle("hidden", !message);
  },

  onFileSelected(e) {
    const file = e.target.files && e.target.files[0];
    this.state.file = file || null;
    this.setInputError("");
    const info = this.els["file-info"];
    if (file) {
      info.textContent = `${file.name} (${file.size.toLocaleString()} bytes) — ready to scan`;
      info.classList.remove("hidden");
    } else {
      info.textContent = "";
      info.classList.add("hidden");
    }
  },

  onScanClicked() {
    // Validation gate: never start a scan without both inputs (spec epub-scan).
    this.setInputError("");
    this.setBanner("");

    const watermark = this.els["watermark-input"].value;
    let error = "";
    if (!this.state.file) error = "Please choose an EPUB file.";
    else if (!watermark || !watermark.trim()) error = "Please enter the watermark text to find.";

    if (error) {
      this.setInputError(error);
      return; // no scan triggered
    }

    this.state.watermark = watermark;
    this.runScan(); // implemented in task 2.4
  },

  // ---- Stage 2: scan results (task 2.4; selection UI added in 3.2) ----
  async runScan() {
    const btn = this.els["scan-btn"];
    btn.disabled = true;
    this.setBanner("");
    try {
      this.state.epub = await EpubReader.open(this.state.file);
      const docs = EpubReader.listContentDocuments(this.state.epub);

      const results = [];
      for (const docDef of docs) {
        const entry = this.state.epub.zip.file(docDef.path);
        if (!entry) continue;
        const source = await entry.async("string");
        const scan = Matcher.scanDocument(docDef.path, source, this.state.watermark);
        if (scan.occurrences.length > 0) results.push(scan);
      }

      this.state.matches = results;
      this.state.selection = new Map();
      this.renderScanResults();
      this.showStage("review");
    } catch (err) {
      this.setBanner(err && err.isUserFacing ? err.message : `Scan failed: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  },

  renderScanResults() {
    const results = this.state.matches;
    const summary = this.els["scan-summary"];
    const list = this.els["review-list"];
    list.innerHTML = "";

    if (results.length === 0) {
      summary.innerHTML =
        '<div class="no-matches">No matches found. The watermark text does not occur in any content document — no edits can be selected.</div>';
      this.els["apply-btn"].disabled = true;
      return;
    }

    this.els["apply-btn"].disabled = false;
    const total = results.reduce((n, r) => n + r.occurrences.length, 0);
    summary.innerHTML = "";
    const p = document.createElement("p");
    p.className = "summary-line";
    p.textContent = `${total} match${total === 1 ? "" : "es"} in ${results.length} document${results.length === 1 ? "" : "s"}. Review each HTML block below — only checked blocks will be removed.`;
    summary.appendChild(p);

    const seenPatterns = new Set();

    results.forEach((result, docIdx) => {
      const docBox = document.createElement("div");
      docBox.className = "match-doc";
      const h3 = document.createElement("h3");
      h3.textContent = result.path;
      const count = document.createElement("span");
      count.className = "match-count";
      count.textContent = ` — ${result.occurrences.length} occurrence${result.occurrences.length === 1 ? "" : "s"}`;
      h3.appendChild(count);
      docBox.appendChild(h3);

      if (result.parseError) {
        const warn = document.createElement("span");
        warn.className = "badge warn";
        warn.textContent = "malformed XHTML";
        h3.appendChild(warn);
      }

      // Group occurrences by their serialized HTML block (the repeating pattern).
      const groups = new Map();
      result.occurrences.forEach((occ, occIdx) => {
        const signature = Matcher.serializeBlock(occ.element) || `RAW:${occ.snippet}`;
        if (!groups.has(signature)) groups.set(signature, []);
        groups.get(signature).push({ occ, occIdx, id: `${docIdx}:${occIdx}` });
      });

      for (const [signature, members] of groups) {
        const groupBox = document.createElement("div");
        groupBox.className = "block-group";

        // Ancestor chain of the pattern (from the first member) powers the
        // scope picker; default removal scope is the nearest block-level element.
        const chain = members[0].occ.ancestors || [];
        const defaultIdx = members[0].occ.defaultIndex >= 0 ? members[0].occ.defaultIndex : 0;
        let scopeIdx = defaultIdx;
        const scopeLabel = (el) => {
          const tag = el.nodeName.toLowerCase();
          const cls = el.getAttribute && el.getAttribute("class");
          return `<${tag}>` + (cls ? ` .${cls.split(/\s+/)[0]}` : "");
        };

        // Pattern header + the exact HTML block that will be removed.
        const head = document.createElement("label");
        head.className = "group-head";
        const groupAll = document.createElement("input");
        groupAll.type = "checkbox";
        groupAll.addEventListener("change", () => {
          groupBox
            .querySelectorAll('.occ-check')
            .forEach((cb) => {
              cb.checked = groupAll.checked;
              this.setOccurrenceSelected(cb.dataset.occId, groupAll.checked, cb.dataset.mode, scopeIdx);
            });
        });
        head.appendChild(groupAll);
        const headText = document.createElement("span");
        headText.innerHTML =
          `<strong>Select all</strong> ${members.length} occurrence${members.length === 1 ? "" : "s"} of this block ` +
          `<span class="pattern-label">HTML block</span>`;
        head.appendChild(headText);
        groupBox.appendChild(head);

        const code = document.createElement("code");
        code.className = "block-code";
        const renderBlockCode = () => {
          const el = chain[scopeIdx];
          const html = el ? Matcher.serializeBlock(el) : signature;
          code.textContent = html.startsWith("RAW:") ? html.slice(4) : html;
        };
        renderBlockCode();
        groupBox.appendChild(code);

        // Ancestor picker: widen/narrow the removal scope for this pattern.
        if (chain.length > 1) {
          const scopeRow = document.createElement("label");
          scopeRow.className = "scope-label";
          scopeRow.appendChild(document.createTextNode("Remove: "));
          const scopeSelect = document.createElement("select");
          scopeSelect.className = "scope-select";
          chain.forEach((el, i) => {
            const opt = document.createElement("option");
            opt.value = String(i);
            opt.textContent = scopeLabel(el) +
              (i === defaultIdx ? " (default)" : "") +
              (i === 0 ? " — smallest" : i === chain.length - 1 ? " — outermost" : "");
            scopeSelect.appendChild(opt);
          });
          scopeSelect.value = String(scopeIdx);
          scopeSelect.addEventListener("change", () => {
            scopeIdx = Number(scopeSelect.value);
            renderBlockCode();
            // Re-resolve scope for already-checked members of this pattern.
            groupBox.querySelectorAll(".occ-check:checked").forEach((cb) => {
              this.setOccurrenceSelected(cb.dataset.occId, true, cb.dataset.mode, scopeIdx);
            });
          });
          scopeRow.appendChild(scopeSelect);
          groupBox.appendChild(scopeRow);
        }

        // One rendered preview per distinct pattern (first time it is seen).
        if (!seenPatterns.has(signature)) {
          seenPatterns.add(signature);
          if (!result.parseError) {
            const preview = document.createElement("iframe");
            preview.className = "preview-frame";
            preview.setAttribute("sandbox", "");
            preview.title = "Page preview";
            preview.srcdoc = result.source;
            groupBox.appendChild(preview);
          }
        }

        // One row per occurrence (per-occurrence selection).
        for (const member of members) {
          const row = document.createElement("div");
          row.className = "match-row";

          const check = document.createElement("input");
          check.type = "checkbox";
          check.className = "occ-check";
          check.dataset.occId = member.id;
          check.dataset.mode = "element";
          check.addEventListener("change", () => {
            groupAll.checked = groupBox.querySelectorAll(".occ-check:checked").length === members.length;
            this.setOccurrenceSelected(check.dataset.occId, check.checked, check.dataset.mode, scopeIdx);
          });

          const body = document.createElement("div");
          body.className = "match-body";

          const snippet = document.createElement("code");
          snippet.className = "block-code";
          snippet.textContent = member.occ.snippet;
          body.appendChild(snippet);

          const textOnlyLabel = document.createElement("label");
          textOnlyLabel.className = "text-only-label";
          const textOnly = document.createElement("input");
          textOnly.type = "checkbox";
          textOnly.className = "text-only-check";
          textOnly.addEventListener("change", () => {
            check.dataset.mode = textOnly.checked ? "text" : "element";
            if (check.checked) {
              this.setOccurrenceSelected(check.dataset.occId, true, check.dataset.mode, scopeIdx);
            }
          });
          textOnlyLabel.appendChild(textOnly);
          textOnlyLabel.appendChild(document.createTextNode(" text-only (keep the element, remove just the watermark characters)"));
          body.appendChild(textOnlyLabel);

          row.appendChild(check);
          row.appendChild(body);
          groupBox.appendChild(row);
        }

        docBox.appendChild(groupBox);
      }
      list.appendChild(docBox);
    });
  },

  setOccurrenceSelected(id, selected, mode, scope) {
    if (selected) this.state.selection.set(id, { mode: mode || "element", scope: scope ?? null });
    else this.state.selection.delete(id);
    this.els["selection-error"].textContent = "";
  },

  // ---- Stage 3: apply selection, rebuild, validate, export ----
  async onApplyClicked() {
    const errEl = this.els["selection-error"];
    errEl.textContent = "";

    // Explicit submission gate: nothing selected → no edits, content preserved.
    if (this.state.selection.size === 0) {
      errEl.textContent = "Nothing selected — no edits were applied.";
      return;
    }

    const { edits, removedCount } = Editor.applyEdits(
      this.state.matches,
      this.state.selection
    );
    this.state.editedDocs = edits;
    this.state.removedCount = removedCount;
    this.state.pendingEdits = edits;

    const progress = this.els["progress"];
    const statusBox = this.els["validation-status"];
    const downloadBtn = this.els["download-btn"];
    downloadBtn.classList.add("hidden");
    statusBox.innerHTML = "";
    this.showStage("process");
    progress.textContent =
      `${removedCount} edit${removedCount === 1 ? "" : "s"} applied to ${edits.length} document${edits.length === 1 ? "" : "s"}. Rebuilding EPUB…`;

    try {
      const blob = await EpubWriter.rebuild(this.state.epub, edits);
      progress.textContent = "Rebuilt. Validating output…";

      const result = await Validator.validate({
        blob,
        originalEpub: this.state.epub,
        matches: this.state.matches,
        selection: this.state.selection,
        watermark: this.state.watermark,
        editedPaths: edits.map((e) => e.path)
      });
      this.state.outputBlob = blob;
      this.state.validation = result;

      progress.textContent = result.ok
        ? "Done. The cleaned EPUB passed all validation checks."
        : "Validation found problems — review the details below.";

      statusBox.className = "status-box " + (result.ok ? "ok" : "fail");
      const title = document.createElement("strong");
      title.textContent = result.ok
        ? "✓ Validation passed"
        : "✗ Validation failed — do not use this output";
      statusBox.appendChild(title);
      const list = document.createElement("ul");
      list.className = "check-list";
      for (const check of result.checks) {
        const li = document.createElement("li");
        li.className = check.pass ? "check-pass" : "check-fail";
        li.textContent = `${check.pass ? "✓" : "✗"} ${check.name}` +
          (check.detail ? ` — ${check.detail}` : "");
        list.appendChild(li);
      }
      statusBox.appendChild(list);

      // Download only on success — never a misleading success state.
      downloadBtn.classList.toggle("hidden", !result.ok);
      this.els["restart-btn"].classList.remove("hidden");
    } catch (err) {
      progress.textContent = "";
      statusBox.className = "status-box fail";
      statusBox.textContent = `✗ Processing failed: ${err.message}`;
      this.els["restart-btn"].classList.remove("hidden");
    }
  },

  onDownloadClicked() {
    if (!this.state.outputBlob || !this.state.validation || !this.state.validation.ok) return;
    const url = URL.createObjectURL(this.state.outputBlob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "fixed_book.epub";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
};

document.addEventListener("DOMContentLoaded", () => App.init());
