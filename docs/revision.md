# Lecture revision

After a confirmed lecture has been exported, resume it with:

```sh
tutor --course "Digital Design" --data-dir .tutor --revise "重讲布尔函数这一节"
```

Revision reuses the parsed context and confirmed route in `output/lecture.json`, original page resources, and delivered Markdown/media. An unconfirmed or failed replacement draft does not change this source pairing. It stages a copy under `.revision-*`, lets Pi make targeted `edit` calls in that staging directory, checks that section headings, local media references, and source citations were not dropped, then re-exports through the same Recto path as generation. Optional generated drawing sources in `output/figures/` are carried through staging and re-export. File mutations use the same stage sandbox as [diagram generation](diagrams.md).

After a newly confirmed route is generated, the same CLI process accepts revision feedback. Type one request at a time, then `done`, or end input to finish. This shares the route terminal queue, so lines piped after `confirm` are not lost. The `--revise` command above remains the restart path.

Pi conversation state is stored in the course directory under `.sessions/` and resumed in later CLI processes with Pi's native session format. Revision does not call OCR for unchanged material and does not treat a generated or revised lecture as learner progress.

Feedback is passed to the model without keyword-based intent rejection, so “不要修改顺序，只补充推导” is a valid revision request. The resulting Markdown must preserve the heading sequence, existing media references and source citations; structural changes require a new confirmed route. These checks do not prove semantic coverage of every paragraph. Model, tool, preservation-check, or export failure leaves the previous `output/` unchanged and reports the retained `.revision-*` draft. Use one revision process per course directory.
