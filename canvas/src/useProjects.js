import { useCallback, useEffect, useRef, useState } from 'react';
import { displayNodes, execute, listProjects, persistentNodes, read, saveGraph, remoteState } from './project-store.js';
import { cleanGraph } from './project-model.js';

export function useProjects({ nodesRef, edgesRef, setNodes, setEdges, nodes, edges, moving, disabled }) {
  const [project, setProject] = useState(null), [projects, setProjects] = useState([]), [status, setStatus] = useState('正在打开本地项目');
  const current = useRef(null), snapshot = useRef(''), queue = useRef(Promise.resolve()), busy = useRef(false), generation = useRef(0);
  busy.current = moving;
  const reload = useCallback(async () => {
    const active = await read('active'), value = active && await read('project:' + active);
    if (!value) return;
    const version = ++generation.current;
    const shown = await displayNodes(value.nodes);
    if (generation.current !== version) return;
    current.current = value;
    snapshot.current = JSON.stringify(cleanGraph(value.nodes, value.edges));
    nodesRef.current = shown; edgesRef.current = value.edges;
    setNodes(shown); setEdges(value.edges); setProject(value); setProjects(await listProjects()); setStatus('已保存在本机');
  }, [setNodes, setEdges, nodesRef, edgesRef]);
  const flush = useCallback(async () => {
    if (!current.current || disabled || busy.current) return;
    const graph = cleanGraph(persistentNodes(nodesRef.current), edgesRef.current);
    const serialized = JSON.stringify(graph);
    if (serialized === snapshot.current) return;
    setStatus('正在保存');
    const result = await saveGraph(current.current.id, graph.nodes, graph.edges, current.current.revision);
    snapshot.current = serialized; current.current = { ...current.current, ...graph, revision: result.revision };
    setStatus('已保存在本机');
  }, [nodesRef, edgesRef, disabled]);
  const serial = useCallback(action => {
    const promise = queue.current.then(action);
    queue.current = promise.catch(e => { setStatus('未保存：' + e.message); });
    return promise;
  }, []);
  const run = useCallback(command => serial(async () => {
    if (busy.current) throw Error('正在编辑视图，请稍后提交');
    await flush(); const result = await execute(command); await reload(); return result;
  }), [serial, flush, reload]);
  const create = useCallback(async name => run({ protocol: 1, id: crypto.randomUUID(), type: 'project.create', project_id: crypto.randomUUID(), name }), [run]);
  useEffect(() => {
    if (disabled) return;
    let stopped = false, checking = false;
    serial(async () => {
      if (!(await read('active'))) await execute({ protocol: 1, id: crypto.randomUUID(), type: 'project.create', project_id: crypto.randomUUID(), name: '我的创作项目' });
      if (!stopped) await reload();
    });
    const api = { protocol: 1, execute: run,
      projects: listProjects,
      state: () => serial(async () => { await flush(); return current.current ? await read('project:' + current.current.id) : null; }),
      receipt: commandId => read('receipt:' + commandId).then(v => v?.result || null) };
    window.canvasAgent = api;
    const poll = setInterval(async () => {
      if (stopped || checking || busy.current || document.hidden || !current.current) return;
      checking = true;
      try {
        const remote = await remoteState();
        const value = remote.active && await read('project:' + remote.active);
        if (value && (value.id !== current.current.id || value.revision !== current.current.revision)) {
          // 有本地未保存编辑时CAS失败，保留界面并提示冲突，不用远端静默覆盖。
          await serial(async () => { await flush(); await reload(); });
        }

      } catch (e) { if (!stopped) setStatus('项目同步：' + e.message); }
      finally { checking = false; }
    }, 2000);
    return () => { stopped = true; clearInterval(poll); if (window.canvasAgent === api) delete window.canvasAgent; };
  }, [disabled, run, reload, serial, flush]);
  useEffect(() => {
    if (disabled || !project || moving) return;
    const timer = setTimeout(() => { serial(flush); }, 500);
    return () => clearTimeout(timer);
  }, [nodes, edges, project, moving, disabled, serial, flush]);
  return { project, projects, status, create, run, reload: () => serial(reload), flush: () => serial(flush) };
}
