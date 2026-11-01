import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { cliCommand } from './cli-command.js';

function cli(args, env = process.env, input = '') {
  const child = spawn(cliCommand[0], [...cliCommand.slice(1), ...args], { env });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => stdout += c);
  child.stderr.on('data', c => stderr += c);
  child.stdin.end(input);
  const exited = new Promise(resolve => child.on('close', code => resolve({ code, stdout, stderr })));
  return { child, exited, output: () => stdout + stderr };
}
async function until(read, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await new Promise(r => setTimeout(r, 30));
  }
  throw new Error(typeof message === "function" ? message() : message);
}

test('GUI owns its data directory through mutations; SIGKILL permits CLI takeover and legacy work stays pending', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const legacy = path.join(data, 'logic', '.lecture-old');
  await mkdir(legacy, { recursive: true });
  await writeFile(path.join(data, 'logic', '.course-name'), 'Logic\n');
  await writeFile(path.join(legacy, 'content.md'), 'Unadmitted original');
  const gui = cli(['gui', '--no-open', '--port', '0', '--data-dir', data]);
  t.after(() => gui.child.kill('SIGKILL'));
  await until(() => gui.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], gui.output());
  const denied = await cli(['--course', 'Logic', '--data-dir', data, '--chapters']).exited;
  assert.equal(denied.code, 1, denied.stdout + denied.stderr);
  assert.match(denied.stderr, /data directory.*owned|single.writer/i);
  gui.child.kill('SIGKILL');
  await gui.exited;
  const after = await cli(['tasks', '--data-dir', data, '--json']).exited;
  assert.equal(after.code, 0, after.stderr);
  const state = JSON.parse(after.stdout);
  assert.ok(state.pending.some(item => item.path.endsWith('.lecture-old')), after.stdout);
  assert.equal(await readFile(path.join(legacy, 'content.md'), 'utf8'), 'Unadmitted original');
});

async function gui(t, data, extra = [], env = process.env) {
  const process = cli(['gui', '--no-open', '--port', '0', '--data-dir', data, ...extra], env);
  t.after(() => process.child.kill('SIGKILL'));
  const url = await until(() => process.output().match(/http:\/\/127\.0\.0\.1:\d+/)?.[0], 'GUI did not start');
  const html = await (await fetch(url)).text();
  const token = html.match(/name="tutor-session" content="([^"]+)"/)[1];
  const request = (route, data) => fetch(url + route, { method: data ? 'POST' : 'GET', headers: { 'x-tutor-session': token, ...data ? { 'content-type': 'application/json' } : {} }, body: data ? JSON.stringify(data) : undefined });
  return { ...process, request, upload: form => fetch(url + '/api/jobs', { method: 'POST', headers: { 'x-tutor-session': token }, body: form }) };
}
async function server(t, handler) {
  const { createServer } = await import('node:http');
  const fixture = createServer(handler);
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { fixture.closeAllConnections(); fixture.close(resolve); }));
  return `http://127.0.0.1:${fixture.address().port}`;
}
async function pdf(root) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  await writeFile(path.join(root, 'logic.typ'), '#set page(width: 5cm, height: 4cm)\n= Logic gates\nAND and OR.\n');
  await promisify(execFile)('typst', ['compile', path.join(root, 'logic.typ'), path.join(root, 'logic.pdf')]);
  return path.join(root, 'logic.pdf');
}
async function upload(gui, file) {
  const form = new FormData();
  form.set('course', 'Logic'); form.set('selectionMode', 'chapter'); form.set('selection', 'Logic gates');
  form.set('pdf', new Blob([await readFile(file)], { type: 'application/pdf' }), 'logic.pdf');
  const response = await gui.upload(form);
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}

test('GUI admission survives lost upload and executor; unknown OCR pauses under same CLI identity and explicit cancel never revives', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-admission-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  let calls = 0;
  const ocr = await server(t, async (req, res) => { for await (const _ of req) {} calls++; });
  const env = { ...process.env, MISTRAL_API_KEY: 'fixture-only', PI_MEMORY_DIR: path.join(root, 'memory') };
  const first = await gui(t, data, ['--ocr', 'mistral', '--mistral-base-url', ocr], env);
  const accepted = await upload(first, await pdf(root));
  assert.ok(accepted.id);
  await until(() => calls === 1, 'accepted OCR not reached');
  await rm(path.join(root, 'logic.pdf'));
  const before = await (await first.request('/api/state')).json();
  assert.equal(before.job.id, accepted.id);
  first.child.kill('SIGKILL'); await first.exited;
  const resumed = await cli(['--data-dir', data, '--task-id', accepted.id, '--resume'], env).exited;
  assert.equal(resumed.code, 1, resumed.stderr);
  assert.match(resumed.stderr, /Mistral OCR response is unknown/);
  assert.equal(calls, 1, 'unknown external outcome must not be blindly submitted again');
  const listed = JSON.parse((await cli(['tasks', '--data-dir', data, '--json'], env).exited).stdout);
  assert.equal(listed.tasks[0].id, accepted.id);
  assert.equal(listed.tasks[0].status, 'needs-attention');
  const cancelled = await cli(['--data-dir', data, '--task-id', accepted.id, '--cancel', '--json'], env).exited;
  assert.equal(cancelled.code, 0, cancelled.stderr);
  const second = await gui(t, data, [], env);
  const state = await until(async () => { const s = await (await second.request('/api/state')).json(); return s.job?.status === 'cancelled' && s; }, 'cancellation not terminal');
  assert.equal(state.job.id, accepted.id);
  assert.equal(calls, 1);
  const owned = path.join(data, '.teaching', 'inputs', (await readdir(path.join(data, '.teaching', 'inputs')))[0], 'material.pdf');
  assert.equal((await readFile(owned)).subarray(0, 5).toString(), '%PDF-');

});

