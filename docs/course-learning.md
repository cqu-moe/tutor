# Long-term course learning

Tutor keeps a course in `<data-dir>/<course-slug>/course.json`. The record owns the course identity, accumulated materials, courseware chapters, teaching route, explicit learning progress, and chapter lecture bindings. `draft.json` remains the compatibility input for the current teaching conversation, while `output/` continues to hold the whole-course lecture.

Entering a course through `--chapters`, memory maintenance, or the GUI's「先建立空课程」action creates the empty record immediately. The generated course UUID is stable across later entries; the slug is only its storage directory. GUI state and detail responses expose that UUID as `courseId`.

## Materials and chapters

An import is committed to `course.json` only after its OCR results validate. A material identity is based on the source bytes, selected pages, and supplementary screenshot bytes. Re-importing the same bundle reuses its OCR cache and adds no chapters. Changed source bytes become a new material version; Tutor never overwrites the older version silently.

When a page-range import covers PDF bookmarks, each bookmark becomes a source-named chapter with its material version and page span. A missing bookmark title or repeated title within/across versions is marked `needsConfirmation`. Such chapters are listed, but route confirmation and chapter lecture generation stay blocked until the learner confirms a distinct title in the GUI or with:

```sh
tutor --course "Digital Design" --data-dir .tutor \
  --confirm-chapter --chapter-id <id> --title "<courseware title>"
```

Run `tutor --course NAME --data-dir DIR --chapters` to inspect status, source material, version, stable chapter ID, and whether a chapter lecture is published.

## Protected routes and progress

Chapter progress is `pending`, `in_progress`, or `learned`, and changes only through the GUI status action or:

```sh
tutor --course "Digital Design" --data-dir .tutor \
  --chapter-id <id> --progress in_progress
```

Generating, exporting, opening, or downloading a lecture never changes progress. A route can be confirmed only after every ambiguous title is resolved. Its complete numbered chapter list must match the durable chapter titles exactly: no model-proposed rename, extra chapter, omission, or removal is accepted. In-progress and learned chapters keep their absolute route position, source material/version, and associated lecture. New material may add or reorder only pending chapters.

If route validation fails after new material was admitted, Tutor restores the previous `course.json` and `draft.json`; OCR caches remain reusable. Ambiguous-title admissions are retained deliberately so the user has a pending entry to resolve.

## Chapter lectures

After a route is confirmed, generate one chapter without re-importing:

```sh
tutor --course "Digital Design" --data-dir .tutor \
  --generate --chapter-id <id>
```

The output is published under `chapters/<chapter-id>/output/` with the same Markdown, Typst, PDF, media, and figure layout as a whole-course lecture. Its source selection is bound to the chapter's material version. The GUI exposes the same action from the course route page and serves chapter files through its local session-protected API.
