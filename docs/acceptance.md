# Real-course acceptance

This page is the reproducible acceptance path. It keeps four kinds of evidence separate: actual CLI behavior, real external services, PDF/content review, and the user's teaching-quality evaluation. A passing build does not imply that the user has judged the lecture suitable as a course replacement.

## Runtime

The original integration was checked on macOS with Node.js 22. The supported development runtime is now Bun 1.4.4+; distribution uses standalone executables with lockfile-pinned Pi 0.82.1, pi-durable 1.4.0 and sandbox runtime 0.0.81. Export also needs Python 3.10+, Recto 0.3.1, Pandoc 3.9.0.2+, Typst 0.15.1+, and Poppler. Diagram generation additionally needs the configured Schemdraw 0.23 Python environment (`TUTOR_DIAGRAM_PYTHON`) and populated CeTZ 0.5.3 package cache (`TUTOR_TYPST_PACKAGE_CACHE`). Install these tools in user-local or project-local locations; Tutor does not require a global install. See [sandbox platform requirements](diagrams.md) before running on Linux.

CLI and GUI enforce one writer for the entire data directory with an OS lock, including mutation endpoints and supervised document commands. Close the GUI executor before starting a direct CLI writer. Separate data directories may share an explicitly configured memory root only when their access is serialized; concurrent shared-memory writers are not supported. Real acceptance data, original PDFs, OCR bodies, transcripts, credentials, rendered pages, and reports stay outside the Git repository.

## Bun distribution verification

The [Bun distribution workflow](../.github/workflows/distribution.yml) builds all four executables and runs the complete suite against the relocated Linux x64 binary on a native `ubuntu-22.04` runner. It removes `node_modules` and staging resources before startup, doctor and integration checks. Doctor uses local fixture credentials; no model/OCR secrets are needed. Only a successful run uploads the four binaries and their `SHA256SUMS` as `tutor-executables`. Pushes, pull requests and manual dispatches trigger this workflow; artifact retention is 7 days.

## Version 0.2.0 course and restart acceptance

The acceptance boundary is public CLI and local GUI HTTP with real filesystem, official Pi SQLite storage, process SIGKILL, and actual Recto/Pandoc/Typst/Poppler export. Only model/OCR HTTP responses are fixed at localhost; no personal materials, live provider accounts or production credentials are used.

`test/release.test.js` owns the combined journey: import and really export a Logic lecture, reopen its old-format draft/output as a legacy course, import Calculus, explicitly mark learned and in-progress chapters, save different course preferences and a shared global preference, append material through GUI HTTP, kill/reopen while still awaiting confirmation, confirm then kill during generation, and resume the same task through CLI. It reads actual Markdown, Typst, PDF text and manifest files and compares their GUI downloads. It checks stable course/chapter/material IDs, route order and source bindings, every original source byte, entire protected chapter outputs, scoped facts once with global inheritance, no duplicate OCR/route work, and no generation replay on completed resume. The interrupted unfinished model request may be sent again; provider billing is not an exactly-once contract.

The focused suites remain the acceptance owners for the other boundaries:

| Contract | Executed public regression owner |
| --- | --- |
| Published legacy chapter survives later whole-course publication; migration filesystem failure/retry and untouched originals | `test/legacy-courses.test.js` |
| Stamped/BOM/CRLF legacy facts, daily/ambiguous pending, recovery IDs, failed memory migration/retry, scoped correction/deletion/restoration and progress authority | `test/memory-contract.test.js`, `test/memory.test.js` |
| Read-only intent, explicit global maintenance, scope exclusions and universal future preferences | `test/memory-intent.test.js` |
| Known/unknown OCR results, waiting/cancel, unsafe tools, descendant ownership, bounded model retries, publication rename windows and effect-before-terminal binding | `test/resume.test.js` |
| Actual memory effect committed before tool receipt, then SIGKILL/replay exactly once | `test/memory-contract.test.js` |
| Real diagram generation/export and both source/large-preview image attachments delivered through durable reads | `test/diagrams.test.js` |
| GUI chapter revision, files and admission/session/file access boundaries | `test/gui-courses.test.js`, `test/gui.test.js` |

These are behavioral tests, not wrappers that call other suites. Run the final required gates from a fresh checkout with external document tools configured as described above:

```sh
bun install --frozen-lockfile
# This must leave the tracked root bun.lock unchanged.
git diff --exit-code -- bun.lock
bun --no-env-file run check:design
bun --no-env-file run typecheck
bun --no-env-file run test
bun --no-env-file run build darwin-arm64 darwin-x64 linux-arm64 linux-x64
```