async function payload(req) { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); }
function answer(res, content, calls) {
  const base = { id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'resume-model' };
  const frame = (delta, finish_reason) => 'data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n';
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end(frame(calls ? { tool_calls: calls.map((call, index) => ({ index, id: String(index), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content }, null) + frame({}, calls ? 'tool_calls' : 'stop') + 'data: [DONE]\n\n');
}
async function modelConfig(root, url) {
  const agent = path.join(root, 'pi'); await mkdir(agent);
  await writeFile(path.join(agent, 'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: url + '/v1', api: 'openai-completions', apiKey: 'fixture-only', compat: { supportsUsageInStreaming: false }, models: [{ id: 'resume-model', input: ['text', 'image'] }] } } }));
  return ['--agent-dir', agent, '--model', 'fixture/resume-model'];
}
async function job(g, id, status) {
  return until(async () => { const state = await (await g.request('/api/state')).json(); const task = state.tasks.find(x => x.id === id); if (task?.status === 'needs-attention' && status !== 'needs-attention') throw new Error(task.log); return task?.status === status && task; }, `task ${id} did not reach ${status}`);
}

test('known MinerU polling, browser reopen, persisted confirmation and original model/stage resume share one task without completed generation replay', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-resume-known-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  let batches = 0, polls = 0, uploads = 0, routes = 0, generations = 0;
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  await writeFile(path.join(root, 'full.md'), '# Logic gates\nAND has two inputs.');
  await promisify(execFile)('/usr/bin/zip', ['-q', '-j', path.join(root, 'result.zip'), path.join(root, 'full.md')]);
  const archive = await readFile(path.join(root, 'result.zip'));
  const ocr = await server(t, async (req, res) => {
    if (req.url === '/api/v4/file-urls/batch') { await payload(req); batches++; return res.end(JSON.stringify({ code: 0, data: { batch_id: 'known-id', file_urls: [ocr + '/upload'] } })); }
    if (req.url === '/upload') { for await (const _ of req) {} uploads++; return res.end(); }
    if (req.url === '/api/v4/extract-results/batch/known-id') { polls++; if (polls === 1) return; return res.end(JSON.stringify({ code: 0, data: { extract_result: [{ data_id: '0', state: 'done', full_zip_url: ocr + '/result' }] } })); }
    if (req.url === '/result') return res.end(archive);
    res.writeHead(404).end();
  });
  const stages = [];
  const model = await server(t, async (req, res) => {
    const p = await payload(req); const text = JSON.stringify(p.messages);
    if (!text.includes('Write the complete lecture')) { routes++; return answer(res, '## Teaching order\n1. Logic gates'); }
    generations++; stages.push(text.match(/Lecture stage: `([^`]+)`/)[1]);
    if (generations === 1) return;
    return answer(res, '# Logic gates\n\nAND outputs one only when both inputs are one. Source: PDF page 1.');
  });
  const settings = await modelConfig(root, model);
  const env = { ...process.env, MINERU_API_TOKEN: 'fixture-only', PI_MEMORY_DIR: path.join(root, 'memory') };
  const first = await gui(t, data, [...settings, '--mineru-base-url', ocr], env);
  const accepted = await upload(first, await pdf(root));
  await until(() => polls === 1, 'known batch not polled');
  first.child.kill('SIGKILL'); await first.exited;
  const second = await gui(t, data, [], env);
  const waiting = await job(second, accepted.id, 'awaiting-route');
  assert.equal(batches, 1); assert.equal(uploads, 1); assert.equal(routes, 1);
  assert.equal(generations, 0);
  // A page refresh/reconnect is only GET, never implicit confirmation/cancel.
  await second.request('/');
  assert.equal((await job(second, accepted.id, 'awaiting-route')).route, waiting.route);
  second.child.kill('SIGKILL'); await second.exited;
  const saved = await cli(['--data-dir', data, '--task-id', accepted.id, '--resume'], env).exited;
  assert.equal(saved.code, 0, saved.stderr); assert.match(saved.stdout, /Route was not confirmed/);
  assert.equal(generations, 0); assert.equal(routes, 1);
  const third = await gui(t, data, [], env);
  const stale = await third.request('/api/jobs/input', { id: accepted.id, confirm: true, route: 'old route' });
  assert.equal(stale.status, 409);
  const confirmed = await third.request('/api/jobs/input', { id: accepted.id, confirm: true, route: waiting.route });
  assert.equal(confirmed.status, 200);
  await until(() => generations === 1, 'confirmation never reached generation');
  third.child.kill('SIGKILL'); await third.exited;
  const resumed = await cli(['--data-dir', data, '--task-id', accepted.id, '--resume', '--agent-dir', path.join(root, 'wrong-agent'), '--model', 'wrong/model'], env).exited;
  assert.equal(resumed.code, 0, resumed.stderr);
  assert.equal(generations, 2); assert.equal(stages[0], stages[1], 'the same original stage is reopened');
  assert.equal(routes, 1); assert.equal(batches, 1); assert.equal(uploads, 1);
  const content = await readFile(path.join(data, 'logic', 'output', 'content.md'), 'utf8');
  assert.match(content, /both inputs/);
  const manifest = JSON.parse(await readFile(path.join(data, 'logic', 'output', 'lecture.json'), 'utf8'));
  assert.ok(manifest.context.confirmedAt);
  const again = await cli(['--data-dir', data, '--task-id', accepted.id, '--resume'], env).exited;
  assert.equal(again.code, 0, again.stderr); assert.equal(generations, 2);
});

async function confirmedFixture(root) {
  const data = path.join(root, 'data'), course = path.join(data, 'logic');
  await mkdir(path.join(course, 'parsed'), { recursive: true });
  const source = await pdf(root);
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const image = path.join(root, 'page.png');
  await promisify(execFile)('pdftoppm', ['-png','-singlefile','-r','36',source,path.join(root,'page')]);
  await writeFile(path.join(course, 'parsed', 'full.md'), '# Logic gates\nAND needs two true inputs.');
  await writeFile(path.join(course, '.course-name'), 'Logic\n');
  const lecture = { context: { course: 'Logic', confirmedAt: '2026-01-01T00:00:00.000Z', pages: [{ sourcePage: 1, pagePdf: source, originalPageImage: image, parsedDirectory: path.join(course,'parsed'), markdown: '# Logic gates\nAND needs two true inputs.' }], screenshots: [] }, route: '## Teaching order\n1. Logic gates' };
  await writeFile(path.join(course,'draft.json'), JSON.stringify(lecture));
  return { data, course, lecture };
}
test('SIGKILL with a real Python descendant writing the stage stops descendants before takeover, and unknown bash effect pauses without replay', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-child-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { data } = await confirmedFixture(root);
  let stage, calls = 0, descendant, lastTool;
  const model = await server(t, async (req, res) => {
    const p = await payload(req); calls++;
    if (calls > 1) { lastTool = p.messages.at(-1); return answer(res, "# Child did not start"); }
    stage = JSON.stringify(p.messages).match(/Lecture stage: `([^`]+)`/)[1];
    const script = `import os,time\nfrom pathlib import Path\np=Path(${JSON.stringify(path.join(stage,'live.txt'))})\np.with_suffix('.pid').write_text(str(os.getpid()))\ni=0\nwhile True:\n i+=1\n p.write_text(str(i))\n time.sleep(0.01)\n`;
    const parent = `import subprocess,sys,fcntl\ntry: fcntl.flock(3,fcntl.LOCK_UN)\nexcept OSError: pass\nsubprocess.run([sys.executable,'-c',${JSON.stringify(script)}])`;
    const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
    answer(res, '', [{ name: 'bash', args: { command: `cd ${quote(stage)} && "$TUTOR_DIAGRAM_PYTHON" -c ${quote(parent)}` } }]);
  });
  const settings = await modelConfig(root, model);
  const env = { ...process.env, PI_MEMORY_DIR: path.join(root,'memory') };
  const owner = cli(['--data-dir', data, '--course','Logic','--generate',...settings], env);
  t.after(() => { owner.child.kill('SIGKILL'); if (descendant) try { process.kill(descendant,'SIGKILL'); } catch {} });
  await until(async () => stage && await readFile(path.join(stage, 'live.txt'),'utf8').catch(() => false), () => owner.output() + '\n' + JSON.stringify({calls, stage, lastTool}));
  descendant = Number(await readFile(path.join(stage,'live.pid'),'utf8'));
  const protectedOwner = await cli(['--data-dir',data,'--course','Logic','--chapters'],env).exited;
  assert.equal(protectedOwner.code,1,'a model tool must not be able to unlock the owner descriptor');
  assert.match(protectedOwner.stderr,/already owned/);
  owner.child.kill('SIGKILL'); await owner.exited;
  const takeover = await until(async () => { const r = await cli(['--data-dir',data,'--course','Logic','--chapters'],env).exited; if (r.code === 0) return r; assert.match(r.stderr,/already owned/); return false; }, 'descendant never released ownership');
  assert.equal(takeover.code, 0);
  const stopped = await readFile(path.join(stage,'live.txt'),'utf8');
  await new Promise(r => setTimeout(r, 250));
  assert.equal(await readFile(path.join(stage,'live.txt'),'utf8'), stopped, 'no orphan continues writing after a new owner acquires the directory');
  const id = owner.output().match(/Teaching task admitted: (\d+)/)?.[1];
  assert.ok(id, owner.output());
  const resumed = await cli(['--data-dir',data,'--task-id',id,'--resume'],env).exited;
  assert.equal(resumed.code, 1, resumed.stderr);
  assert.match(resumed.stderr, /bash.*interrupted|interrupted.*bash/i);
  assert.equal(calls, 1, 'unknown bash is not retried and the model is not asked to redo it');
  assert.equal(await readFile(path.join(stage,'live.txt'),'utf8'), stopped);
});

test('stage tools keep configured credentials and secret environment out of model context and official SQLite/WAL while document tools still work', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-stage-credentials-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { data, course } = await confirmedFixture(root);
  const envSecret = 'synthetic-stage-ocr-secret-82641';
  const configSecret = 'synthetic-stage-model-secret-19735';
  const agent = path.join(course, 'configured-agent'); await mkdir(agent);
  let calls = 0, downstream = '';
  const model = await server(t, async (req, res) => {
    const p = await payload(req); calls++;
    if (calls > 1) { downstream = JSON.stringify(p.messages); return answer(res, '# Logic gates\n\nA complete lecture.'); }
    const stage = JSON.stringify(p.messages).match(/Lecture stage: `([^`]+)`/)[1];
    const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
    answer(res, '', [{ name: 'bash', args: { command: `printf 'ENV:%s' "$MISTRAL_API_KEY"; cat ${quote(path.join(agent,'models.json'))}; printf 'document-tool-control' > ${quote(path.join(stage,'control.txt'))}; cat ${quote(path.join(stage,'control.txt'))}` } }, { name: 'read', args: { path: path.join(agent,'models.json') } }]);
  });
  await writeFile(path.join(agent,'models.json'), JSON.stringify({ providers: { fixture: { baseUrl: model + '/v1', api: 'openai-completions', apiKey: configSecret, compat: { supportsUsageInStreaming: false }, models: [{ id: 'resume-model', input: ['text','image'] }] } } }));
  const result = await cli(['--data-dir',data,'--course','Logic','--generate','--agent-dir',agent,'--model','fixture/resume-model'], { ...process.env, PI_MEMORY_DIR: path.join(root,'memory'), MISTRAL_API_KEY: envSecret }).exited;
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls, 2);
  assert.match(downstream, /document-tool-control/, 'ordinary stage read/write/bash behavior remains available');
  assert.ok(!downstream.includes(envSecret), 'OCR credentials must not reach the next model request');
  assert.ok(!downstream.includes(configSecret), 'configured agent credentials must not reach the next model request, including read aliases');
  const files = await readdir(data, { recursive: true });
  for (const file of files.filter(file => /\.sqlite(?:-wal|-shm)?$/.test(file))) {
    const bytes = await readFile(path.join(data,file));
    assert.ok(!bytes.includes(Buffer.from(envSecret)) && !bytes.includes(Buffer.from(configSecret)), `credential persisted in ${file}`);
  }
});

test('real publication SIGKILL at candidate preparation and both rename windows reconciles one matching set without completed model replay', { timeout: 60000 }, async t => {
  const { watch, existsSync } = await import('node:fs');
  const root = await mkdtemp(path.join(tmpdir(),'tutor-publication-'));
  t.after(() => rm(root,{ recursive:true,force:true }));
  const { data, course } = await confirmedFixture(root);
  let calls = 0;
  const model = await server(t,async (req,res) => { await payload(req); calls++; answer(res, `# Logic version ${calls}\n\nAND explanation version ${calls}.`); });
  const settings = await modelConfig(root,model);
  const env = { ...process.env, PI_MEMORY_DIR:path.join(root,'memory') };
  const common = ['--data-dir',data,'--course','Logic','--generate',...settings];
  const initial = await cli(common,env).exited;
  assert.equal(initial.code,0,initial.stderr);
  for (const window of ['prepared','old-moved','candidate-published']) {
    let intercepted = false;
    // Notifications race the owner. Retry a fresh explicit generation only if
    // this attempt finished before the target could actually be stopped.
    for (let attempt = 0; attempt < 5 && !intercepted; attempt++) {
      const owner = cli(common,env);
      t.after(() => owner.child.kill('SIGKILL'));
      const id = await until(() => owner.output().match(/Teaching task admitted: (\d+)/)?.[1], () => owner.output());
      const stage = path.join(course,`.export-${id}`), candidate = path.join(stage,'output'), previous = path.join(stage,'previous-output'), output = path.join(course,'output');
      await until(() => existsSync(stage), () => owner.output());
      const matches = () => {
        const prepared = existsSync(path.join(candidate,'lecture.json'));
        const old = existsSync(previous), current = existsSync(output);
        return window === 'prepared' ? prepared && !old && current : window === 'old-moved' ? old && !current && prepared : old && current && !existsSync(candidate);
      };
      let stopped = false, exited = false;
      owner.exited.then(() => { exited = true; });
      const stop = () => { if (!stopped && matches()) { stopped = true; owner.child.kill('SIGSTOP'); } };
      const watcher = watch(stage,stop), timer = setInterval(stop,1);
      try {
        await until(() => stopped || exited, () => `no publication transition at ${window}\n${owner.output()}`);
        if (!stopped) continue;
        await new Promise(resolve => setTimeout(resolve,5));
        if (!matches()) { owner.child.kill('SIGCONT'); await owner.exited; continue; }
        intercepted = true;
        owner.child.kill('SIGKILL'); await owner.exited;
      } finally { watcher.close(); clearInterval(timer); }
      const expectedCalls = calls;
      const resumed = await cli(['--data-dir',data,'--task-id',id,'--resume'],env).exited;
      assert.equal(resumed.code,0,`${window}: ${resumed.stderr}`);
      assert.equal(calls,expectedCalls,`${window}: completed generation cannot be replayed`);
      assert.match(await readFile(path.join(output,'content.md'),'utf8'), new RegExp(`version ${expectedCalls}`));
      assert.ok((await readFile(path.join(output,'document.pdf'))).subarray(0,5).equals(Buffer.from('%PDF-')));
      const metadata = JSON.parse(await readFile(path.join(output,'lecture.json'),'utf8'));
      assert.equal(metadata.route,'## Teaching order\n1. Logic gates');
      const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
      const text = await promisify(execFile)('pdftotext',[path.join(output,'document.pdf'),'-']);
      assert.match(text.stdout,new RegExp(`version ${expectedCalls}`));
    }
    assert.ok(intercepted, `failed to intercept actual ${window} window in five explicit tasks`);
  }
});

test('a completed official model answer killed before teaching checkpoint is reused; export retry never asks the model again', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'tutor-model-receipt-'));
  t.after(() => rm(root,{ recursive:true,force:true }));
  const { data } = await confirmedFixture(root);
  let calls = 0, release, stage;
  const model = await server(t,async (req,res) => {
    const p = await payload(req); calls++; stage = JSON.stringify(p.messages).match(/Lecture stage: `([^`]+)`/)[1];
    release = () => answer(res,'# Stored complete answer\n\nThis source must be reused after the owner dies.');
  });
  const settings = await modelConfig(root,model), env = { ...process.env, PI_MEMORY_DIR:path.join(root,'memory') };
  const owner = cli(['--data-dir',data,'--course','Logic','--generate',...settings],env);
  t.after(() => owner.child.kill('SIGKILL'));
  await until(() => release, () => owner.output());
  const locker = spawn('/usr/bin/sqlite3',[path.join(data,'.teaching','tasks.sqlite')]);
  t.after(() => locker.kill('SIGKILL'));
  locker.stdin.write('.timeout 5000\nBEGIN IMMEDIATE;\n.print held\n');
  await new Promise(resolve => locker.stdout.once('data',resolve));
  release();
  await until(() => Bun.file(path.join(stage,'content.md')).exists(), () => owner.output());
  owner.child.kill('SIGKILL'); await owner.exited;
  locker.stdin.end('ROLLBACK;\n.quit\n'); await new Promise(resolve => locker.once('exit',resolve));
  const id = owner.output().match(/Teaching task admitted: (\d+)/)[1];
  // The export dependency is deliberately unavailable only in this executor.
  // This is real config failure, not a fake exporter or filesystem.
  const failed = await cli(['--data-dir',data,'--task-id',id,'--resume'], { ...env, TUTOR_RECTO_ROOT:path.join(root,'missing-recto') }).exited;
  assert.equal(failed.code,1,failed.stderr); assert.equal(calls,1);
  const resumed = await cli(['--data-dir',data,'--task-id',id,'--retry'],env).exited;
  assert.equal(resumed.code,0,resumed.stderr); assert.equal(calls,1);
  assert.match(await readFile(path.join(data,'logic','output','content.md'),'utf8'),/Stored complete answer/);
});

for (const [selected, window] of [[true, 'bound'], [false, 'published'], [false, 'bound']]) test(`${selected ? 'chapter' : 'ordinary'} publication killed at ${window} boundary resumes once with the original chapter target`, { timeout: 45000 }, async t => {
  const { rename } = await import('node:fs/promises');
  const { existsSync } = await import('node:fs');
  const root = await mkdtemp(path.join(tmpdir(),'tutor-publish-completion-'));
  t.after(() => rm(root,{ recursive:true,force:true }));
  const { data, course } = await confirmedFixture(root);
  let calls = 0;
  const model = await server(t,async (req,res) => { await payload(req); calls++; answer(res,'# Original chapter target\n\nA complete chapter publication.'); });
  const settings = await modelConfig(root,model), env = { ...process.env, PI_MEMORY_DIR:path.join(root,'memory') };
  const g = await gui(t,data,settings,env);
  const initial = await (await g.request('/api/state')).json();
  const chapterId = initial.courses[0].chapters[0].id;
  const admitted = await g.request('/api/jobs',{ action:'generate',courseId:'logic', ...(selected ? { chapterId } : {}) });
  assert.equal(admitted.status,202);
  const accepted = await admitted.json();
  const stage = path.join(course,`.export-${accepted.id}`), file = path.join(course,'course.json'), backup = path.join(course,'.original-course.json');
  await until(() => existsSync(stage),'export did not start');
  // Export has already read the course. Its final chapter binding must later
  // read it again. Pause exactly that read using a real FIFO, as in #17.
  const original = await readFile(file,'utf8');
  await rename(file,backup);
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  await promisify(execFile)('mkfifo',[file]);
  const writer = spawn('python3',['-c',"import sys\nf=open(sys.argv[1],'w')\nprint('opened',flush=True)\nf.write(sys.stdin.read())\nf.close()",file]);
  t.after(() => writer.kill('SIGKILL'));
  await new Promise(resolve => writer.stdout.once('data',resolve));
  assert.ok(existsSync(path.join(course,'chapters',chapterId,'output','document.pdf')));
  let committed;
  if (window === 'published') {
    assert.equal(JSON.parse(original).chapters.find(c => c.id === chapterId).lecture.status, 'none');
    // The real export is published, but course.json is still blocked at its
    // binding read. Kill before that effect and recover from the saved manifest.
    g.child.kill('SIGKILL'); await g.exited;
    writer.kill('SIGKILL'); await new Promise(resolve => writer.once('exit', resolve));
    await rm(file); await rename(backup, file);
  } else {
    const locker = spawn('/usr/bin/sqlite3', [path.join(data, '.teaching', 'tasks.sqlite')]);
    t.after(() => locker.kill('SIGKILL'));
    locker.stdin.write('.timeout 5000\nBEGIN IMMEDIATE;\n.print terminal-blocked\n');
    await new Promise(resolve => locker.stdout.once('data', resolve));
    await rm(file); await rename(backup, file);
    writer.stdin.end(original); await new Promise(resolve => writer.once('exit', resolve));
    await until(async () => { const detail = await (await g.request('/api/courses/logic')).json(); return detail.chapters.find(c => c.id === chapterId).lecture.status === 'published'; }, 'chapter effect not visible through HTTP');
    committed = JSON.parse(await readFile(file, 'utf8')).chapters.find(c => c.id === chapterId);
    g.child.kill('SIGKILL'); await g.exited;
    locker.stdin.end('ROLLBACK;\n.quit\n'); await new Promise(resolve => locker.once('exit', resolve));
  }
  const resumed = await cli(['--data-dir',data,'--task-id',accepted.id,'--resume'],env).exited;
  assert.equal(resumed.code,0,resumed.stderr); assert.equal(calls,1);
  const after = JSON.parse(await readFile(file,'utf8')).chapters.find(c => c.id === chapterId);
  if (committed) assert.deepEqual(after, committed, 'the already committed chapter binding/version is not repeated');
  else assert.equal(after.version, JSON.parse(original).chapters.find(c => c.id === chapterId).version + 1);
  const again = await cli(['--data-dir', data, '--task-id', accepted.id, '--resume'], env).exited;
  assert.equal(again.code, 0, again.stderr);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).chapters.find(c => c.id === chapterId), after);
  assert.equal(after.lecture.operationId,accepted.id);
  const reopened = await gui(t,data,[],env);
  const detail = await (await reopened.request('/api/courses/logic')).json();
  assert.match(detail.chapters.find(c => c.id === chapterId).lecture.content,/Original chapter target/);
  if (selected) assert.equal(detail.content, '', 'chapter publication does not publish the whole course');
  else assert.match(detail.content, /Original chapter target/);
});

test('retryable model failures stop at the official bounded policy and leave an actionable paused task', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'tutor-model-limit-'));
  t.after(() => rm(root,{ recursive:true,force:true }));
  const { data } = await confirmedFixture(root);
  let calls = 0;
  const model = await server(t,async (req,res) => { await payload(req); calls++; res.writeHead(500).end(JSON.stringify({ error:{message:'temporary upstream failure'} })); });
  const settings = await modelConfig(root,model), env = { ...process.env, PI_MEMORY_DIR:path.join(root,'memory') };
  const result = await cli(['--data-dir',data,'--course','Logic','--generate',...settings],env).exited;
  assert.equal(result.code,1,result.stderr);
  assert.equal(calls,4,'pinned Pi retries three times after the first request');
  assert.match(result.stderr,/needs attention/);
  const state = JSON.parse((await cli(['tasks','--data-dir',data,'--json'],env).exited).stdout);
  assert.equal(state.tasks[0].status,'needs-attention');
  assert.ok(state.tasks[0].continuation);
  await new Promise(resolve => setTimeout(resolve,300));
  assert.equal(calls,4,'no infinite background retry continues after the diagnosed exit');
});

test('received MinerU archive survives death before cache publication and is reused even when the provider can no longer be queried', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'tutor-ocr-receipt-'));
  t.after(() => rm(root,{ recursive:true,force:true }));
  const data = path.join(root,'data');
  await writeFile(path.join(root,'full.md'),'# Logic gates\nAND has two inputs.');
  const { randomBytes } = await import('node:crypto');
  await writeFile(path.join(root,'resource.bin'),randomBytes(32 * 1024 * 1024));
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  await promisify(execFile)('/usr/bin/zip',['-q','-0','-j',path.join(root,'result.zip'),path.join(root,'full.md'),path.join(root,'resource.bin')]);
  const archive = await readFile(path.join(root,'result.zip'));
  let batches = 0, polls = 0, downloads = 0, unavailable = false;
  const ocr = await server(t,async (req,res) => {
    if (unavailable) return res.writeHead(503).end();
    if (req.url === '/api/v4/file-urls/batch') { await payload(req); batches++; return res.end(JSON.stringify({code:0,data:{batch_id:'receipt',file_urls:[ocr+'/upload']}})); }
    if (req.url === '/upload') { for await (const _ of req) {} return res.end(); }
    if (req.url === '/api/v4/extract-results/batch/receipt') { polls++; return res.end(JSON.stringify({code:0,data:{extract_result:[{data_id:'0',state:'done',full_zip_url:ocr+'/result'}]}})); }
    if (req.url === '/result') { downloads++; return res.end(archive); }
    res.writeHead(404).end();
  });
  const model = await server(t,async (req,res) => { await payload(req); answer(res,'## Teaching order\n1. Logic gates'); });
  const settings = await modelConfig(root,model), env = { ...process.env, PI_MEMORY_DIR:path.join(root,'memory'), MINERU_API_TOKEN:'fixture-only' };
  const source = await pdf(root);
  const owner = cli(['--data-dir',data,'--course','Logic','--pdf',source,'--chapter','Logic gates','--mineru-base-url',ocr,...settings],env);
  t.after(() => owner.child.kill('SIGKILL'));
  const parsed = path.join(data,'logic','parsed');
  const receipt = await until(async () => (await readdir(parsed,{recursive:true}).catch(() => [])).find(file => file.endsWith('.received.zip')), () => owner.output());
  owner.child.kill('SIGSTOP'); await new Promise(resolve => setTimeout(resolve,5));
  assert.ok(await Bun.file(path.join(parsed,receipt)).exists(),'actual received archive still exists before cache commit');
  owner.child.kill('SIGKILL'); await owner.exited; unavailable = true;
  const id = owner.output().match(/Teaching task admitted: (\d+)/)[1];
  const resumed = await until(async () => { const result = await cli(['--data-dir',data,'--task-id',id,'--resume'],env).exited; if (/already owned/.test(result.stderr)) return false; return result; },'OCR child did not release ownership');
  assert.equal(resumed.code,0,resumed.stderr);
  assert.match(resumed.stdout,/Logic gates/);
  assert.equal(batches,1); assert.equal(polls,1); assert.equal(downloads,1);
});

test('GUI terminal model submissions keep unsafe classification through generation and revision error context', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'tutor-terminal-model-'));
  t.after(() => rm(root,{ recursive:true,force:true }));
  const { data } = await confirmedFixture(root);
  let mode = 'fail', calls = 0;
  const model = await server(t,async (req,res) => {
    await payload(req); calls++;
    if (mode === 'fail') return res.writeHead(401).end(JSON.stringify({ error:{message:'fixture authentication failure'} }));
    answer(res,'# Original lecture\n\nA complete unchanged lecture.');
  });
  const settings = await modelConfig(root,model), env = { ...process.env, PI_MEMORY_DIR:path.join(root,'memory') };
  const g = await gui(t,data,settings,env);
  async function failed(action) {
    mode = 'fail';
    const accepted = await g.request('/api/jobs',{ action,courseId:'logic',...action === 'revise' ? {feedback:'Clarify the existing explanation'} : {} });
    assert.equal(accepted.status,202);
    const receipt = await accepted.json();
    const paused = await job(g,receipt.id,'needs-attention');
    assert.equal(paused.canRetry,false,`${action}: an ended original model submission cannot advertise effective retry`);
    assert.match(paused.log,/original model submission ended/);
    mode = 'ok';
    const before = calls;
    assert.equal((await g.request('/api/jobs/input',{id:receipt.id,retry:true})).status,409);
    assert.equal(calls,before,'changing provider availability cannot replay the ended original submission');
    assert.equal((await g.request('/api/jobs/input',{id:receipt.id,cancel:true})).status,200);
    assert.equal((await job(g,receipt.id,'cancelled')).status,'cancelled');
  }
  await failed('generate');
  const success = await g.request('/api/jobs',{action:'generate',courseId:'logic'});
  assert.equal(success.status,202); await job(g,(await success.json()).id,'succeeded');
  const original = await readFile(path.join(data,'logic','output','content.md'),'utf8');
  await failed('revise');
  assert.equal(await readFile(path.join(data,'logic','output','content.md'),'utf8'),original);
  const beforeDoctor = calls;
  const diagnostic = await g.request('/api/jobs',{action:'doctor'});
  assert.equal(diagnostic.status,202);
  const doctor = await diagnostic.json();
  const finished = await until(async () => { const state = await (await g.request('/api/state')).json(); return state.job?.id === doctor.id && ['failed','succeeded'].includes(state.job.status) && state.job; }, 'saved teaching tasks hid the completed doctor result');
  assert.equal(finished.action,'doctor'); assert.equal(calls,beforeDoctor,'local diagnostics do not invoke the model');
});

test('same PDF with a changed screenshot binds the newly admitted material instead of an earlier matching PDF', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(),'tutor-material-resume-'));
  t.after(() => rm(root,{recursive:true,force:true}));
  const data = path.join(root,'data'), source = await pdf(root);
  const {execFile} = await import('node:child_process'); const {promisify} = await import('node:util');
  const images = [];
  for (const resolution of [36,72]) {
    const stem = path.join(root,`question-${resolution}`);
    await promisify(execFile)('pdftoppm',['-png','-r',String(resolution),'-singlefile',source,stem]);
    images.push(await readFile(stem+'.png'));
  }
  const ocr = await server(t,async (req,res) => { await payload(req); res.end(JSON.stringify({pages:[{index:0,markdown:'# Logic gates\nAND has two inputs.'}]})); });
  const requests = [];
  const model = await server(t,async (req,res) => {
    const p = await payload(req); requests.push(p);
    const content = p.messages.findLast(message => message.role === 'user').content;
    const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const titles = [...text.matchAll(/^\d+\.\s+(.+)$/gm)].map(match => match[1]);
    answer(res,'## Teaching order\n'+titles.map((title,index) => `${index+1}. ${title}`).join('\n'));
  });
  const settings = await modelConfig(root,model), env = {...process.env,PI_MEMORY_DIR:path.join(root,'memory'),MISTRAL_API_KEY:'fixture-only'};
  const g = await gui(t,data,[...settings,'--ocr','mistral','--mistral-base-url',ocr],env);
  for (const [index, image] of images.entries()) {
    const form = new FormData();
    form.set('course','Logic'); form.set('selectionMode','chapter'); form.set('selection','Logic gates');
    form.set('pdf',new Blob([await readFile(source)],{type:'application/pdf'}),'logic.pdf');
    form.append('screenshots',new Blob([image],{type:'image/png'}),'question.png');
    const response = await g.upload(form); assert.equal(response.status,202);
    const task = await response.json(); await job(g,task.id,'awaiting-route');
    const draft = JSON.parse(await readFile(path.join(data,'logic','draft.json'),'utf8'));
    assert.ok((await readFile(draft.context.screenshots[0].source)).equals(image),`admission ${index+1} must use its own screenshot version`);
    assert.equal((await g.request('/api/jobs/input',{id:task.id,cancel:true})).status,200);
  }
  assert.equal((await (await g.request('/api/state')).json()).courses[0].materials,2);
  const last = JSON.stringify(requests.at(-1).messages);
  assert.ok(last.includes(images[1].toString('base64')) && !last.includes(images[0].toString('base64')),'the route model receives the newly admitted screenshot, not the previous PDF match');
  // Stored signatures from before content-only identity remain valid inputs.
  const file = path.join(data, 'logic', 'course.json');
  const legacy = JSON.parse(await readFile(file, 'utf8'));
  const { createHash } = await import('node:crypto');
  for (const material of legacy.materials) material.signature = createHash('sha256').update(JSON.stringify({
    sourceHash: material.sourceHash, sourcePages: material.sourcePages,
    screenshots: material.screenshots.map(image => `${image.name}:${image.source}`),
  })).digest('hex');
  await writeFile(file, JSON.stringify(legacy));
  const form = new FormData();
  form.set('course', 'Logic'); form.set('selectionMode', 'chapter'); form.set('selection', 'Logic gates');
  form.set('pdf', new Blob([await readFile(source)], { type: 'application/pdf' }), 'logic.pdf');
  form.append('screenshots', new Blob([images[1]], { type: 'image/png' }), 'renamed.png');
  const renamed = await g.upload(form); assert.equal(renamed.status, 202);
  const duplicate = await renamed.json();
  const repeated = await until(async () => {
    const state = await (await g.request('/api/state')).json();
    return state.tasks.find(task => task.id === duplicate.id && task.status !== 'running');
  }, 'renamed duplicate did not settle');
  assert.equal(repeated.status, 'succeeded', 'identical renamed screenshot must deduplicate without a new route');
  let state = await (await g.request('/api/state')).json();
  assert.equal(state.courses[0].materials, 2, 'GUI rename alone must not add material');
  assert.equal(state.courses[0].chapters.length, 2, 'GUI rename alone must not add a chapter');
  assert.equal(requests.length, 2, 'renamed duplicate must not ask for a new route');
  g.child.kill('SIGKILL'); await g.exited;
  const renamedFile = path.join(root, 'renamed-again.png');
  await writeFile(renamedFile, images[1]);
  const repeat = await cli(['--data-dir', data, '--course', 'Logic', '--pdf', source, '--chapter', 'Logic gates', '--screenshots', renamedFile,
    '--ocr', 'mistral', '--mistral-base-url', ocr, ...settings], env).exited;
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.match(repeat.stdout, /No new material/);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(stored.materials.length, 2);
  assert.equal(stored.chapters.length, 2);
  assert.equal(stored.materials[1].screenshots[0].name, 'question.png', 'original filename remains provenance');
  assert.equal(requests.length, 2);
});

test('ordinary CLI imports keep covered chapter lectures and GUI downloads unchanged after protected progress and append', { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'tutor-ordinary-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'), course = path.join(data, 'logic');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const compile = async (name, text) => {
    const file = path.join(root, name);
    await writeFile(file + '.typ', '#set page(width: 10cm, height: 3cm)\n' + text);
    await promisify(execFile)('typst', ['compile', file + '.typ', file + '.pdf']);
    return file + '.pdf';
  };
  const first = await compile('first', '= Gates\nAND and OR.\n#pagebreak()\n= Latches\nStored state.');
  const next = await compile('next', '= Registers\nClocked state.');
  const ocr = await server(t, async (req, res) => { await payload(req); res.end(JSON.stringify({ pages: [{ index: 0, markdown: 'Digital logic teaching material.' }] })); });
  let generations = 0;
  const model = await server(t, async (req, res) => {
    const p = await payload(req), messages = JSON.stringify(p.messages);
    if (messages.includes('Write the complete lecture')) {
      generations++;
      return answer(res, generations === 1 ? '# Gates and Latches\n\nAND requires both inputs. A latch stores a state.' : '# Registers\n\nA register stores a clocked state.');
    }
    const content = p.messages.findLast(m => m.role === 'user').content;
    const text = typeof content === 'string' ? content : content.filter(part => part.type === 'text').map(part => part.text).join('\n');
    const titles = [...text.matchAll(/^\d+\.\s+(.+)$/gm)].map(match => match[1]);
    answer(res, '## Teaching order\n' + titles.map((title, index) => `${index + 1}. ${title}`).join('\n'));
  });
  const settings = await modelConfig(root, model);
  const env = { ...process.env, PI_MEMORY_DIR: path.join(root, 'memory'), MISTRAL_API_KEY: 'fixture-only' };
  const common = ['--data-dir', data, '--course', 'Logic', '--ocr', 'mistral', '--mistral-base-url', ocr, ...settings];
  const imported = await cli([...common, '--pdf', first, '--pages', '1-2'], env, 'confirm\ndone\n').exited;
  assert.equal(imported.code, 0, imported.stdout + imported.stderr);
  const initial = JSON.parse(await readFile(path.join(course, 'course.json'), 'utf8'));
  assert.equal(initial.chapters.length, 2);
  for (const chapter of initial.chapters) assert.equal(chapter.lecture.status, 'published', `ordinary import must bind ${chapter.title}`);
  // This is a combined lecture, not an invented per-chapter explanation.
  for (const chapter of initial.chapters) {
    const manifest = JSON.parse(await readFile(path.join(chapter.lecture.output, 'lecture.json'), 'utf8'));
    assert.equal(manifest.context.selection, undefined);
    assert.equal(manifest.context.pages.length, 2);
  }
  for (const [index, status] of ['learned', 'in_progress'].entries()) {
    const marked = await cli([...common, '--chapter-id', initial.chapters[index].id, '--progress', status], env).exited;
    assert.equal(marked.code, 0, marked.stderr);
  }
  const protectedChapters = JSON.parse(await readFile(path.join(course, 'course.json'), 'utf8')).chapters;
  const tree = async directory => {
    const files = await readdir(directory, { recursive: true, withFileTypes: true });
    return Object.fromEntries(await Promise.all(files.filter(f => f.isFile()).map(async f => {
      const file = path.join(f.parentPath, f.name);
      return [path.relative(directory, file), (await readFile(file)).toString('base64')];
    })));
  };
  const snapshots = await Promise.all(protectedChapters.map(chapter => tree(chapter.lecture.output)));
  const appended = await cli([...common, '--pdf', next, '--pages', '1'], env, 'confirm\ndone\n').exited;
  assert.equal(appended.code, 0, appended.stdout + appended.stderr);
  const after = JSON.parse(await readFile(path.join(course, 'course.json'), 'utf8'));
  assert.deepEqual(after.chapters.slice(0, 2), protectedChapters, 'append must not alter learned or in-progress chapter records');
  for (const [index, chapter] of protectedChapters.entries()) assert.deepEqual(await tree(chapter.lecture.output), snapshots[index]);
  assert.equal(after.chapters[2].lecture.status, 'published');
  assert.equal(generations, 2);
  const g = await gui(t, data, [], env);
  const detail = await (await g.request('/api/courses/logic')).json();
  assert.match(detail.content, /Registers/);
  for (const chapter of protectedChapters) {
    const listed = detail.chapters.find(c => c.id === chapter.id);
    assert.match(listed.lecture.content, /Gates and Latches/);
    const download = await g.request(`/api/courses/logic/chapters/${chapter.id}/files/document.pdf`);
    assert.equal(download.status, 200);
    assert.equal(Buffer.from(await download.arrayBuffer()).toString('base64'), snapshots[protectedChapters.indexOf(chapter)]['document.pdf']);
  }
});
