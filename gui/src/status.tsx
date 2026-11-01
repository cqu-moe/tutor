import { useRef, useState } from 'react';
import { post } from './api';
import { Link } from 'react-router';
import { ArrowRight } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription, Button } from '@cqu-moe/ui';
import type { GuiCourse, GuiJob } from './api';

export const active = (job?: GuiJob | null) =>
  job?.status === 'running' || job?.status === 'awaiting-route';
const stages: Record<string, string> = {
  import: '正在准备课程资料',
  preparing: '正在提取原始页面',
  ocr: '正在识别课程资料',
  route: '正在整理教学路线',
  generating: '正在撰写讲解稿',
  exporting: '正在排版与导出',
  revising: '正在修订讲解稿',
  resume: '正在读取教学路线',
  generate: '正在生成讲解稿',
  revise: '正在修订讲解稿',
  memory: '正在处理学习反馈',
  doctor: '正在检查本地环境',
};
const stageLabel = (job: GuiJob) =>
  job.status === 'awaiting-route'
    ? '教学路线已准备好，等待你确认'
    : job.status === 'failed' || job.status === 'needs-attention'
      ? '任务需要处理'
      : job.status === 'cancelled' ? '任务已取消，不会自动恢复' : job.status === 'succeeded'
        ? job.stage === 'saved'
          ? '教学路线已保存，稍后可继续'
          : '任务已完成'
        : (stages[job.stage] ?? '正在处理');
export function courseStatus(course: GuiCourse) {
  if (course.error) return '需要检查';
  const learned = course.chapters.filter((chapter) => chapter.status === 'learned').length;
  if (learned) return `${learned}/${course.chapters.length} 已学`;
  if (course.chapters.some((chapter) => chapter.status === 'in_progress')) return '正在学习';
  if (!course.confirmed && course.hasRoute) return '待确认路线';
  if (course.published) return '已有讲解稿';
  return course.confirmed ? '待生成讲解稿' : '待导入资料';
}
export const pageRange = (pages: number[]) => {
  if (!pages.length) return '尚无页面';
  return pages.length === 1
    ? `第 ${pages[0]} 页`
    : `${pages.length} 页资料 · 第 ${pages[0]}–${pages.at(-1)} 页`;
};
export function ErrorNotice({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertTitle>未能完成操作</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
export function JobStatus({
  job,
  courseId,
  refresh,
}: {
  job: GuiJob;
  courseId?: string;
  refresh?: () => void;
}) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  async function decide(body: Record<string, unknown>) {
    if (lock.current) return;
    lock.current = true; setSending(true); setError('');
    try { await post('/api/jobs/input', { id: job.id, ...body }); refresh?.(); }
    catch (error) { setError((error as Error).message); }
    finally { lock.current = false; setSending(false); }
  }
  return (
    <section className="job-status" aria-label="任务状态">
      <div className="row spread">
        <span
          role="status"
          className={['failed','needs-attention'].includes(job.status) ? 'error-text' : ''}
        >
          {stageLabel(job)}
        </span>
        <span className="muted">{job.course ?? '环境检查'}</span>
      </div>
      {job.status === 'running' && (
        <p className="muted">
          处理可能需要几分钟。页面可以刷新，任务会在本机继续。
        </p>
      )}
      {job.status === 'awaiting-route' && courseId && (
        <Button asChild variant="outline">
          <Link to={`/courses/${encodeURIComponent(courseId)}`}>
            查看并确认路线
            <ArrowRight aria-hidden="true" />
          </Link>
        </Button>
      )}
      <p className="muted">任务 {job.id}</p>
      {job.status === 'needs-attention' && <p>{job.log}</p>}
      {refresh && ['running', 'awaiting-route', 'needs-attention'].includes(job.status) && (
        <div className="row">
          {job.canRetry && <Button variant="outline" disabled={sending} onClick={() => void decide({ retry: true })}>继续原任务</Button>}
          <Button variant="outline" disabled={sending} onClick={() => void decide({ cancel: true })}>取消任务</Button>
        </div>
      )}
      {error && <p role="alert" className="error-text">{error}</p>}
      {job.log && job.status !== 'needs-attention' && (
        <details>
          <summary>查看运行记录</summary>
          <pre className="log">{job.log}</pre>
        </details>
      )}
    </section>
  );
}
