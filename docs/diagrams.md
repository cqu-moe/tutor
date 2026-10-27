# Static diagrams

Lectures use the platform tools already present: Markdown tables become Typst tables through Recto, logic-gate circuits are generated as SVG by Schemdraw, and suitable annotated schematics use CeTZ. Tutor does not define a diagram DSL, registry, or MCP framework.

## Configuration

Create a local Python environment for Schemdraw and pin its parser dependency:

```sh
python3 -m venv .tutor/diagram-venv
.tutor/diagram-venv/bin/pip install -r requirements-diagrams.txt
export TUTOR_DIAGRAM_PYTHON="$PWD/.tutor/diagram-venv/bin/python"
```

Set `TUTOR_TYPST_PACKAGE_CACHE` to a local Typst package cache. CeTZ sources pin `@preview/cetz:0.5.3`; populate that cache and its dependencies before generation, for example by compiling a tiny file containing `#import "@preview/cetz:0.5.3"` with `typst compile --package-cache-path "$TUTOR_TYPST_PACKAGE_CACHE"`. Agent commands cannot download missing packages or modify the shared cache. No global Python or Typst package installation is required.

The lecture agent keeps its session working directory at the course directory. It receives the absolute one-time `.lecture-*` stage and writes native Python or Typst/CeTZ sources under `figures/`, generated SVGs under `media/`, and temporary PNG previews under `qa/`. It must read both the preview and the relevant original page before publishing. For Schemdraw logic trees, use explicit `and`/`or`/`not` expressions; `gateH=1.5` avoids the NOT-symbol overlap seen with the default height.

Pi's native `write`, `edit` and `bash` schemas are retained, with mutations executed through the pinned Anthropic sandbox runtime 0.0.81. Only the current stage is writable; absolute paths, parent traversal, symlinks and cross-boundary hardlinks cannot write the published output. Temporary/cache writes stay under the stage's `.tmp`, and the runtime's convenience write directories are explicitly denied. Shell networking is disabled; Tutor's host model/OCR requests remain available. This is a write boundary, not isolation of all readable local files or inherited environment variables.

Node 22.12+ and macOS or Linux are required. Linux also needs the runtime's bubblewrap, socat and ripgrep dependencies; macOS uses system Seatbelt with an added hardlink prohibition. Sandbox initialization or profile mismatch stops the tool without an unsandboxed fallback. The regression suite runs real file tools and drawing commands on macOS; Linux behavior still requires platform validation.

## Delivery and checks

Recto copies referenced SVGs into `output/media/`. Tutor additionally preserves native regeneration sources in `output/figures/`, so the delivery remains Markdown, Typst, PDF, media, and figure sources without duplicating assets. After export, rebuild from `output/` as documented in [export.md](export.md) and inspect each PDF page as images, not only extractable text. Check gate connections, truth-table values, labels, overbars, arrows, crop margins, and font substitution.

Generation, compilation, or embedding failure retains the reported `.lecture-*` source/assets or `.export-*` partial export. The previously published `output/` is not replaced. A successful tool return is not visual acceptance; the model must inspect the rendered preview and cite redrawn source pages, labeling added views.

## Verification

Set `TUTOR_RECTO_ROOT`, `TUTOR_PYTHON`, `TUTOR_DIAGRAM_PYTHON`, and `TUTOR_TYPST_PACKAGE_CACHE`, then run:

```sh
node --test test/diagrams.test.js
```

The test invokes the actual CLI and Pi tools, fixes model responses only at the HTTP boundary, uses real Schemdraw, CeTZ, Typst, Recto, Pandoc, and Poppler, checks the eight-row F4 truth table and SVG labels, rebuilds the delivered Typst, and verifies a late model failure leaves the prior delivery unchanged. It also attempts native file writes, shell writes, symlink writes and hardlink writes against the published lecture, including redirecting the host's final Markdown save through a symlink, and checks that every delivered file remains unchanged.
