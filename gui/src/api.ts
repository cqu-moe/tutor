import type { GuiState, GuiDetail } from '../../src/gui-types';
export type {
  GuiState,
  GuiDetail,
  GuiChapterDetail,
  GuiJob,
  GuiCourse,
  GuiAction,
} from '../../src/gui-types';

const token =
  document.querySelector<HTMLMetaElement>('meta[name="tutor-session"]')
    ?.content ?? '';
export async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { 'x-tutor-session': token, ...init?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      typeof body.error === 'string'
        ? body.error
        : `请求失败（${response.status}），请重试。`,
    );
  }
  return response;
}
export async function getState(signal?: AbortSignal): Promise<GuiState> {
  const data = await (await request('/api/state', { signal })).json();
  if (
    !Array.isArray(data.courses) ||
    !data.config ||
    !data.courses.every(
      (course: any) =>
        typeof course.id === 'string' &&
        typeof course.courseId === 'string' &&
        typeof course.name === 'string' &&
        Array.isArray(course.pages) &&
        Array.isArray(course.chapters),
    )
  )
    throw new Error('课程数据格式不正确，请检查本地记录。');
  return data;
}
export async function getDetail(
  id: string,
  signal?: AbortSignal,
): Promise<GuiDetail> {
  const data = await (
    await request(`/api/courses/${encodeURIComponent(id)}`, { signal })
  ).json();
  if (
    typeof data.courseId !== 'string' ||
    typeof data.route !== 'string' ||
    typeof data.content !== 'string' ||
    !Array.isArray(data.files) ||
    !Array.isArray(data.chapters)
  )
    throw new Error('讲解稿数据格式不正确。');
  return data;
}
export const post = (path: string, body: unknown) =>
  request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
export const filePath = (id: string, file: string) =>
  `/api/courses/${encodeURIComponent(id)}/files/${file.split('/').map(encodeURIComponent).join('/')}`;
export const chapterFilePath = (
  id: string,
  chapterId: string,
  file: string,
) =>
  `/api/courses/${encodeURIComponent(id)}/chapters/${encodeURIComponent(
    chapterId,
  )}/files/${file.split('/').map(encodeURIComponent).join('/')}`;
export const setChapterProgress = (
  id: string,
  chapterId: string,
  status: 'pending' | 'in_progress' | 'learned',
) =>
  post(
    `/api/courses/${encodeURIComponent(id)}/chapters/${encodeURIComponent(
      chapterId,
    )}/progress`,
    { status },
  );
export const setChapterTitle = (id: string, chapterId: string, title: string) =>
  post(
    `/api/courses/${encodeURIComponent(id)}/chapters/${encodeURIComponent(
      chapterId,
    )}/title`,
    { title },
  );
