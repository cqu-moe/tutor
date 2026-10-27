# Lecture revision

After a confirmed lecture has been exported, resume it with:

```sh
node bin/tutor.js --course "Digital Design" --data-dir ./courses --revise "重讲布尔函数这一节"
```

Revision reuses the saved parsed context, original page resources, confirmed route, and delivered Markdown/media. It stages a copy under `.revision-*`, lets Pi make targeted `edit` calls in that staging directory, checks that section headings, local media references, and source citations were not dropped, then re-exports through the same Recto path as generation. Optional generated drawing sources in `output/figures/` are carried through staging and re-export.

After a newly confirmed route is generated, the same CLI process accepts revision feedback. Type one request at a time, then `done`, or end input to finish. This shares the route terminal queue, so lines piped after `confirm` are not lost. The `--revise` command above remains the restart path.

Pi conversation state is stored in the course directory under `.sessions/` and resumed in later CLI processes with Pi's native session format. Revision does not call OCR for unchanged material and does not treat a generated or revised lecture as learner progress.

Feedback that adds or removes a section/topic, narrows or expands coverage, or changes order is rejected; confirm a new teaching route first. Model, tool, preservation-check, or export failure leaves the previous `output/` unchanged and reports the retained `.revision-*` draft. Use one revision process per course directory.
