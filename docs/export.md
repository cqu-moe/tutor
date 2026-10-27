# Lecture export

After a teaching route is confirmed, Tutor uses the configured Pi model and installed Recto `study-notes` instructions to write a complete lecture. Pandoc normalizes standard inline/display math delimiters into semantic Markdown; the real Recto exporter then produces the PDF and Typst. Tutor rebuilds the delivered Typst source before publishing the output directory.

## Configuration

- `TUTOR_RECTO_ROOT`: directory of the installed Recto **skill**, containing `scripts/doctor.py` and `scripts/export.py`. Tested against Recto 0.3.1; no scripts, templates, or fonts are vendored into Tutor.
- `TUTOR_PYTHON`: optional path to a Python interpreter that passed Recto's dependency check. When omitted, Tutor uses `python3`.
- `TUTOR_STUDY_NOTES`: optional path to the installed `study-notes/SKILL.md`. By default Tutor reads the sibling skill beside `TUTOR_RECTO_ROOT`.
- `TUTOR_DIAGRAM_PYTHON`: Python interpreter with the pinned diagram dependencies in `requirements-diagrams.txt`; required for Schemdraw circuit generation.
- `TUTOR_TYPST_PACKAGE_CACHE`: local Typst package cache containing or able to fetch the pinned CeTZ package.

Recto 0.3.1 requires Python 3.10+, python-docx 1.2.x and lxml 5.x/6.x, Pandoc 3.9.0.2+, and Typst 0.15.1+. Run its `doctor.py --style reference` using your chosen interpreter. Use the desktop bundled Python when available; do not install globally. Pi remains pinned in the package lock.

Tutor exports the Markdown source through Recto's `reference` style to:

```text
output/content.md
output/document.pdf
output/media/
output/figures/
output/typst/document.typ
```

The delivery has one Markdown source, one shared media directory, native figure-regeneration sources, Typst, and PDF. Original page images and screenshots are sent to the model for verification. OCR-extracted figures carry page/screenshot provenance and may be selected for the final lecture. Whole-page screenshots are not offered as final illustrations. Generated static diagrams follow [diagrams.md](diagrams.md).

Chinese is the default with English key terms retained on first use; current user adjustments prevail. The confirmed route controls order and explicit scope changes. Coverage is derived from every selected source, including details omitted by route headings. The lecture requests prerequisites, reasoning, worked examples, source citations, marked additions, and a coverage note. These instructions guide the model; they are not an automated proof of teaching quality. Recto's reference template uses Chinese typography; other-language typography needs separate visual verification.

Only the final assistant message with a successful stop is exported; tool-call preludes, errors, aborted and truncated responses cannot become a successful delivery. Generation and export use fresh staging directories. On failure, sources/assets remain in the reported `.lecture-*` path and the last successful `output/` is untouched. Publication restores the previous output if the final rename fails. Run one task at a time per course directory.

Lecture generation uses the same memory-aware prompt helper as route discussion and maintenance. Failed memory tools block publication, and model failures report safe status/configuration guidance without arbitrary upstream bodies. Partial assistant text is retained as a draft only. Generating a lecture does not itself create learner progress or mastery evidence.

To retry generation from the saved route without re-importing or calling OCR:

```sh
node bin/tutor.js --course "Digital Design" --data-dir .tutor --generate
```

The saved context must already have a confirmed route. `--generate` rejects new PDF/page/screenshot options and checks confirmation again in the new process. Model and agent directory options still apply. It regenerates the lecture; it is not a revision command. The parser/route artifacts and originals are preserved. A new import resets confirmation before generating a new route.

## Rebuild

From the course output directory, rebuild the delivered PDF with:

```sh
typst compile --root . --font-path typst/fonts typst/document.typ document.pdf
```

PDF compilation alone does not replace visual inspection. Check rendered text, formulas, tables, figures, citations, and pagination after rebuilding.

## Verification

Set `TUTOR_RECTO_ROOT` and `TUTOR_PYTHON`, then run `npm test`. `test/lecture.test.js` invokes the actual bin, with model/OCR fixtures only at HTTP boundaries. It uses real Recto, Pandoc, and Typst; checks extractable PDF content, shared media, rebuilding, route adjustment, confirmation on restart, and failed export/model preservation. It fails with dependency guidance when Recto is not configured rather than silently skipping the export check. Other route/model tests stop before confirmation; `test/diagrams.test.js` additionally owns confirmed generated diagrams.

Real provider evidence and private sample outputs belong outside the repository. Fixture tests do not prove model teaching quality or live OCR success. User evaluation of whether the lecture can replace the course slides remains separate.
