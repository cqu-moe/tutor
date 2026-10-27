# Static diagrams

Lectures use the platform tools already present: Markdown tables become Typst tables through Recto, logic-gate circuits are generated as SVG by Schemdraw, and suitable annotated schematics use CeTZ. Tutor does not define a diagram DSL, registry, or MCP framework.

## Configuration

Create a local Python environment for Schemdraw and pin its parser dependency:

```sh
python3 -m venv .tutor/diagram-venv
.tutor/diagram-venv/bin/pip install -r requirements-diagrams.txt
export TUTOR_DIAGRAM_PYTHON="$PWD/.tutor/diagram-venv/bin/python"
```

Set `TUTOR_TYPST_PACKAGE_CACHE` to a local Typst package cache. CeTZ sources pin `@preview/cetz:0.5.3`; the first compilation may download that package and its package dependencies into the cache. Later offline generation reuses the cache. No global Python or Typst package installation is required.

The lecture agent keeps its session working directory at the course directory. It receives the absolute one-time `.lecture-*` stage and writes native Python or Typst/CeTZ sources under `figures/`, generated SVGs under `media/`, and temporary PNG previews under `qa/`. It must read both the preview and the relevant original page before publishing. For Schemdraw logic trees, use explicit `and`/`or`/`not` expressions; `gateH=1.5` avoids the NOT-symbol overlap seen with the default height.

## Delivery and checks

Recto copies referenced SVGs into `output/media/`. Tutor additionally preserves native regeneration sources in `output/figures/`, so the delivery remains Markdown, Typst, PDF, media, and figure sources without duplicating assets. After export, rebuild from `output/` as documented in [export.md](export.md) and inspect each PDF page as images, not only extractable text. Check gate connections, truth-table values, labels, overbars, arrows, crop margins, and font substitution.

Generation, compilation, or embedding failure retains the reported `.lecture-*` source/assets or `.export-*` partial export. The previously published `output/` is not replaced. A successful tool return is not visual acceptance; the model must inspect the rendered preview and cite redrawn source pages, labeling added views.

## Verification

Set `TUTOR_RECTO_ROOT`, `TUTOR_PYTHON`, `TUTOR_DIAGRAM_PYTHON`, and `TUTOR_TYPST_PACKAGE_CACHE`, then run:

```sh
node --test test/diagrams.test.js
```

The test invokes the actual CLI and Pi tools, fixes model responses only at the HTTP boundary, uses real Schemdraw, CeTZ, Typst, Recto, Pandoc, and Poppler, checks the eight-row F4 truth table and SVG labels, rebuilds the delivered Typst, and verifies a late model failure leaves the prior delivery unchanged.
