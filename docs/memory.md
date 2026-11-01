# Learner memory

Tutor keeps course facts separate using the persisted UUID in `course.json`. A course session can read its own facts and inherited global preferences. Its tools cannot select another course by name, slug, UUID or recovery ID. The same boundary applies to injected context and file tools; retained session archives and raw memory are not course source files.

Ordinary feedback belongs to the current course. Only an explicit cross-course preference can be written globally. Replies use the current request first, then course preferences, then global defaults. Temporary requests do not change durable facts. The model still interprets natural language; Tutor checks the selected scope, evidence and allowed mutation phase at execution time.

## Storage and migration

The active authority is `<data-dir>/.memory/memory.sqlite`, or `PI_MEMORY_DIR/memory.sqlite` when configured. It uses the official pi-durable Session document and transaction APIs. There is no separate workflow/task database in memory storage. The existing per-course `.durable/session.sqlite` owns durable execution. Memory maintenance has its own conversation in that course Harness, so it cannot reset the teaching route's conversation or recovery selection.

Course names retain their `.course-name` ownership/collision checks. Even an empty course gets a persisted UUID through `ensureCourse`; directory slugs and textual tags are not the storage identity.

On upgrade, Tutor reads legacy `MEMORY.md`, `SCRATCHPAD.md`, `daily/` and `recovery/*.json`. It leaves these originals unchanged. Timestamped entries retain their full multi-paragraph boundary, including BOM/CRLF inputs. Known course tags map through course names/slugs to stable UUIDs. Explicit global preferences remain global. Recovery IDs and their restored status are retained.

Unknown tags, mixed scopes, untagged facts, daily/scratchpad content, unsupported facts and ambiguous progress remain pending. Their contents never enter model context. A pending course tag can be resolved after that course is explicitly established. Unambiguous old progress maps to one saved chapter only when it does not conflict with newer authoritative progress; provisional import chapters cannot consume it before a potentially rejected route. Unknown/conflicting progress remains pending. Invalid/unreadable migration inputs fail visibly, leave originals usable and can be repaired and retried. A successful transaction captures the original inputs once. Later legacy-file changes are not another writer; pending resolution reads that captured input. Completed imports and operation receipts prevent reimporting a deleted fact on every open.

Legacy revision-session files remain on disk but are not reopened as model history. This prevents old unscoped tool results from reintroducing another course's facts. Recovery does not mean physical erasure of archives, originals or old transcripts.

## Viewing and maintaining

Use the GUI learning-feedback panel or the CLI with the existing local model configuration. These requests need no OCR credentials or new course materials:

```sh
tutor --course "Digital Design" --data-dir .tutor --memory "Show my learner memory"
tutor --course "Digital Design" --data-dir .tutor --memory "I have learned Boolean algebra"
tutor --course "Digital Design" --data-dir .tutor --memory "Delete my truth-table preference"
tutor --course "Digital Design" --data-dir .tutor --memory "Restore recovery ID <returned-id>"
# Resume the original admitted memory request after process interruption:
tutor --course "Digital Design" --data-dir .tutor --memory "resume" --resume
```

The model has four tools: `memory_read`, `memory_write`, `memory_forget` and `memory_restore`. They accept only `target=long_term`. Scope defaults to the current course; `scope=global` explicitly selects global maintenance. Writes use one `#preference` or `#weakness` fact. Legacy current-course tags are accepted for compatibility but cannot grant another course's scope.

Learning progress is projected directly from course chapters, never saved as an independent text fact. A progress write needs a known current-course `chapterId`, a status (`pending`, `in_progress`, `learned`) and a verbatim learner quote explicitly stating that status. Ambiguous wording, questions and unsupported status phrasing are rejected rather than inferred. The direct CLI `--chapter-id ID --progress STATUS` and GUI chapter controls update the same authority. Inferred weaknesses need actual feedback evidence and remain `Status: pending verification`.

Import, route proposal, lecture generation, export and opening a document cannot authorize a memory write. An explicit route adjustment, revision feedback or memory request supplies the learner-feedback capability. Course source text cannot supply it. Temporary requests cannot mutate durable memory.

Deletion removes whole matching facts within the selected scope and returns a Recovery ID. Forgetting chapter progress resets that chapter to pending; recovery restores its saved status. Correction is scoped forget followed by append, with each effect committed separately. If the replacement fails, Tutor exposes the successful deletion's Recovery ID and suppresses a subsequent model success claim. Read-only/unreadable storage and incomplete model answers also fail visibly.

## Process interruption

Memory effects and their domain receipts commit together in one official Pi document transaction. The receipt key uses the persisted official tool task ID plus course UUID, not the provider's possibly reused tool-call ID. Replaying the same interrupted tool returns its stored result; a new explicit submission has a fresh identity even if its text and provider call ID repeat.

Progress uses the same receipt to commit an intent before the course-file setter. Recovery compares chapter authority before applying the setter again, then completes the receipt. This avoids duplicate facts, deletions or chapter-version increments after process interruption. It does not promise exactly-once model requests or provider billing.

Use one writer for a data directory. The full teaching-task lifecycle and cross-process data-directory lock belong to the task-runtime follow-up. This contract covers process interruption, not lost disks, deleted data directories or multi-device synchronization.
