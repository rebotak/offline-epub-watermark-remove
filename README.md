# EPUB Watermark Remover

> # ⚠️ DISCLAIMER — READ THIS FIRST
>
> ## **This tool is for EPUBs that you own. It does not support, facilitate, or condone piracy in any form.**
>
> **Only use it on books you have the legal right to modify** — books you own,
> files from DRM-free stores you bought from, or files someone with the rights
> has explicitly given you. Removing watermarks or usage marks from books you
> do not own is a violation of copyright law, and this project has no interest
> in helping with that.
>
> Watermarks are not always a barrier to ownership — many legitimate,
> personally-owned books carry purchase-tracking strings ("Licensed to
> <your name>", download-site footers, personalization marks) that were stamped
> at download time. Those marks can interfere with **your own** reading of
> **your own** books:
>
> - **Personal use** — a stamped name or site footer cluttering the pages of a
>   book you paid for.
> - **Device compatibility** — watermark markup breaking pagination or layout
>   on your e-reader.
> - **Accessibility tools** — stray footer text read aloud by screen readers
>   in the middle of the story.
> - **Text-to-speech software** — watermarks interrupting narration flow.
>
> That is what this tool is for: helping *you* clean up *your own* library so
> your own books work properly on your own devices and with your own
> accessibility and TTS tools.

---

**Live app:** https://rebotak.github.io/offline-epub-watermark-remove/

## What it is

A fully **offline, browser-based** tool that removes a watermark string from
an EPUB. Everything runs locally in your browser — **nothing is ever uploaded
to a server**. No backend, no CDN, no analytics, no network calls at all: the
app works from a plain `file://` open or any local static server.

## How to use

1. **Open the app** — double-click `index.html` (works straight from disk), or
   serve the folder with any static server (e.g. `python3 -m http.server`).
2. **Upload** your `.epub` and type the exact watermark text
   (e.g. `Licensed to Alice Example`).
3. **Scan** — every content document (chapters, nav, back matter) is searched
   for the exact string, even when inline markup splits it across tags.
4. **Review** — matches appear as HTML blocks with a rendered page preview.
   For each pattern you can choose the removal scope with the ancestor picker:
   the smallest inline element, the default block-level element (`<p>`,
   `<div>`, …), or any outer wrapper. Whole-element removal is the default (no
   empty `<p></p>` left behind); text-only replacement is an explicit
   per-occurrence toggle. Nothing is edited until you approve it.
5. **Apply & download** — the archive is rebuilt (EPUB-valid: `mimetype`
   first, stored uncompressed), automatically re-opened and validated against
   the original, and only then is **`fixed_book.epub`** offered for download.

You can also open the cleaned file with Calibre to double-check it, e.g.:

```sh
ebook-convert fixed_book.epub /dev/null   # parses & validates the whole book
```

## What it preserves

- Every entry you did not approve for editing stays **byte-identical**
  (images, fonts, CSS, metadata, reading order).
- Output validation runs before download: reopen-and-verify, approved blocks
  absent, unapproved occurrences untouched, mimetype-first + STORED checked.

## Project layout

```
index.html        app shell
styles.css        styles
src/
  epub-reader.js  ZIP/EPUB intake, content-document discovery
  matcher.js      exact text-stream matching + ancestor chain resolution
  editor.js       approved element/text edits on the parsed DOM
  epub-writer.js  EPUB-valid archive rebuild
  validator.js    reopen-and-verify checks
  app.js          UI flow (input → review → process → download)
vendor/           vendored JSZip (no CDN)
test/fixtures/    test EPUBs
openspec/         spec-driven change artifacts for this project
```

## License

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**MIT License** — free to use, copy, modify, merge, publish, distribute, sublicense
and sell. The software is provided **"AS IS", without warranty of any kind**, and the
authors accept no liability for any claim or damages arising out of its use — keep a
copy of your original file.

See [NOTICE.md](NOTICE.md) for the no-endorsement statement, the intended use
(for books you own — no piracy), and the contribution terms.

Personal-use tooling, if your book is yours.
