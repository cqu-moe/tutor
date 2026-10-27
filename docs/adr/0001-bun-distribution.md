# Bun executable with externally installed document tools

Tutor uses Bun for dependency installation, source execution, tests and standalone builds; Node.js execution is no longer a supported installation path. The executable includes the application, Pi, memory extension and their required resources, while Python, Recto, Poppler, Pandoc, Typst and diagram dependencies remain externally installed to preserve the existing document pipeline without embedding a second toolchain.

Build targets are macOS ARM64/x64 and Linux ARM64/x64 with glibc. `tutor doctor` diagnoses local prerequisites without installing software or calling model/OCR APIs; only an explicit `--env-file` loads environment files, and inherited environment variables take precedence. Platform execution and cross-compilation are reported separately.
