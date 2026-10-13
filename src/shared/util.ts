import {createHash,randomUUID} from 'node:crypto';
export const uid = (prefix='') => prefix + randomUUID();
export const sha256 = (value:string|Uint8Array) => createHash('sha256').update(value).digest('hex');
export const now = () => new Date().toISOString();
export const json = <T>(text:string):T => JSON.parse(text) as T;
export const escapeHtml = (text:string) => text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function parseModelJson<T>(text:string):T { const clean=text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''); return JSON.parse(clean) as T; }
export function ensureFinitePositive(n:unknown,name:string):number { if(typeof n!=='number'||!Number.isFinite(n)||n<=0)throw new Error(`${name} must be a positive number`);return n; }
