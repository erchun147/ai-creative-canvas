// 画布合同：只保存展示与来源关系，不接触平台凭据或创建生成任务。
export const PROTOCOL = 1;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
export function id(value) {
  if (typeof value !== 'string' || !ID.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw Error('标识无效');
  return value;
}
const text = (value, max = 20000) => {
  if (typeof value !== 'string' || value.length > max) throw Error('文字过长或无效');
  return value;
};
export function mediaUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) throw Error('素材地址无效');
  if (/^\/local\/v1\/assets\/[A-Za-z0-9_-]{1,100}\/(orig|src|t64|t160|t480|t1200)$/.test(value)) return value;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('只接受HTTPS或已导入的本地素材');
  return value;
}
function node(value) {
  id(value.id);
  if (!['prompt', 'image', 'video'].includes(value.type)) throw Error('节点类型无效');
  const { x, y } = value.position || {};
  if (![x, y].every(n => Number.isFinite(n) && Math.abs(n) <= 1e7)) throw Error('节点位置无效');
  const d = value.data || {}, data = { title: text(d.title || '', 500) };
  for (const k of ['text', 'tag', 'meta', 'task_id']) if (d[k] != null) data[k] = text(d[k]);
  for (const k of ['t64', 't160', 't480', 't1200', 'orig', 'src']) if (d[k]) data[k] = mediaUrl(d[k]);
  // blob地址只在内存投影，持久化保存的是IndexedDB资产ID。
  if (d.asset_id) data.asset_id = id(d.asset_id);
  if (typeof d.audio === 'boolean') data.audio = d.audio;
  return { id: value.id, type: value.type, position: { x, y }, data };
}
export function edge(value, nodes) {
  id(value.id); id(value.source); id(value.target);
  const source = nodes.find(n => n.id === value.source), target = nodes.find(n => n.id === value.target);
  if (!source || !target || source.id === target.id || source.type === 'video' || target.type === 'prompt') throw Error('连线端点无效');
  return { id: value.id, source: value.source, target: value.target, type: 'smoothstep',
    label: text(value.label || '', 100), style: { stroke: '#4A5265', strokeWidth: 1.5 },
    labelStyle: { fill: '#A2A9B6', fontSize: 11 }, labelBgStyle: { fill: '#14161A' } };
}
export function cleanGraph(nodes, edges) {
  if (!Array.isArray(nodes) || nodes.length > 10000 || !Array.isArray(edges) || edges.length > 20000) throw Error('图谱过大');
  const safe = nodes.map(node);
  if (new Set(safe.map(n => n.id)).size !== safe.length) throw Error('节点重复');
  const links = edges.map(e => edge(e, safe));
  if (new Set(links.map(e => e.id)).size !== links.length) throw Error('连线重复');
  return { nodes: safe, edges: links };
}
export function applyCommand(project, command) {
  if (command.protocol !== PROTOCOL) throw Error('画布协议不兼容');
  id(command.id); id(command.project_id);
  if (command.type === 'project.create') {
    if (project) throw Error('项目已存在');
    return { id: command.project_id, name: text(command.name || '未命名项目', 100), nodes: [], edges: [], revision: 1 };
  }
  if (!project) throw Error('项目不存在');
  if (command.expected_revision != null && command.expected_revision !== project.revision) throw Error('项目已修改，请重新读取');
  if (command.type === 'project.open') return project;
  let nodes = project.nodes, edges = project.edges;
  if (command.type === 'graph.arrange') {
    const columns = Math.max(1, Math.min(12, Number(command.columns) || 4));
    if (command.layout === 'grid') nodes = nodes.map((n, i) => ({ ...n, position: { x: 40 + (i % columns) * 400, y: 40 + Math.floor(i / columns) * 240 } }));
    else {
      const depths = new Map(), remaining = new Set(nodes.map(n => n.id));
      for (let pass = 0; pass < nodes.length && remaining.size; pass++) {
        let changed = false;
        for (const n of nodes) {
          if (!remaining.has(n.id)) continue;
          const parents = edges.filter(e => e.target === n.id).map(e => e.source);
          if (parents.some(p => !depths.has(p))) continue;
          depths.set(n.id, parents.length ? 1 + Math.max(...parents.map(p => depths.get(p))) : 0); remaining.delete(n.id); changed = true;
        }
        if (!changed) break;
      }
      const rows = new Map();
      nodes = nodes.map(n => { const depth = depths.get(n.id) || 0, row = rows.get(depth) || 0; rows.set(depth, row + 1); return { ...n, position: { x: 40 + depth * 400, y: 40 + row * 240 } }; });
    }
  } else if (command.type === 'graph.replace') ({ nodes, edges } = cleanGraph(command.nodes, command.edges));
  else if (command.type === 'generation.record') {
    // 一个任务对应稳定节点ID，既保留引用关系，也避免网络恢复后重复入板。
    const task = id(command.task_id); if (task.length > 64) throw Error('任务标识过长');
    const prefix = 'task_' + task;
    const p = node({ id: prefix + '_p', type: 'prompt', position: command.position || { x: project.nodes.length * 30, y: project.nodes.length * 35 },
      data: { title: command.title || '生成提示词', text: command.prompt || '', task_id: task } });
    const refs = (command.references || []).map(node), outputs = (command.outputs || []).map(node);
    if (!outputs.length || outputs.some(n => n.type === 'prompt') || refs.some(n => n.type !== 'image')) throw Error('作品或参考图无效');
    const map = new Map(nodes.map(n => [n.id, n]));
    for (const n of [p, ...refs, ...outputs]) map.set(n.id, n);
    nodes = [...map.values()];
    const links = new Map(edges.map(e => [e.id, e]));
    for (const [outputIndex, n] of outputs.entries()) {
      const sources = n.type === 'video' && refs.length ? refs : [p];
      for (const [sourceIndex, source] of sources.entries()) {
        const link = edge({ id: 'link_' + task + '_' + outputIndex + '_' + sourceIndex, source: source.id, target: n.id, label: n.type === 'video' && refs.length ? '图生视频' : n.type === 'video' ? '文生视频' : '生图' }, nodes);
        links.set(link.id, link);
      }
    }
    edges = [...links.values()];
    ({ nodes, edges } = cleanGraph(nodes, edges));
  } else throw Error('不支持的画布命令');
  return { ...project, nodes, edges, revision: project.revision + 1 };
}