GUI production build is part of the four-target build. For consumer verification, copy the native executable outside the checkout, temporarily move root/GUI `node_modules`, GUI `dist` and `.build/resources` out of their normal locations, and use an EXIT cleanup trap to restore them. Run the same suite from the consumer directory with `TUTOR_TEST_BINARY=/absolute/consumer/tutor`. Source execution and a successful cross-compile do not establish standalone or other-platform execution.

Local 0.2.0 verification (2026-11-02) uses the release patch integrating `99246a703b822ed2dcd77d9ad938be4da1a9f299`, Bun `1.4.4+38afee6c8`, and root lock SHA-256 `736a670a816cd42ca7c2ad226be801be8050911c8898bff11c2c3448cb4cd309`:

| Gate / target | Current evidence |
| --- | --- |
| Frozen root install | PASS, unchanged lock; Node/npm/npx/pnpm blocked in PATH |
| GUI design / type / production build | PASS; existing Vite chunk-size advisory only |
| Full source suite | PASS, 48/48 across 17 files, 268.31s |
| macOS ARM64 | Compiles; relocated native executable PASS, 48/48 across 17 files, 198.52s; own root/GUI dependencies, GUI dist and staged resources unavailable |
| macOS x64 / Linux ARM64 / Linux x64 | All compile; no local execution claim for these targets |

The pre-#19 corrective integration `99246a7` passed native Linux x64 with 47 tests in [run 41352821825](https://github.com/cqu-moe/tutor/actions/runs/41352821825). That run predates the 0.2.0 version change and combined 48th test; it is not final #19 or published-release evidence.

