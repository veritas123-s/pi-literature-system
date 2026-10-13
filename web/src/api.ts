import type { ArtifactManifest, Command, ResearchBundle, RunEvent, RunRecord, RunSpec } from '../../src/shared/types.js';

export const API_URL_KEY = 'pi-research.api-url';
export interface Session { token: string; ownerId: string; expiresAt: string | number; user?: { id: string; login: string } }
export interface WorkerSummary { id?: string; workerId?: string; name?: string; lastSeenAt?: string | number | null; lastSeen?: string | number | null; online?: boolean; status?: string }
export interface UploadSummary { id: string; name?: string; filename?: string; size?: number; status?: string; received?: boolean; createdAt?: string }
export interface Detail { run: RunRecord; events: RunEvent[]; commands: Command[]; manifest: ArtifactManifest | null; bundle: ResearchBundle | null; uploads: UploadSummary[] }

export function validateApiUrl(value: string, allowLocal = false): string {
  const url = new URL(value.trim());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能包含账户、密码、查询参数或片段。');
  if (url.protocol !== 'https:' && !(allowLocal && local && url.protocol === 'http:')) throw new Error('请使用 HTTPS 服务地址；本机开发可使用 localhost。');
  return url.toString().replace(/\/$/, '');
}
export function isLocalApi(value: string): boolean {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname); } catch { return false; }
}
export function ticketFromFragment(fragment: string): string | null {
  const value = new URLSearchParams(fragment.replace(/^#/, '')).get('ticket');
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) return null;
  return value;
}
export function mergeEvents(current: RunEvent[], incoming: RunEvent[]): RunEvent[] {
  const all = new Map(current.map(event => [`${event.epoch}:${event.seq}`, event]));
  for (const event of incoming) all.set(`${event.epoch}:${event.seq}`, event);
  return [...all.values()].sort((a, b) => a.epoch - b.epoch || a.seq - b.seq).slice(-500);
}
export function currentRoleEvents(events: RunEvent[], epoch: number): Record<string, RunEvent> {
  const result: Record<string, RunEvent> = {};
  for (const event of events) {
    const role = event.data.role;
    if (event.epoch === epoch && typeof role === 'string') result[role] = event;
  }
  return result;
}
export function confirmedCommandText(command: Command, epoch?: number): string {
  return command.status === 'applied' ? epoch === 0 ? '云端已应用，任务尚未执行' : '执行端已确认' : command.status === 'received' ? '执行端已接收，等待应用' : '已请求，等待执行端';
}
export function referencedPapers(bundle: ResearchBundle): ResearchBundle['papers'] {
  const evidenceIds = new Set(bundle.claims.flatMap(claim => claim.evidenceIds));
  const spanIds = new Set(bundle.claims.flatMap(claim => claim.spanIds));
  const paperIds = new Set([
    ...bundle.evidence.filter(evidence => evidenceIds.has(evidence.id)).map(evidence => evidence.paperId),
    ...bundle.documents.filter(document => document.spans.some(span => spanIds.has(span.id))).map(document => document.paperId),
    ...bundle.paradigms.flatMap(paradigm => paradigm.representativePaperIds),
  ]);
  return bundle.papers.filter(paper => paperIds.has(paper.id));
}
export function safeExternalUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.toString() : undefined; } catch { return undefined; }
}
export function reportedCost(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const record = usage as Record<string, unknown>;
  return record.costKnown !== false && typeof record.costUsd === 'number' && Number.isFinite(record.costUsd) && record.costUsd >= 0 ? record.costUsd : undefined;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export class ResearchApi {
  constructor(public baseUrl: string, private token: string | null, private onUnauthorized?: () => void) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    if (init.body && !(init.body instanceof FormData)) headers.set('Content-Type', 'application/json');
    const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, credentials: 'omit', cache: 'no-store', redirect: 'error' });
    if (!response.ok) {
      if (response.status === 401) this.onUnauthorized?.();
      const data = await response.json().catch(() => null) as { message?: string; error?: string } | null;
      throw new ApiError(data?.message || data?.error || `请求未完成（${response.status}）`, response.status);
    }
    return response.json() as Promise<T>;
  }
  redeem(ticket: string): Promise<Session> { return this.request('/auth/ticket', { method: 'POST', body: JSON.stringify({ ticket }) }); }
  devLogin(): Promise<Session> { return this.request('/auth/dev', { method: 'POST' }); }
  runs(): Promise<{ runs: RunRecord[]; workers: WorkerSummary[] }> { return this.request('/api/runs'); }
  create(spec: RunSpec, deferStart = false): Promise<{ run: RunRecord }> { return this.request('/api/runs', { method: 'POST', body: JSON.stringify({ ...spec, deferStart }) }); }
  start(id: string): Promise<{ run: RunRecord }> { return this.request(`/api/runs/${encodeURIComponent(id)}/start`, { method: 'POST', body: '{}' }); }
  command(id: string, kind: Command['kind'], payload?: Partial<RunSpec>): Promise<{ command: Command; run: RunRecord }> {
    return this.request(`/api/runs/${encodeURIComponent(id)}/commands`, { method: 'POST', body: JSON.stringify({ kind, payload }) });
  }
  async detail(id: string, afterSeq = 0): Promise<Detail> {
    const path = `/api/runs/${encodeURIComponent(id)}`;
    const [run, events, commands, manifest, bundle, uploads] = await Promise.all([
      this.request<{run: RunRecord}>(path), this.request<{events: RunEvent[]}>(`${path}/events?afterSeq=${Math.max(0, afterSeq)}${afterSeq === 0 ? '&allEpochs=true' : ''}`),
      this.request<{commands: Command[]}>(`${path}/commands`), this.request<{manifest: ArtifactManifest | null}>(`${path}/artifacts`),
      this.request<{bundle: ResearchBundle | null}>(`${path}/bundle`), this.request<{uploads: UploadSummary[]}>(`${path}/uploads`),
    ]);
    return { run: run.run, events: events.events, commands: commands.commands, manifest: manifest.manifest, bundle: bundle.bundle, uploads: uploads.uploads };
  }
  async upload(id: string, file: File): Promise<UploadSummary> {
    const form = new FormData(); form.set('file', file);
    const result = await this.request<{upload: UploadSummary}>(`/api/runs/${encodeURIComponent(id)}/uploads`, { method: 'POST', body: form });
    return result.upload;
  }
  pair(name: string): Promise<{workerId: string; workerToken: string}> { return this.request('/api/workers', { method: 'POST', body: JSON.stringify({ name }) }); }
  async download(id: string, version: number, name: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/runs/${encodeURIComponent(id)}/artifacts/${version}/${encodeURIComponent(name)}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {}, credentials: 'omit', cache: 'no-store', redirect: 'error',
    });
    if (!response.ok) { if (response.status === 401) this.onUnauthorized?.(); throw new ApiError('文件下载失败，请重新登录或稍后再试。', response.status); }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
