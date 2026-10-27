# Real-course acceptance

This page is the reproducible acceptance path. It keeps four kinds of evidence separate: actual CLI behavior, real external services, PDF/content review, and the user's teaching-quality evaluation. A passing build does not imply that the user has judged the lecture suitable as a course replacement.

## Runtime

The integration was checked on macOS with Node.js 22 (22.12+ required), lockfile-pinned Pi 0.82.1, pi-memory 0.4.2 and sandbox runtime 0.0.81. Export also needs Python 3.10+, Recto 0.3.1, Pandoc 3.9.0.2+, Typst 0.15.1+, and Poppler. Diagram generation additionally needs the configured Schemdraw 0.23 Python environment (`TUTOR_DIAGRAM_PYTHON`) and populated CeTZ 0.5.3 package cache (`TUTOR_TYPST_PACKAGE_CACHE`). Install these tools in user-local or project-local locations; Tutor does not require a global install. See [sandbox platform requirements](diagrams.md) before running on Linux.

Use one course directory and one learner-memory directory per concurrent writer. Real acceptance data, original PDFs, OCR bodies, transcripts, credentials, rendered pages, and reports stay outside the Git repository.

## Prepare an isolated run

```sh
npm ci --ignore-scripts --no-audit --no-fund
python3 /path/to/recto/skills/recto/scripts/doctor.py --style reference
```

Put model configuration in the selected Pi agent directory and OCR credentials in the process environment. Tutor does not load an env file by itself; when using Node 20.6+, start it with `node --env-file=.env.local`. Keep the file ignored and never copy its values into course output or evidence.

For final combined acceptance, reuse the canonical #7 course directory rather than importing and generating a duplicate lecture. Copy that directory into a fresh data directory, point `PI_MEMORY_DIR` at a fresh store, and remove OCR credentials from the revision-process environment. Successful revisions with the cache present therefore also verify that unchanged materials do not require another OCR call.

## Exercise the learner path

For a new import, run the command in [README.md](../README.md), inspect the route against the original pages, send at least one concrete adjustment, then type `confirm`. Check that the route files and output contain the expected original-page provenance.

For combined acceptance over the canonical course, run three separate `--revise` processes:

1. Ask for a targeted re-explanation while explicitly reporting current progress and one specific difficulty.
2. Ask for a missing derivation while stating a durable preference and a one-off request that overrides it for this revision.
3. Ask for a replacement example and require the explanation to use the saved difficulty.

Between revisions, inspect the delivered `content.md`, `typst/document.typ`, `document.pdf`, and `media/`. Unrequested sections and effective figure references must survive; failed generation or export must leave the prior output and all source/OCR artifacts available.

Preserve checks compare image bytes rather than requiring stable media filenames: Recto may add another content-hash prefix when re-exporting unchanged assets.

Exercise memory through separate CLI processes: view the saved facts, correct the progress record, delete a precise course-tagged weakness, and read again. Run one second-course memory request and verify that its facts are not used as Digital Design progress or weakness. Record the deletion Recovery ID, but do not claim that recovery history, backups, or old transcripts were erased.

## Rebuild and inspect

From the course output directory:

```sh
typst compile --root . --font-path typst/fonts typst/document.typ qa-rebuilt.pdf
pdftoppm -png -r 120 qa-rebuilt.pdf qa-page
```

Inspect every rendered page. Check Chinese text and formulas, the complete eight-row truth table, expression-to-gate connections and labels, the annotated diagram, citations, additions/redraw labels, page breaks, clipping, and vector figure legibility after zoom. Compare the mathematical and connection claims with the original PDF pages 21-24; do not treat OCR, a successful compiler run, or file extensions as semantic correctness.

## Evidence

Record each command's exit status, bounded duration, sanitized arguments, file hashes, and relevant stdout/stderr without credentials or upstream secret echoes. Separate controlled tests with fixed HTTP responses from live model and OCR observations. MinerU's known upstream signed-upload `403 SignatureDoesNotMatch` remains an unverified service limitation; do not silently retry or substitute Mistral evidence for MinerU success.

The final report must state which checks were actually run, which prior real evidence was reused and from which artifact, and which limitations remain. Until the user reads the sample and gives teaching feedback, record teaching suitability as pending evaluation.
