import type { GuiState, GuiDetail } from '../../src/gui-types';
export type {
  GuiState,
  GuiDetail,
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
        typeof course.name === 'string' &&
        Array.isArray(course.pages),
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
    typeof data.route !== 'string' ||
    typeof data.content !== 'string' ||
    !Array.isArray(data.files)
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
