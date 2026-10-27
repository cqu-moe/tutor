# OCR selection and saved results

Tutor defaults to MinerU VLM. Select Mistral independently of the Pi conversation
model:

```sh
tutor --env-file .env.local \
  --course "Digital Design" --pdf lecture.pdf --pages 21-24 \
  --screenshots question.png --ocr mistral --data-dir .tutor
```

`--pages` accepts positive one-based single pages and closed ranges, and is
checked against the selected PDF's real `pdfinfo` page count before ranges are
expanded. Tutor imposes no fixed page-count ceiling; a provider or model may
still reject an oversized request according to its own limits.

Alternatively, pass `--chapter "Exact bookmark title"` instead of `--pages`.
Tutor reads the PDF's existing Poppler XML outline—there is no text-heading
heuristic, OCR index, or chapter framework. The title must match one bookmark
exactly after trimming and Unicode NFC normalization. A PDF without bookmarks,
a missing title, or duplicate titles is rejected with an explicit `--pages`
fallback. The selected span runs from the bookmark through the next sibling
bookmark's boundary page (or the final PDF page), including every physical page
in between. Original page numbers remain the provenance, and the start/end
heading or explicit final-page scope is passed to route proposal and lecture
generation. A boundary page is included only when the preceding chapter needs
it; content belonging to the next bookmark is excluded. When there is no next
sibling, the chapter explicitly runs through the final PDF page.

Use `--ocr mineru` with `MINERU_API_TOKEN` (the precision API's Bearer token), or
`--ocr mistral` with `MISTRAL_API_KEY`. Only the selected service is called. Model
selection remains `--model provider/model` as described in [models.md](models.md).
The CLI reads credentials from its process environment; it does not copy a
credential file into a course directory. Keep `.env.local` out of Git.

The adapters use the official HTTP APIs without extra dependencies:

- [MinerU local-file API](https://mineru.net/apiManage/docs): VLM, formula and
  table recognition, signed uploads, polling, and the returned ZIP.
- [Mistral OCR](https://docs.mistral.ai/studio/document-processing/basic_ocr):
  `mistral-ocr-latest`, base64 PDF/image input, inline tables and extracted images.
  The concrete returned model and page metadata are retained in `response.json`.

PDF pages are extracted with Poppler before upload. The context in `draft.json` retains the
selected original page number, saved page PDF, original page image, parsed
Markdown and its resource directory. Screenshots retain their display name and
saved source. Extracted images remain beside the Markdown that references them.
For an already-extracted PDF, page numbers refer to that file; a four-page sample
does not itself establish an offset into the original PDF.

## Reuse and recovery

Rerunning a course reuses completed OCR results for the same source bytes,
original page number, input type, OCR provider, model identifier and API endpoint.
PDF identity uses the original file's SHA-256, avoiding timestamps introduced by
`pdfseparate`. Changing any PDF byte invalidates its selected pages. Expanding a
range parses only newly selected pages; changing the conversation model does not
invalidate OCR. Cached results need no OCR credential or service availability.

Source copies and parsed output are content-addressed. A result is reusable only
after Markdown validation and the successful completion marker; missing saved
resources require a new parse. Successful pages remain saved if another page,
upload or later model step fails. New attempts use separate staging directories,
and replacement of an incomplete cache preserves the old directory. A failed
OCR run leaves the previous context, route and lecture files intact. Concurrent
processes writing the same course directory are not supported.

MinerU's downloaded ZIP is deleted only after the parsed cache is validated and
committed. Extraction or cache-validation failure retains the ZIP for diagnosis;
a cleanup failure does not invalidate an already committed cache.

The Mistral `latest` alias is intentionally part of the saved identity; existing
results do not automatically refresh when the provider changes that alias. To
force fresh OCR, move the course's selected `parsed/<provider>` directory aside
before rerunning. Keep it if an older deliverable still references its images.

## Failure boundaries

Requests have no automatic retries or cross-service fallback. API polling calls
have a 30-second deadline; uploads, downloads and Mistral calls have 120-second
deadlines including response bodies. MinerU polling stops after ten minutes.
Response limits are 1 MiB for MinerU JSON, 64 KiB for errors/upload receipts,
100 MiB for Mistral JSON, and 512 MiB for MinerU archives and extracted contents.
Archives are listed and checked for traversal, absolute paths, links and special
files before extraction into a fresh directory. Mistral image filenames cannot
escape their output directory.

Only the API requests receive Bearer credentials. MinerU signed PUT requests send
neither Authorization nor Content-Type. Redirects fail without following their
targets. `--mineru-base-url` and `--mistral-base-url` may select another compatible
service; HTTPS is required except for loopback HTTP. Diagnostics report the stage,
HTTP status when received, and a bounded API reason with credentials/URLs removed.

Successful authentication or task creation does not establish OCR success. In
particular, `403 SignatureDoesNotMatch` at MinerU's signed upload remains a failed
parse: preserve the files and correct the service problem or explicitly choose
Mistral. An expired API token must be refreshed outside Tutor.

Run `bun run test` for actual-bin checks using fixed external HTTP responses. They
cover selection, source/range/endpoint changes, unavailable-service reuse,
partial-result recovery, preserved work, unsafe resources and bounded downloads.
Real OCR still needs comparison with the original pages; OCR success alone does
not establish teaching quality.
