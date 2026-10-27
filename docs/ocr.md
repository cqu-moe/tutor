# OCR selection and saved results

Tutor defaults to MinerU VLM. Select Mistral independently of the Pi conversation
model:

```sh
node --env-file=.env.local bin/tutor.js \
  --course "Digital Design" --pdf lecture.pdf --pages 21-24 \
  --screenshots question.png --ocr mistral --data-dir .tutor
```

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

PDF pages are extracted with Poppler before upload. `context.json` retains the
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

Run `npm test` for actual-bin checks using fixed external HTTP responses. They
cover selection, source/range/endpoint changes, unavailable-service reuse,
partial-result recovery, preserved work, unsafe resources and bounded downloads.
Real OCR still needs comparison with the original pages; OCR success alone does
not establish teaching quality.
