# Install Tutor dependencies

Tutor is distributed as one Bun-compiled executable. Users do not need Node.js, Bun, npm, or a Git checkout. The supported targets are macOS arm64/x64 and Linux arm64/x64 glibc systems.

Use this layout throughout the instructions:

```sh
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/tutor"
export PATH="$HOME/.local/bin:$PATH"
export TUTOR_HOME="$HOME/.local/share/tutor"
export TUTOR_PYTHON_BIN=python3
```

## macOS system tools

Install [Homebrew](https://brew.sh/), then install Poppler and a current Python. macOS includes `unzip`, `curl`, and `tar`:

```sh
brew install poppler python@3.13
export TUTOR_PYTHON_BIN=python3.13
pdfinfo -v
pdftoppm -v
"$TUTOR_PYTHON_BIN" --version
```

Install Pandoc 3.9.0.2 and Typst 0.15.1 from their official fixed releases:

```sh
arch=$(uname -m)
case "$arch" in
  arm64)
    pandoc_file=pandoc-3.9.0.2-arm64-macOS.zip
    pandoc_dir=pandoc-3.9.0.2-arm64
    typst_file=typst-aarch64-apple-darwin.tar.xz
    ;;
  x86_64)
    pandoc_file=pandoc-3.9.0.2-x86_64-macOS.zip
    pandoc_dir=pandoc-3.9.0.2-x86_64
    typst_file=typst-x86_64-apple-darwin.tar.xz
    ;;
  *) echo "Unsupported macOS architecture: $arch" >&2; exit 1 ;;
esac

curl -fL "https://github.com/jgm/pandoc/releases/download/3.9.0.2/$pandoc_file" \
  -o "$TUTOR_HOME/$pandoc_file"
curl -fL "https://github.com/typst/typst/releases/download/v0.15.1/$typst_file" \
  -o "$TUTOR_HOME/$typst_file"

unzip -qo "$TUTOR_HOME/$pandoc_file" -d "$TUTOR_HOME"
mkdir -p "$TUTOR_HOME/typst-0.15.1"
tar -xJf "$TUTOR_HOME/$typst_file" -C "$TUTOR_HOME/typst-0.15.1" --strip-components=1
install "$TUTOR_HOME/$pandoc_dir/bin/pandoc" "$HOME/.local/bin/pandoc"
install "$TUTOR_HOME/typst-0.15.1/typst" "$HOME/.local/bin/typst"
pandoc --version
typst --version
```

Poppler is distributed through Homebrew; macOS has no official Poppler binary release. Tutor has no additional Poppler version requirement beyond a working current build.

## Ubuntu / Debian system tools

Install Python, download tools, Poppler, and the Linux write-sandbox dependencies:

```sh
sudo apt update
sudo apt install -y \
  python3 python3-venv curl unzip xz-utils ca-certificates \
  poppler-utils bubblewrap socat ripgrep
python3 --version
pdfinfo -v
pdftoppm -v
bwrap --version
socat -V | head -n 2
rg --version
```

Ubuntu 22.04, Ubuntu 24.04, Debian 12, and newer release packages satisfy these runtime requirements. If your distribution's Python is older than 3.10, use its supported newer-Python package or an official [Python source release](https://www.python.org/downloads/source/); do not run `sudo pip`.

Linux must also permit bubblewrap's user/PID namespaces and `/proc` mount. Installed commands alone do not guarantee this: container defaults or a host's AppArmor policy can deny them. Run `tutor doctor` to test the actual sandbox; if it fails, have the host/container administrator configure the required permissions. Tutor stops sandboxed tools on failure. See [distribution verification](acceptance.md#bun-distribution-verification) for the container settings used during testing.

Install fixed official Pandoc and Typst releases instead of relying on distribution repositories:

```sh
arch=$(dpkg --print-architecture)
case "$arch" in
  amd64) pandoc_file=pandoc-3.9.0.2-linux-amd64.tar.gz ;;
  arm64) pandoc_file=pandoc-3.9.0.2-linux-arm64.tar.gz ;;
  *) echo "Unsupported dpkg architecture: $arch" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64) typst_file=typst-x86_64-unknown-linux-musl.tar.xz ;;
  aarch64) typst_file=typst-aarch64-unknown-linux-musl.tar.xz ;;
  *) echo "Unsupported Linux architecture: $(uname -m)" >&2; exit 1 ;;
esac

curl -fL "https://github.com/jgm/pandoc/releases/download/3.9.0.2/$pandoc_file" \
  -o "$TUTOR_HOME/$pandoc_file"
curl -fL "https://github.com/typst/typst/releases/download/v0.15.1/$typst_file" \
  -o "$TUTOR_HOME/$typst_file"

mkdir -p "$TUTOR_HOME/pandoc-3.9.0.2" "$TUTOR_HOME/typst-0.15.1"
tar -xzf "$TUTOR_HOME/$pandoc_file" -C "$TUTOR_HOME/pandoc-3.9.0.2" --strip-components=1
tar -xJf "$TUTOR_HOME/$typst_file" -C "$TUTOR_HOME/typst-0.15.1" --strip-components=1
install "$TUTOR_HOME/pandoc-3.9.0.2/bin/pandoc" "$HOME/.local/bin/pandoc"
install "$TUTOR_HOME/typst-0.15.1/typst" "$HOME/.local/bin/typst"
pandoc --version
typst --version
```

Typst's official Linux binaries are static musl builds and run on the supported glibc systems. Pandoc's official tarballs are self-contained.

## Recto 0.3.1

Tutor uses Recto 0.3.1 and its sibling `study-notes` skill. The official plugin archive can be downloaded and unpacked without Codex:

```sh
cd "$TUTOR_HOME"
curl -fLO https://github.com/UserUnauthorized/Recto/releases/download/v0.3.1/recto-plugin-0.3.1.zip
curl -fLO https://github.com/UserUnauthorized/Recto/releases/download/v0.3.1/SHA256SUMS
grep ' recto-plugin-0.3.1.zip$' SHA256SUMS > recto-plugin-0.3.1.sha256
if command -v shasum >/dev/null; then
  shasum -a 256 --check recto-plugin-0.3.1.sha256
else
  sha256sum --check recto-plugin-0.3.1.sha256
fi
unzip -qo recto-plugin-0.3.1.zip -d recto-0.3.1
test -f recto-0.3.1/skills/recto/scripts/doctor.py
test -f recto-0.3.1/skills/recto/requirements.txt
test -f recto-0.3.1/skills/study-notes/SKILL.md
```

Create its Python environment and install the packaged requirements:

```sh
"$TUTOR_PYTHON_BIN" -m venv "$TUTOR_HOME/recto-venv"
"$TUTOR_HOME/recto-venv/bin/pip" install \
  -r "$TUTOR_HOME/recto-0.3.1/skills/recto/requirements.txt"
```

## Diagrams and CeTZ cache

Create the pinned Schemdraw environment:

```sh
"$TUTOR_PYTHON_BIN" -m venv "$TUTOR_HOME/diagram-venv"
"$TUTOR_HOME/diagram-venv/bin/pip" install schemdraw==0.23 pyparsing==3.3.3
```

Populate a local Typst package cache with CeTZ 0.5.3 and its declared dependencies. This preparation command may download packages; lecture generation expects the cache to already be populated:

```sh
mkdir -p "$TUTOR_HOME/typst-packages"
printf '#import "@preview/cetz:0.5.3"\n' > "$TUTOR_HOME/cetz-check.typ"
typst compile --package-cache-path "$TUTOR_HOME/typst-packages" \
  "$TUTOR_HOME/cetz-check.typ" "$TUTOR_HOME/cetz-check.pdf"
```

Export the final configuration in your shell profile, using absolute paths after expansion:

```sh
export TUTOR_RECTO_ROOT="$TUTOR_HOME/recto-0.3.1/skills/recto"
export TUTOR_PYTHON="$TUTOR_HOME/recto-venv/bin/python"
export TUTOR_DIAGRAM_PYTHON="$TUTOR_HOME/diagram-venv/bin/python"
export TUTOR_TYPST_PACKAGE_CACHE="$TUTOR_HOME/typst-packages"
```

Also keep `PATH="$HOME/.local/bin:$PATH"` and `TUTOR_HOME` in the profile so Tutor can find its executable, external commands, and dependency paths.

## Tutor executable and doctor

Download `tutor-executables` from a successful [Bun distribution workflow run](https://github.com/cqu-moe/tutor/actions/workflows/distribution.yml) and unpack it into `dist/`, or use a local build's `dist/` output. Actions artifacts expire after 7 days. CI builds all four targets and verifies the Linux x64 executable on a native runner before uploading. These are build artifacts, not a signed or notarized release. The build artifact names are:

```text
dist/tutor-darwin-arm64
dist/tutor-darwin-x64
dist/tutor-linux-arm64
dist/tutor-linux-x64
```

The artifact includes `SHA256SUMS`; verify it inside `dist/` with `sha256sum --check SHA256SUMS` on Linux or `shasum -a 256 --check SHA256SUMS` on macOS. GitHub's ZIP download does not preserve executable permissions; the `install -m 755` command below restores them.

Install the file matching your platform as `tutor`:

```sh
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) tutor_artifact=dist/tutor-darwin-arm64 ;;
  Darwin/x86_64) tutor_artifact=dist/tutor-darwin-x64 ;;
  Linux/aarch64) tutor_artifact=dist/tutor-linux-arm64 ;;
  Linux/x86_64) tutor_artifact=dist/tutor-linux-x64 ;;
  *) echo "Unsupported platform: $(uname -s)/$(uname -m)" >&2; exit 1 ;;
esac
install -m 755 "$tutor_artifact" "$HOME/.local/bin/tutor"
tutor --version
```

If credentials and other environment variables are kept in a file, load it explicitly with `--env-file`. Existing environment variables take precedence over values in the file:

```sh
tutor --env-file "$HOME/.config/tutor/env" doctor --ocr mistral
# or:
tutor --env-file "$HOME/.config/tutor/env" doctor --ocr mineru
```

Doctor checks configured paths and versions, Python packages, Poppler, the Typst cache, Linux sandbox commands, the selected model's existence and image capability, and whether model and selected OCR credentials are configured. It does not validate live model or OCR connectivity and does not prove that credentials are accepted.

It returns exit status 0 when all checks pass and 1 when a prerequisite is missing or broken. It does not install tools, download packages, execute command-based model credentials, or modify the Pi configuration. A configured credential command is reported as present; its execution and result remain unchecked.

Model setup is described in [models.md](models.md), and OCR credentials are described in [ocr.md](ocr.md).

## Sources

- Recto 0.3.1 and its checksums: [official GitHub release](https://github.com/UserUnauthorized/Recto/releases/tag/v0.3.1)
- Pandoc 3.9.0.2: [official release](https://github.com/jgm/pandoc/releases/tag/3.9.0.2) and [install guide](https://pandoc.org/installing.html)
- Typst 0.15.1: [official release](https://github.com/typst/typst/releases/tag/v0.15.1)
- Poppler: [Homebrew formula](https://formulae.brew.sh/formula/poppler) and [upstream releases](https://poppler.freedesktop.org/releases/)
