import type {
  ClaudeCodeProject,
  Project,
  ProjectSource,
  ProjectSourceCreate,
  ProjectSourceCreated,
  ProjectSummary,
} from '@friday/shared-types';

const BACKEND_HTTP_URL = process.env.NEXT_PUBLIC_BACKEND_URL ?? 'http://127.0.0.1:8000';

/** Error carrying the HTTP status so callers can branch on e.g. 409. */
export class ProjectsApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ProjectsApiError';
    this.status = status;
  }
}

/** Fetch JSON from the backend, surfacing FastAPI's `{detail}` on failure.
 *  Network failures become status 0 so the UI has one error shape. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BACKEND_HTTP_URL}${path}`, init);
  } catch (err) {
    throw new ProjectsApiError(
      0,
      err instanceof Error ? `Backend unreachable: ${err.message}` : 'Backend unreachable',
    );
  }
  if (!res.ok) {
    throw new ProjectsApiError(res.status, await errorDetail(res));
  }
  return (await res.json()) as T;
}

async function errorDetail(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  try {
    const data = JSON.parse(raw) as { detail?: unknown };
    if (typeof data.detail === 'string') return data.detail;
    // Pydantic validation errors: [{loc, msg, ...}]
    if (Array.isArray(data.detail)) {
      const msgs = data.detail
        .map((d) => (d && typeof d === 'object' && 'msg' in d ? String(d.msg) : ''))
        .filter(Boolean);
      if (msgs.length) return msgs.join('; ');
    }
  } catch {
    /* not JSON */
  }
  return `HTTP ${res.status}${raw ? `: ${raw.slice(0, 200)}` : ''}`;
}

function json(method: string, body: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const data = await request<{ projects: ProjectSummary[] }>('/api/projects');
  return data.projects;
}

export async function createProject(name: string, description?: string): Promise<Project> {
  const data = await request<{ project: Project }>(
    '/api/projects',
    json('POST', { name, description: description || undefined }),
  );
  return data.project;
}

export async function fetchProject(
  projectId: string,
): Promise<{ project: Project; sources: ProjectSource[] }> {
  return request(`/api/projects/${projectId}`);
}

export async function updateProject(
  projectId: string,
  patch: { name?: string; description?: string; brief?: string },
): Promise<Project> {
  const data = await request<{ project: Project }>(
    `/api/projects/${projectId}`,
    json('PATCH', patch),
  );
  return data.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  await request(`/api/projects/${projectId}`, { method: 'DELETE' });
}

export async function uploadProjectFile(
  projectId: string,
  file: File,
  title?: string,
): Promise<ProjectSourceCreated[]> {
  const form = new FormData();
  form.append('file', file);
  if (title) form.append('title', title);
  const data = await request<{ sources: ProjectSourceCreated[] }>(
    `/api/projects/${projectId}/sources/file`,
    { method: 'POST', body: form },
  );
  return data.sources;
}

export async function addProjectSource(
  projectId: string,
  source: ProjectSourceCreate,
): Promise<ProjectSourceCreated[]> {
  const data = await request<{ sources: ProjectSourceCreated[] }>(
    `/api/projects/${projectId}/sources`,
    json('POST', source),
  );
  return data.sources;
}

export async function deleteProjectSource(projectId: string, sourceId: string): Promise<void> {
  await request(`/api/projects/${projectId}/sources/${sourceId}`, { method: 'DELETE' });
}

/** Kick off background brief generation. Throws ProjectsApiError with
 *  status 409 when the brief was hand-edited and `force` is false. */
export async function generateBrief(projectId: string, force = false): Promise<Project> {
  const data = await request<{ ok: boolean; started: boolean; project: Project }>(
    `/api/projects/${projectId}/brief`,
    json('POST', { force }),
  );
  return data.project;
}

export type FolderCandidate = { path: string; score: number };

/** Find a folder dropped in a browser tab (which hides absolute paths) by
 *  its name and its entries' names. Best match first. */
export async function locateFolder(name: string, children: string[]): Promise<FolderCandidate[]> {
  const data = await request<{ candidates: FolderCandidate[] }>(
    '/api/folders/locate',
    json('POST', { name, children }),
  );
  return data.candidates;
}

export async function listClaudeCodeProjects(): Promise<ClaudeCodeProject[]> {
  const data = await request<{ projects: ClaudeCodeProject[] }>('/api/claude-code/projects');
  return data.projects;
}

export async function fetchSessionProjects(sessionId: string): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>(`/api/sessions/${sessionId}/projects`);
  return data.projects;
}

export async function setSessionProjects(
  sessionId: string,
  projectIds: string[],
): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>(
    `/api/sessions/${sessionId}/projects`,
    json('PUT', { project_ids: projectIds }),
  );
  return data.projects;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