Native Linux x64 remains a required main-branch CI gate; main/release/download verification is performed by the release owner and must be attached to the exact published source SHA. No publication is claimed by this preparation record. The [release installation commands](install.md#tutor-executable-and-doctor) select a platform asset, verify its SHA-256, and inspect application version/source/lock/Bun provenance.

The independent final browser matrix is recorded in [GUI validation](gui-validation.md): waiting and terminal states in both themes at four widths, persisted waiting/cancel, explicit new generation, actual PDF download, and reduced-motion mobile navigation. The #19 changes leave UI source untouched.

This acceptance covers process interruption. It does not cover deleted inputs, lost disks, remote backups, real provider quality, real phones or user evaluation of whether the lecture can replace courseware.

## Historical first-version distribution evidence

Everything in this section describes the 2026-10-28 first-version build. Its 11-test counts, Rosetta/container runs and old native CI are retained for history and do not prove 0.2.0 compatibility.

Native Linux x64 validation passed on 2026-10-28 (Asia/Shanghai): [Actions run 40548722729](https://github.com/cqu-moe/tutor/actions/runs/40548722729), commit `9d46b986d914c0ad513dd3b58ea9c2897f49af99`. All doctor checks and all 11 integration tests passed, including diagrams, export/revision and sandbox write boundaries. All four executables built successfully and were uploaded with checksums. No container, architecture emulator or sandbox bypass was used for this run.

The following table records the earlier local verification, before native GitHub Actions validation:

The Bun 1.4.4 build was executed for all four targets. The same CLI integration suite was then run against each executable using `TUTOR_TEST_BINARY`:

| Executable | Execution environment | Result |
| --- | --- | --- |
| `tutor-darwin-arm64` | Apple Silicon macOS, executable moved outside the checkout and `node_modules` temporarily removed | 11 passed, 0 failed |
| `tutor-darwin-x64` | Apple Silicon macOS through Rosetta | 11 passed, 0 failed |
| `tutor-linux-arm64` | Ubuntu 24.04 ARM64 container, non-root user, network disabled | 11 passed, 0 failed |
| `tutor-linux-x64` | Ubuntu 24.04 x64 container through Rosetta on ARM64 | 8 passed, 3 failed at the sandbox boundary; superseded by the native CI result above |

Linux containers received only the executable, test files and external document dependencies; no application source, `node_modules`, separately installed Bun or Node.js was present. The embedded runtime ran the test harness with `BUN_BE_BUN=1`, which a preload removed before launching Tutor subprocesses. Test fixtures require `zip` in addition to the application's installation dependencies.

The container sandbox tests required `--cap-add SYS_ADMIN --security-opt seccomp=unconfined --security-opt systempaths=unconfined` so bubblewrap could create nested namespaces and mount `/proc`. These were isolated test-container settings, with `--network none`, `--user 1000:1000` and read-only dependency mounts. Tutor's own seccomp and filesystem policies stayed enabled. Default container restrictions rejected the nested sandbox.

On Linux x64 under Rosetta, `apply-seccomp` returned `prctl(PR_SET_SECCOMP, stub): Invalid argument`. Direct execution of the unmodified upstream x64 helper reproduced the failure, while its ARM64 counterpart succeeded. The affected tests were diagram generation, lecture export/revision, and revision. No sandbox bypass was added; these tests subsequently passed on the native Linux x64 runner.

The passing suites exercise real Python/Schemdraw/CeTZ/Typst/Recto/Pandoc/Poppler commands, image handling, PDF export/rebuild, persistent memory, revisions and denied writes outside the lecture stage. Model and OCR responses are fixed at the local HTTP boundary. Doctor also passed all local checks on macOS ARM64 and Linux ARM64 with fixture credentials, and its regression verifies explicit environment-file loading, inherited-variable precedence, unchanged Pi configuration, no model requests and no execution of command-based credentials.

To rerun on a native target after configuring its document tools:

```sh
bun install --frozen-lockfile
bun run build
TUTOR_TEST_BINARY="$PWD/dist/tutor-$(uname -s | tr '[:upper:]' '[:lower:]')-$(bun -p process.arch)" bun run test
```

These results do not establish live model/OCR access, native Intel Mac compatibility, macOS signing/notarization, or teaching quality. No release was published as part of this verification.

## Historical real-course protocol

The following protocol describes the first-version canonical #7 material and retained service observations. For current deterministic fixtures, use the 0.2.0 gates above. New live-provider and teaching-quality review must be recorded separately.

### Prepare an isolated run

```sh
bun install --frozen-lockfile
python3 /path/to/recto/skills/recto/scripts/doctor.py --style reference
```

Put model configuration in the selected Pi agent directory and OCR credentials in the process environment. Tutor loads environment files only with explicit `--env-file FILE`; inherited environment variables take precedence. Keep the file ignored and never copy its values into course output or evidence.

For final combined acceptance, reuse the canonical #7 course directory rather than importing and generating a duplicate lecture. Copy that directory into a fresh data directory, point `PI_MEMORY_DIR` at a fresh store, and remove OCR credentials from the revision-process environment. Successful revisions with the cache present therefore also verify that unchanged materials do not require another OCR call.

### Exercise the learner path

For a new import, run the command in [README.md](../README.md), inspect the route against the original pages, send at least one concrete adjustment, then type `confirm`. Check that the route files and output contain the expected original-page provenance.

For combined acceptance over the canonical course, run three separate `--revise` processes:

1. Ask for a targeted re-explanation while explicitly reporting current progress and one specific difficulty.
2. Ask for a missing derivation while stating a durable preference and a one-off request that overrides it for this revision.
3. Ask for a replacement example and require the explanation to use the saved difficulty.

Between revisions, inspect the delivered `content.md`, `typst/document.typ`, `document.pdf`, and `media/`. Unrequested sections and effective figure references must survive; failed generation or export must leave the prior output and all source/OCR artifacts available.

Preserve checks compare image bytes rather than requiring stable media filenames: Recto may add another content-hash prefix when re-exporting unchanged assets.

Exercise memory through separate CLI processes: view the saved facts, correct the progress record, delete a precise course-tagged weakness, and read again. Run one second-course memory request and verify that its facts are not used as Digital Design progress or weakness. Record the deletion Recovery ID, but do not claim that recovery history, backups, or old transcripts were erased.

### Rebuild and inspect

From the course output directory:

```sh
typst compile --root . --font-path typst/fonts typst/document.typ qa-rebuilt.pdf
pdftoppm -png -r 120 qa-rebuilt.pdf qa-page
```

Inspect every rendered page. Check Chinese text and formulas, the complete eight-row truth table, expression-to-gate connections and labels, the annotated diagram, citations, additions/redraw labels, page breaks, clipping, and vector figure legibility after zoom. Compare the mathematical and connection claims with the original PDF pages 21-24; do not treat OCR, a successful compiler run, or file extensions as semantic correctness.

### Evidence

Record each command's exit status, bounded duration, sanitized arguments, file hashes, and relevant stdout/stderr without credentials or upstream secret echoes. Separate controlled tests with fixed HTTP responses from live model and OCR observations. MinerU's known upstream signed-upload `403 SignatureDoesNotMatch` remains an unverified service limitation; do not silently retry or substitute Mistral evidence for MinerU success.

The final report must state which checks were actually run, which prior real evidence was reused and from which artifact, and which limitations remain. Until the user reads the sample and gives teaching feedback, record teaching suitability as pending evaluation.
