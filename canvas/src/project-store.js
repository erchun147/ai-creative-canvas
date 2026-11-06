import { cleanGraph } from './project-model.js';
let session;
async function request(route, { method = 'GET', body, type } = {}) {
  if (!session) session = fetch('/local/v1/session', { cache: 'no-store' }).then(async r => { if (!r.ok) throw Error('本地服务未就绪'); return r.json(); });
  const info = await session;
  const response = await fetch('/local/v1' + route, { method, cache: 'no-store',
    headers: { Authorization: 'Bearer ' + info.token, ...(body != null ? { 'Content-Type': type || 'application/json' } : {}) }, body });
  const value = await response.json(); if (response.status === 401) session = null; if (!response.ok) throw Error(value.error || '本地接口失败');
  return value;
}
export async function read(key) {
  if (key === 'active') return (await request('/state')).active;
  const [kind, value] = key.split(':');
  const route = { project: 'projects', receipt: 'receipts', asset: 'assets' }[kind];
  if (!route) throw Error('本地记录类型无效');
  return request('/' + route + '/' + encodeURIComponent(value));
}
export const listProjects = () => request('/projects');
export const remoteState = () => request('/state');
export const execute = command => request('/commands', { method: 'POST', body: JSON.stringify(command) });
export const saveGraph = (projectId, nodes, edges, expectedRevision) => execute({ protocol: 1, id: 'edit_' + crypto.randomUUID(), project_id: projectId,
  type: 'graph.replace', expected_revision: expectedRevision, ...cleanGraph(nodes, edges) });
export async function putAsset(asset) {
  for (const [field, blob] of Object.entries(asset.blobs)) await request('/assets/' + asset.id + '/' + field, { method: 'PUT', body: blob, type: blob.type });
}
export async function displayNodes(nodes) {
  return Promise.all(nodes.map(async n => {
    if (!n.data.asset_id || (n.data.orig && n.data.t64 && n.data.t160 && n.data.t480 && n.data.t1200) || (n.data.src && n.data.t480)) return n;
    const asset = await read('asset:' + n.data.asset_id);
    return asset ? { ...n, data: { ...n.data, ...asset.urls } } : n;
  }));
}
export const persistentNodes = nodes => nodes;
