# Bun executable with externally installed document tools

Tutor uses Bun for dependency installation, source execution, tests and standalone builds; Node.js execution is no longer a supported installation path. The executable includes the application, Pi, scoped learner memory and their required resources, while Python, Recto, Poppler, Pandoc, Typst and diagram dependencies remain externally installed to preserve the existing document pipeline without embedding a second toolchain.

Build targets are macOS ARM64/x64 and Linux ARM64/x64 with glibc. `tutor doctor` diagnoses local prerequisites without installing software or calling model/OCR APIs; only an explicit `--env-file` loads environment files, and inherited environment variables take precedence. Platform execution and cross-compilation are reported separately.

The local GUI embeds prebuilt static assets in the same executable and shares the persistent teaching-task center with the CLI (ADR 0006); doctor remains a local child command. The GUI is built by the same Bun workspace and root lockfile; Node.js and pnpm are not development requirements. Released Tutor executables still require neither Node.js nor Bun at runtime.
