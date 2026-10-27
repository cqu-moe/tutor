# Learner memory

Tutor uses the local `pi-memory@0.4.2` Pi extension for learner memory. The extension owns storage, reads, writes, deletion, and recovery; Tutor only supplies the course tag and teaching rules.

## Storage

By default, Tutor stores learner memory in `<data-dir>/.memory`, separate from the user-level Pi memory used by other Pi tools. The hidden directory cannot collide with a normalized course name. Scope is configured before the extension is loaded. Set `PI_MEMORY_DIR` to an absolute path to use another store, as the tests do:

Course directories retain a `.course-name` marker containing the exact trimmed,
Unicode-NFC course name. Existing courses without that marker are migrated from
`context.json` on their next resume. A marker-less directory with neither a
usable `context.json` nor a marker created by the current invocation is treated
as unowned legacy state and rejected, even when empty; move it aside, manually
record the exact original course name in `.course-name`, or use another course
name/data directory. If two names produce the same directory slug—for example,
`Digital Design` and `digital-design`—Tutor rejects the later name before
model, memory, OCR, or output work instead of merging their state.

```sh
PI_MEMORY_DIR=/path/to/isolated-memory tutor --course "Digital Design" ...
```

Tutor forces `PI_MEMORY_EXIT_SUMMARY=0`, `PI_MEMORY_QMD_UPDATE=off`, and `PI_MEMORY_NO_SEARCH=1`. There is no automatic exit summary, qmd installation or embedding download. The session exposes these pi-memory tools:

- `memory_read`
- `memory_write`
- `memory_forget`
- `memory_restore`

## What is remembered

During route discussion, the model is instructed to write explicit learner feedback automatically, without a confirmation step:

- `#progress [[course:<slug>]]` for explicit progress in one course
- `#weakness [[course:<slug>]]` for a specific difficulty in one course
- `#preference #global` for a preference that applies across courses

A current explicit request overrides a saved preference for that route. Progress and weaknesses with another course tag must not affect the current route. Untagged memories are ignored as course evidence.

A weakness inferred from dialogue or an optional exercise must include its evidence and `Status: pending verification`. It never becomes a general ability label. Proposing, generating, exporting, viewing, or resuming a lecture is not evidence of progress or mastery.

The course tag is an application-level scope rule, not security isolation. pi-memory reads the shared long-term file, so a model or future tool change must continue to obey the teaching rule; the tag does not provide a permission boundary.

Storage is local; relevant memory is included in requests to the configured model provider along with the conversation.

Each fact is appended as a separate block so a correction/deletion does not discard unrelated facts in the same block. Only learner facts belong here; credentials and original course material do not. Model extraction and scope selection remain model-dependent.

## Viewing, correcting, and deleting

Use `--memory` without a PDF, pages or OCR credentials. This uses the same Pi model configuration as tutoring; model credentials are still required:

```sh
tutor --course "Digital Design" --data-dir .tutor --memory "Show my learner memory"
tutor --course "Digital Design" --data-dir .tutor --memory "Correct my progress: I have not learned Boolean algebra yet"
tutor --course "Digital Design" --data-dir .tutor --memory "Delete my Digital Design progress"
tutor --course "Digital Design" --data-dir .tutor --memory "Restore recovery ID <returned-id>"
```

The same requests can be made in the route conversation:

```text
Show my learner memory
Correct my progress: I have not learned Boolean algebra yet
Delete my Digital Design progress
Restore recovery ID <returned-id>
```

Correction is a pi-memory deletion followed by a replacement write. It is not transactional: if the replacement fails, Tutor includes the successful deletion's Recovery ID in the error so you can restore the removed record. Deletion uses case-insensitive substring matching and removes entire matching blocks; use a precise course-tagged fact. It creates a recovery record and `memory_restore` can put the removed entry back. Deletion therefore does not physically erase recovery records, backups, or previous transcripts. Deleted facts should stop influencing new prompts; they may still appear in old conversation text.

Tutor checks that existing long-term memory is readable before loading the plugin, and reports memory-tool failures without printing the model's subsequent success claim. Route and maintenance responses are shown only after tools succeed and the model finishes normally; truncated, errored or aborted responses fail. The underlying plugin is a small local Markdown store without concurrent-writer locking: use one Tutor process per memory directory when writing.

pi-memory's injected long-term snapshot is limited to 4,000 characters (overall context 16,000). Tutor asks the model to use `memory_read` for complete/current state. Very large stores can still exceed the model's context window; qmd/embeddings are outside this version. CLI tests fix only HTTP responses and exercise actual plugin storage across processes; live-model evidence is recorded separately from deterministic prompt-contract checks.
