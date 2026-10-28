import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import Markdown from 'react-markdown';
import { ArrowDownToLine, ChevronRight } from 'lucide-react';
import {
  PageHeader,
  PageState,
  Button,
  ActionButton,
  Label,
  Textarea,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  toast,
} from '@cqu-moe/ui';
import {
  getDetail,
  filePath,
  post,
  request,
  type GuiDetail,
  type GuiState,
} from './api';
import {
  active,
  courseStatus,
  pageRange,
  ErrorNotice,
  JobStatus,
} from './status';

function FeedbackForm({
  label,
  placeholder,
  onSubmit,
  disabled,
  value,
  onChange,
}: {
  label: string;
  placeholder: string;
  onSubmit: (value: string) => Promise<void>;
  disabled: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const lock = useRef(false);
  const id = label.replaceAll(' ', '-');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (lock.current || disabled) return;
    lock.current = true;
    setSending(true);
    setError('');
    try {
      await onSubmit(value);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  return (
    <form onSubmit={submit} className="stack feedback-form">
      <div className="field">
        <Label htmlFor={id}>{label}</Label>
        <Textarea
          id={id}
          required
          maxLength={4000}
          rows={3}
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-describedby={error ? `${id}-error` : undefined}
        />
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="error-text">
          {error}
        </p>
      )}
      <ActionButton
        type="submit"
        state={sending ? 'loading' : error ? 'error' : 'idle'}
        variant="outline"
        disabled={disabled || !value.trim()}
        labels={{
          idle: label,
          loading: '正在提交…',
          error: '重试提交',
          success: '已提交',
        }}
      />
    </form>
  );
}
export function Course({
  state,
  refresh,
}: {
  state: GuiState;
  refresh: () => void;
}) {
  const { id = '' } = useParams();
  const course = state.courses.find((entry) => entry.id === id);
  const job = state.job?.course === course?.name ? state.job : null;
  const [loaded, setLoaded] = useState<{ id: string; detail: GuiDetail }>();
  const detail = loaded?.id === id ? loaded.detail : undefined;
  const [feedbackDrafts, setFeedbackDrafts] = useState({
    route: '',
    revision: '',
    memory: '',
  });
  useEffect(
    () => setFeedbackDrafts({ route: '', revision: '', memory: '' }),
    [id],
  );
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [tab, setTab] = useState('route');
  const lock = useRef(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    setTab(course?.published && course.confirmed ? 'lecture' : 'route');
  }, [id, course?.published, course?.confirmed]);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    if (!course?.hasRoute && active(job)) return () => controller.abort();
    getDetail(id, controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) setLoaded({ id, detail: data });
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [id, course?.hasRoute, course?.updatedAt, job?.status, job?.id, reload]);
  async function action(body: unknown, endpoint = '/api/jobs') {
    if (lock.current) return;
    lock.current = true;
    setSending(true);
    setError('');
    try {
      await post(endpoint, body);
      refresh();
    } catch (error) {
      setError((error as Error).message);
      throw error;
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  async function download(file: string) {
    try {
      const response = await request(filePath(id, file));
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = file.split('/').at(-1)!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }
  if (!course)
    return (
      <>
        <PageHeader title="课程详情" />
        <PageState
          state="not-found"
          title="课程不存在"
          description="这门课程尚未保存，或已经被移走。"
          action={
            <Button asChild variant="outline">
              <Link to="/">返回课程</Link>
            </Button>
          }
        />
      </>
    );
  return (
    <>
      <Link to="/" className="back-link">
        我的课程 <ChevronRight size={16} aria-hidden="true" />
      </Link>
      <PageHeader
        title={course.name}
        description={`${pageRange(course.pages)} · ${courseStatus(course)}`}
        actions={
          course.published && (
            <Button
              variant="outline"
              onClick={() => void download('document.pdf')}
            >
              <ArrowDownToLine aria-hidden="true" />
              下载 PDF
            </Button>
          )
        }
      />
      {job && <JobStatus job={job} />}
      {error && (
        <div className="stack">
          <ErrorNotice message={error} />
          <Button
            variant="outline"
            onClick={() => {
              setReload((value) => value + 1);
              refresh();
            }}
          >
            重新读取
          </Button>
        </div>
      )}
      {!detail ? (
        !error && (
          <PageState
            state="loading"
            title="正在读取课程"
            description="读取教学路线与已保存的讲解稿。"
          />
        )
      ) : (
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList variant="line">
            <TabsTrigger value="route">教学路线</TabsTrigger>
            <TabsTrigger value="lecture">讲解稿</TabsTrigger>
            <TabsTrigger value="memory">学习反馈</TabsTrigger>
          </TabsList>
          <TabsContent value="route">
            <div className="workspace-grid">
              <section className="panel reading-panel">
                {detail.route ? (
                  <SafeMarkdown>{detail.route}</SafeMarkdown>
                ) : (
                  <PageState
                    state="empty"
                    title="教学路线尚未准备好"
                    description={
                      active(job)
                        ? '资料解析完成后，教学路线会显示在这里。'
                        : '重新导入课程资料以整理教学路线。'
                    }
                    action={
                      !active(job) && (
                        <Button asChild variant="outline">
                          <Link to="/new">导入资料</Link>
                        </Button>
                      )
                    }
                  />
                )}
              </section>
              <aside className="stack context-note">
                <h2>{course.confirmed ? '路线已确认' : '让路线适合你'}</h2>
                <p>
                  {course.confirmed
                    ? '根据这份路线生成完整讲解稿。重新生成成功后会替换现有导出。'
                    : '检查范围和顺序，也可以补充你的基础与疑问。确认之后，才会生成完整讲解稿。'}
                </p>
                {job?.status === 'awaiting-route' ? (
                  <>
                    <ActionButton
                      state={sending ? 'loading' : 'idle'}
                      labels={{
                        idle: '确认并生成讲解稿',
                        loading: '正在确认…',
                        success: '已确认',
                        error: '重试确认',
                      }}
                      onClick={() =>
                        void action(
                          { id: job.id, confirm: true, route: detail.route },
                          '/api/jobs/input',
                        ).catch(() => {})
                      }
                    />
                    <Button
                      variant="ghost"
                      disabled={sending}
                      onClick={() =>
                        void action(
                          { id: job.id, defer: true },
                          '/api/jobs/input',
                        ).catch(() => {})
                      }
                    >
                      保存路线，稍后继续
                    </Button>
                  </>
                ) : (
                  detail.route && (
                    <ActionButton
                      disabled={active(state.job)}
                      state={sending ? 'loading' : 'idle'}
                      labels={{
                        idle: course.confirmed
                          ? course.published
                            ? '重新生成讲解稿'
                            : '生成讲解稿'
                          : '继续确认路线',
                        loading: '正在开始…',
                        success: '已开始',
                        error: '重试',
                      }}
                      onClick={() =>
                        void action({
                          action: course.confirmed ? 'generate' : 'resume',
                          courseId: id,
                        }).catch(() => {})
                      }
                    />
                  )
                )}
                {!course.confirmed && detail.route && (
                  <FeedbackForm
                    label="调整教学路线"
                    placeholder="例如：先补充逻辑门基础，再讲布尔代数，增加一个逐步推导的例子。"
                    value={feedbackDrafts.route}
                    onChange={(route) =>
                      setFeedbackDrafts((drafts) => ({ ...drafts, route }))
                    }
                    disabled={sending || job?.status !== 'awaiting-route'}
                    onSubmit={(feedback) =>
                      action({ id: job?.id, feedback }, '/api/jobs/input')
                    }
                  />
                )}
                {active(state.job) && job?.status !== 'awaiting-route' && (
                  <p className="hint">当前任务结束后，可以继续操作。</p>
                )}
              </aside>
            </div>
          </TabsContent>
          <TabsContent value="lecture">
            {detail.content ? (
              <div className="workspace-grid">
                <section className="panel reading-panel">
                  <div className="row spread">
                    <h2>已保存的讲解稿</h2>
                    <Button
                      variant="ghost"
                      onClick={() => void download('content.md')}
                    >
                      <ArrowDownToLine aria-hidden="true" />
                      Markdown
                    </Button>
                  </div>
                  {!course.confirmed && (
                    <p className="hint">
                      这是上一次导出的讲解稿。新资料仍在等待路线确认。
                    </p>
                  )}
                  <p className="hint">
                    下方为文字预览；完整公式、表格与插图请查看 PDF。
                  </p>
                  <SafeMarkdown>{detail.content}</SafeMarkdown>
                </section>
                <aside className="stack context-note">
                  <h2>把没懂的地方再讲清楚</h2>
                  <FeedbackForm
                    label="修订讲解稿"
                    value={feedbackDrafts.revision}
                    onChange={(revision) =>
                      setFeedbackDrafts((drafts) => ({ ...drafts, revision }))
                    }
                    placeholder="例如：补充德摩根定律的完整推导，并增加一道带解答的例题。"
                    disabled={active(state.job) || sending}
                    onSubmit={(feedback) =>
                      action({ action: 'revise', courseId: id, feedback })
                    }
                  />
                  <details>
                    <summary>全部导出文件 · {detail.files.length}</summary>
                    <ul className="file-list">
                      {detail.files.map((file) => (
                        <li key={file}>
                          <Button
                            variant="ghost"
                            onClick={() => void download(file)}
                          >
                            <ArrowDownToLine aria-hidden="true" />
                            <span>{file}</span>
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </details>
                </aside>
              </div>
            ) : (
              <PageState
                state="empty"
                title="讲解稿还没有生成"
                description="先确认教学路线，再开始生成。完成后可在这里阅读、修订和下载。"
                action={
                  <Button variant="outline" onClick={() => setTab('route')}>
                    查看教学路线
                  </Button>
                }
              />
            )}
          </TabsContent>
          <TabsContent value="memory">
            <section className="panel form-panel stack">
              <h2>记录你真正学到的地方</h2>
              <p className="muted">
                告诉 Tutor
                你的学习进度、偏好和薄弱点，用于后续讲解。也可以查询已经保存的学习者记忆。
              </p>
              <FeedbackForm
                label="发送学习反馈"
                value={feedbackDrafts.memory}
                onChange={(memory) =>
                  setFeedbackDrafts((drafts) => ({ ...drafts, memory }))
                }
                placeholder="例如：我已经理解与门和或门，但还不熟悉德摩根定律。之后请多用真值表解释。"
                disabled={active(state.job) || sending}
                onSubmit={(feedback) =>
                  action({ action: 'memory', courseId: id, feedback })
                }
              />
              {job?.action === 'memory' && job.status === 'succeeded' && (
                <pre className="log">{job.log}</pre>
              )}
            </section>
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
function SafeMarkdown({ children }: { children: string }) {
  return (
    <div className="prose">
      <Markdown
        skipHtml
        components={{
          img: ({ alt }) => (
            <span className="hint">［插图：{alt || '详见 PDF'}］</span>
          ),
          a: ({ children }) => <span>{children}</span>,
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}
