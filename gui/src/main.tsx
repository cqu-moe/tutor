import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  NavLink,
  Link,
  Routes,
  Route,
  useNavigate,
} from 'react-router';
import {
  ArrowRight,
  BookOpen,
  ChevronRight,
  FileText,
  FolderOpen,
  ListChecks,
  Plus,
  RefreshCw,
  Settings2,
  Upload,
} from 'lucide-react';
import {
  ThemeProvider,
  Toaster,
  ThemeMenu,
  AppShell,
  ContentContainer,
  PageHeader,
  PageState,
  Button,
  ActionButton,
  Input,
  Label,
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  Alert,
  AlertTitle,
  AlertDescription,
} from '@cqu-moe/ui';
import { getState, post, request, type GuiState } from './api';
import '@cqu-moe/theme/styles.css';
import '@cqu-moe/ui/styles.css';
import './styles.css';
import { Course } from './course';
import {
  active,
  courseStatus,
  pageRange,
  ErrorNotice,
  JobStatus,
} from './status';

function App() {
  const [state, setState] = useState<GuiState>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const next = await getState(controller.signal);
        if (controller.signal.aborted) return;
        setState(next);
        setError('');
        if (active(next.job)) timer = setTimeout(load, 1200);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      }
    };
    void load();
    window.addEventListener('focus', refresh);
    return () => {
      controller.abort();
      clearTimeout(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [revision, refresh]);
  return (
    <AppShell
      brand={
        <Link to="/" className="brand">
          <BookOpen size={24} aria-hidden="true" />
          <span>
            Tutor<small>课程讲解工作台</small>
          </span>
        </Link>
      }
      utilities={<ThemeMenu />}
      navigation={
        <>
          <span className="nav-caption">学习空间</span>
          <NavLink to="/" end>
            <FolderOpen aria-hidden="true" />
            我的课程
          </NavLink>
          <NavLink to="/new">
            <Plus aria-hidden="true" />
            导入课程资料
          </NavLink>
          <span className="nav-caption">工作台</span>
          <NavLink to="/settings">
            <Settings2 aria-hidden="true" />
            环境与配置
          </NavLink>
          <div className="local-note">
            资料保存在本机
            <br />
            <span>按自己的节奏，学懂每一页。</span>
          </div>
        </>
      }
    >
      <ContentContainer>
        {error && (
          <div className="stack">
            <ErrorNotice message={error} />
            <Button variant="outline" onClick={refresh}>
              <RefreshCw aria-hidden="true" />
              重新连接
            </Button>
          </div>
        )}
        {!state ? (
          <>
            <PageHeader title="课程讲解工作台" />
            <PageState
              state={error ? 'error' : 'loading'}
              title={error ? '工作台暂时不可用' : '正在读取课程'}
              description={
                error
                  ? '确认 Tutor 仍在运行，然后重新连接。'
                  : '读取本机保存的课程资料与讲解稿。'
              }
            />
          </>
        ) : (
          <Routes>
            <Route
              path="/"
              element={<Courses state={state} refresh={refresh} />}
            />
            <Route
              path="/new"
              element={<ImportCourse state={state} refresh={refresh} />}
            />
            <Route
              path="/courses/:id"
              element={<Course state={state} refresh={refresh} />}
            />
            <Route
              path="/settings"
              element={<Settings state={state} refresh={refresh} />}
            />
            <Route
              path="*"
              element={
                <>
                  <PageHeader title="页面不存在" />
                  <PageState
                    state="not-found"
                    title="未找到页面"
                    description="返回课程列表，继续学习。"
                    action={
                      <Button asChild variant="outline">
                        <Link to="/">我的课程</Link>
                      </Button>
                    }
                  />
                </>
              }
            />
          </Routes>
        )}
      </ContentContainer>
    </AppShell>
  );
}
function Courses({ state, refresh }: { state: GuiState; refresh: () => void }) {
  const [query, setQuery] = useState('');
  const courses = state.courses.filter((course) =>
    course.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        title="我的课程"
        description="把课程资料，变成真正读得懂的讲解。"
        actions={
          <Button asChild>
            <Link to="/new">
              <Plus aria-hidden="true" />
              导入课程资料
            </Link>
          </Button>
        }
      />
      {state.job && (
        <JobStatus
          job={state.job}
          courseId={
            state.courses.find((course) => course.name === state.job?.course)
              ?.id
          }
        />
      )}
      {!state.courses.length ? (
        <div className="welcome panel">
          <div className="welcome-intro">
            <span className="eyebrow">从一份课程资料开始</span>
            <h2>
              不止读过，
              <br />
              还要读懂。
            </h2>
            <p>
              导入课件或教材，圈定这次想学的范围。先一起梳理教学路线，再得到包含推导、例子和图解的讲解稿。
            </p>
          </div>
          <ol className="steps">
            <li>
              <span>01</span>
              <div>
                <h3>选好这次要学的内容</h3>
                <p>上传 PDF，按页码或章节选择范围。</p>
              </div>
            </li>
            <li>
              <span>02</span>
              <div>
                <h3>确认适合你的教学路线</h3>
                <p>补充基础、调整顺序，把疑问说清楚。</p>
              </div>
            </li>
            <li>
              <span>03</span>
              <div>
                <h3>带走一份完整讲解</h3>
                <p>阅读、修订，下载 PDF 与可编辑源文件。</p>
              </div>
            </li>
          </ol>
        </div>
      ) : (
        <>
          <div className="row spread list-toolbar">
            <div className="search-field">
              <Label htmlFor="course-search" className="sr-only">
                搜索课程
              </Label>
              <Input
                id="course-search"
                type="search"
                placeholder="搜索课程…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <span className="muted">{courses.length} 门课程</span>
            <Button
              variant="ghost"
              size="icon"
              aria-label="刷新课程列表"
              onClick={refresh}
            >
              <RefreshCw aria-hidden="true" />
            </Button>
          </div>
          {courses.length ? (
            <div className="panel course-list">
              {courses.map((course) => (
                <article className="course-row" key={course.id}>
                  <FileText size={20} aria-hidden="true" />
                  <div className="course-info">
                    <Link to={`/courses/${encodeURIComponent(course.id)}`}>
                      {course.name}
                    </Link>
                    <p>
                      {pageRange(course.pages)}
                      {course.screenshots
                        ? ` · ${course.screenshots} 张截图`
                        : ''}
                    </p>
                  </div>
                  <span className="status-tag">{courseStatus(course)}</span>
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    aria-label={`打开 ${course.name}`}
                  >
                    <Link to={`/courses/${encodeURIComponent(course.id)}`}>
                      <ChevronRight aria-hidden="true" />
                    </Link>
                  </Button>
                </article>
              ))}
            </div>
          ) : (
            <PageState
              state="empty"
              title="没有匹配的课程"
              description="试试课程名称中的其他关键词。"
              action={
                <Button variant="outline" onClick={() => setQuery('')}>
                  清除搜索
                </Button>
              }
            />
          )}
        </>
      )}
      <p className="page-footnote">
        教学路线由你确认。讲解稿的生成进度，不代表你的学习进度。
      </p>
    </>
  );
}
function ImportCourse({
  state,
  refresh,
}: {
  state: GuiState;
  refresh: () => void;
}) {
  const navigate = useNavigate();
  const [mode, setMode] = useState('pages');
  const [file, setFile] = useState<File>();
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const lock = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || active(state.job)) return;
    if (!file) {
      setError('先选择一份 PDF 课程资料。');
      fileInput.current?.focus();
      return;
    }
    const data = new FormData(event.currentTarget);
    data.set('pdf', file);
    data.set('selectionMode', mode);
    if (
      file.size +
        data
          .getAll('screenshots')
          .reduce(
            (total, value) => total + (value instanceof File ? value.size : 0),
            0,
          ) >
      120 * 1024 * 1024
    ) {
      setError('本次文件合计不能超过 120 MB，请缩小 PDF 或截图后重试。');
      return;
    }
    lock.current = true;
    setSubmitting(true);
    setError('');
    try {
      await request('/api/jobs', { method: 'POST', body: data });
      refresh();
      const next = await getState();
      const course = next.courses.find(
        (entry) =>
          entry.name === String(data.get('course')).trim().normalize('NFC'),
      );
      navigate(course ? `/courses/${encodeURIComponent(course.id)}` : '/');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setSubmitting(false);
    }
  }
  return (
    <>
      <PageHeader
        title="导入课程资料"
        description="每次聚焦一个章节，或一段你想弄懂的内容。"
      />
      <div className="workspace-grid">
        <form className="stack" onSubmit={submit}>
          <section className="panel form-panel stack">
            <div className="field">
              <Label htmlFor="course-name">课程名称</Label>
              <Input
                id="course-name"
                name="course"
                required
                maxLength={160}
                placeholder="例如：数字逻辑设计"
                autoComplete="off"
              />
              <p className="hint">
                同名课程会延续已有记录；新资料不会立即覆盖已导出的讲解稿。
              </p>
            </div>
            <div className="field">
              <Label htmlFor="pdf">课程 PDF</Label>
              <div className="upload-area">
                <Upload size={24} aria-hidden="true" />
                <strong>{file?.name ?? '选择课件或教材'}</strong>
                <p>PDF 原文件，连同补充截图合计最多 120 MB</p>
                <Input
                  ref={fileInput}
                  id="pdf"
                  name="pdf"
                  type="file"
                  accept=".pdf,application/pdf"
                  aria-describedby={error ? 'import-error' : undefined}
                  onChange={(event) => {
                    setFile(event.target.files?.[0]);
                    setError('');
                  }}
                />
              </div>
            </div>
            <div className="form-pair">
              <div className="field">
                <Label htmlFor="selection-mode">选择范围</Label>
                <Select value={mode} onValueChange={setMode}>
                  <SelectTrigger id="selection-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="pages">按 PDF 页码</SelectItem>
                    <SelectItem value="chapter">按书签章节</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="field">
                <Label htmlFor="selection">
                  {mode === 'pages' ? '页码范围' : '完整书签标题'}
                </Label>
                <Input
                  key={mode}
                  id="selection"
                  name="selection"
                  required
                  maxLength={300}
                  pattern={
                    mode === 'pages'
                      ? '[0-9]+(-[0-9]+)?(, *[0-9]+(-[0-9]+)?)*'
                      : undefined
                  }
                  placeholder={
                    mode === 'pages'
                      ? '例如：1-6 或 1,3-5'
                      : '输入 PDF 中的完整书签标题'
                  }
                />
                <p className="hint">
                  {mode === 'pages'
                    ? '使用 PDF 文件的实际页码，从第 1 页开始。'
                    : 'PDF 需要自带书签，标题必须完全一致。'}
                </p>
              </div>
            </div>
            <details>
              <summary>补充截图（可选）</summary>
              <div className="field">
                <Label htmlFor="screenshots">板书、题目或补充图示</Label>
                <Input
                  id="screenshots"
                  name="screenshots"
                  type="file"
                  multiple
                  accept=".png,.jpg,.jpeg,.webp"
                />
                <p className="hint">最多 12 张，支持 PNG、JPEG 和 WebP。</p>
              </div>
            </details>
          </section>
          {error && (
            <div id="import-error" role="alert">
              <ErrorNotice message={error} />
            </div>
          )}
          {active(state.job) && (
            <Alert>
              <AlertTitle>已有任务正在进行</AlertTitle>
              <AlertDescription>
                先在课程中确认教学路线，或等待当前任务结束。填写的内容会保留。
              </AlertDescription>
            </Alert>
          )}
          <div className="row">
            <ActionButton
              type="submit"
              disabled={active(state.job)}
              state={submitting ? 'loading' : error ? 'error' : 'idle'}
              labels={{
                idle: '解析并规划路线',
                loading: '正在上传资料…',
                error: '重试导入',
                success: '已开始解析',
              }}
            />
            <Button asChild variant="ghost">
              <Link to="/">返回课程</Link>
            </Button>
          </div>
        </form>
        <aside className="context-note">
          <ListChecks size={24} aria-hidden="true" />
          <h2>先对齐，再展开</h2>
          <p>资料解析后，你会看到本次范围、前置知识、讲解顺序和待核实内容。</p>
          <p>你可以先调整路线，确认后再生成讲解稿。</p>
          <dl>
            <div>
              <dt>资料识别</dt>
              <dd>
                {state.config.ocr === 'mistral' ? 'Mistral OCR' : 'MinerU VLM'}
              </dd>
            </div>
            <div>
              <dt>讲解模型</dt>
              <dd>{state.config.model}</dd>
            </div>
          </dl>
          <p className="hint">
            所选页面和截图会发送至已配置的 OCR 与模型服务。
          </p>
          <Link to="/settings">
            检查环境与配置 <ArrowRight size={16} aria-hidden="true" />
          </Link>
        </aside>
      </div>
    </>
  );
}
function Settings({
  state,
  refresh,
}: {
  state: GuiState;
  refresh: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function check() {
    if (lock.current || active(state.job)) return;
    lock.current = true;
    setSending(true);
    setError('');
    try {
      await post('/api/jobs', { action: 'doctor' });
      refresh();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  return (
    <>
      <PageHeader
        title="环境与配置"
        description="检查本机的资料解析、讲解模型与文档导出环境。"
      />
      <section className="panel settings-panel">
        <dl className="settings-list">
          <div>
            <dt>课程资料目录</dt>
            <dd>{state.config.dataDir}</dd>
          </div>
          <div>
            <dt>讲解模型</dt>
            <dd>{state.config.model}</dd>
          </div>
          <div>
            <dt>资料识别服务</dt>
            <dd>
              {state.config.ocr === 'mistral' ? 'Mistral OCR' : 'MinerU VLM'}
            </dd>
          </div>
        </dl>
      </section>
      <section className="stack settings-copy">
        <h2>开始前，检查一次</h2>
        <p className="muted">
          检查 PDF 工具、排版与绘图依赖、模型配置和 OCR
          凭据是否已设置。此检查只在本机运行，不验证在线凭据，也不调用模型或
          OCR。
        </p>
        <ActionButton
          disabled={active(state.job)}
          state={
            sending || (state.job?.action === 'doctor' && active(state.job))
              ? 'loading'
              : 'idle'
          }
          labels={{
            idle: '检查运行环境',
            loading: '正在检查环境…',
            success: '检查完成',
            error: '重试检查',
          }}
          onClick={() => void check()}
        />
        {error && <ErrorNotice message={error} />}
      </section>
      {state.job?.action === 'doctor' && <JobStatus job={state.job} />}
      <details className="configuration-help">
        <summary>修改模型或 OCR 配置</summary>
        <p>工作台沿用启动时指定的本地配置。修改后重启 Tutor：</p>
        <pre className="log">
          {
            'tutor --env-file ~/.config/tutor/env gui \\\n  --ocr mistral --model provider/model \\\n  --data-dir .tutor'
          }
        </pre>
        <p className="hint">
          模型配置与凭据保存在 Pi 配置目录，可通过 --agent-dir
          指定。凭据不在页面中显示或保存。
        </p>
      </details>
    </>
  );
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <BrowserRouter>
      <App />
    </BrowserRouter>
    <Toaster />
  </ThemeProvider>,
);
