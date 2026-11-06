import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, BackgroundVariant, Handle, Position,
  addEdge, useNodesState, useEdgesState, useReactFlow, useStore, useStoreApi, MarkerType,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import './canvas.css';
import { useCull } from './useCull';
import OverviewLayer, { OV } from './OverviewLayer.jsx';
import { useProjects } from './useProjects.js';
import { localAsset } from './media.js';
import { putAsset, displayNodes } from './project-store.js';

const T0 = './demo/';
const T1 = './demo/';
const T4 = './demo/';
const T12 = './demo/';
const M = './media/';

/* ===== 图标：统一 24 画布 / 1.5 描边 / currentColor ===== */
const S = ({ children, size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);
const IcCursor = (p) => <S {...p}><path d="M5 3l6.5 16 2.2-6.3L20 10.5 5 3z" /></S>;
const IcPlus = (p) => <S {...p}><path d="M12 5v14M5 12h14" /></S>;
const IcLink = (p) => <S {...p}><path d="M9.5 14.5l5-5M8 12l-2 2a3 3 0 004.2 4.2l2-2M16 12l2-2a3 3 0 00-4.2-4.2l-2 2" /></S>;
const IcGrid = (p) => <S {...p}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M4 10h16M10 4v16" /></S>;
const IcPlay = (p) => <S {...p}><path d="M8 5.5l10 6.5-10 6.5v-13z" /></S>;
const IcFit = (p) => <S {...p}><path d="M4 9V5h4M20 15v4h-4M4 15v4h4M20 9V5h-4" /></S>;
const IcFull = (p) => <S {...p}><path d="M9 4H4v5M15 4h5v5M15 20h5v-5M9 20H4v-5" /></S>;
const IcMore = (p) => <S {...p}><circle cx="6" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="18" cy="12" r="1" /></S>;
const IcMinus = (p) => <S {...p}><path d="M5 12h14" /></S>;
const IcClose = (p) => <S {...p}><path d="M6 6l12 12M18 6L6 18" /></S>;
const IcExpand = (p) => <S {...p}><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></S>;
const IcEmpty = (p) => <S {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 15l4-4 4 4 3-3 7 7" /><circle cx="15" cy="9" r="1.5" /></S>;

/* ===== 媒体元数据加载队列：最多 2 并发，15 秒超时 ===== */
const MAX_LOADS = 2;
const q = [];
let act = 0;
function pump() {
  while (act < MAX_LOADS && q.length) {
    const e = q.shift();
    if (e.cancelled) continue;
    act += 1;
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      e.el.removeEventListener('loadedmetadata', fin);
      e.el.removeEventListener('error', fin);
      act -= 1;
      pump();
    };
    const timer = setTimeout(fin, 15000);
    e.el.addEventListener('loadedmetadata', fin, { once: true });
    e.el.addEventListener('error', fin, { once: true });
    e.el.src = e.src;
  }
}
function enqueueLoad(el, src) {
  const entry = { el, src, cancelled: false };
  q.push(entry);
  pump();
  return () => { entry.cancelled = true; };
}

/* ===== 清晰度分级：按缩放选用哪一级缩略图 ===== */
const TierCtx = createContext(1);     // 0=160px  1=480px  2=1200px
const OpenCtx = createContext(() => {});
const CullCtx = createContext(null);  // useCull 的 register
const pickSrc = (data, tier) => {
  if (!data) return null;
  if (tier === 0) return data.t160 || data.t480 || null;
  if (tier === 2) return data.t1200 || data.t480 || null;
  return data.t480 || data.t1200 || null;
};

/* ===== 三种节点 ===== */
/* 每个节点最外层 div 都挂到 useCull 的注册表上（tldraw 式：DOM 常驻、只切 display） */
function PromptNode({ id, data, selected }) {
  const reg = useContext(CullCtx);
  return (
    <div ref={reg ? reg(id) : undefined} className={'nd nd-prompt' + (selected ? ' sel' : '')}>
      <Handle type="source" position={Position.Right} className="hp" />
      <div className="nd-hd"><i className="dot dot-p" />提示词</div>
      <div className="nd-title">{data.title}</div>
      <div className="nd-text">{data.text}</div>
    </div>
  );
}

function ImageNode({ id, data, selected }) {
  const tier = useContext(TierCtx);
  const open = useContext(OpenCtx);
  const reg = useContext(CullCtx);
  const src = pickSrc(data, tier);
  const ref = reg ? reg(id) : undefined;
  /* 只切 class，不换结构：换结构会让 2000 个节点整棵子树重挂一次（实测 DOM 增删 20000） */
  return (
    <div ref={ref} className={'nd nd-media' + (tier === 0 ? ' nd-lite' : '') + (selected ? ' sel' : '')}>
      <Handle type="target" position={Position.Left} className="hp" />
      <Handle type="source" position={Position.Right} className="hp" />
      <div className="nd-hd"><i className="dot dot-i" />图片<span className="nd-tag">{data.tag}</span></div>
      {src ? (
        <button className="nd-zoom" onClick={() => open({ src: data.orig || data.t1200, title: data.title })} title="点开看大图"
          style={data.t160 ? { backgroundImage: `url("${data.t160}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
          {/* lazy：被 display:none 挡住的高清图不会白白解码，进视口才加载 */}
          <img className="nd-img" src={src} alt={data.title} decoding="async" loading="lazy" />
          <span className="zoom-ic"><IcExpand size={14} /></span>
        </button>
      ) : <div className="nd-img nd-ph">仅缩略图未生成</div>}
      <div className="nd-ft"><span className="nd-name">{data.title}</span><span className="mono">{data.meta}</span></div>
    </div>
  );
}

function VideoNode({ id, data, selected }) {
  const [play, setPlay] = useState(false);
  const tier = useContext(TierCtx);
  const open = useContext(OpenCtx);
  const reg = useContext(CullCtx);
  const src = pickSrc(data, tier);
  const ref = reg ? reg(id) : undefined;
  const vRef = useRef(null);
  useEffect(() => {
    if (play && vRef.current) enqueueLoad(vRef.current, data.src);
  }, [play, data.src]);
  return (
    <div ref={ref} className={'nd nd-media' + (tier === 0 ? ' nd-lite' : '') + (selected ? ' sel' : '')}>
      <Handle type="target" position={Position.Left} className="hp" />
      <div className="nd-hd">
        <i className="dot dot-v" />视频
        {data.audio === false && <span className="nd-warn" title="源文件本身没有音轨">无音轨</span>}
        <span className="nd-tag">{data.meta}</span>
      </div>
      {play ? (
        <video ref={vRef} className="nd-img" poster={src} controls autoPlay playsInline preload="metadata" />
      ) : (
        <div className="nd-vwrap">
          <button className="nd-play" onClick={() => setPlay(true)} aria-label="播放"
            style={data.t160 ? { backgroundImage: `url("${data.t160}")`, backgroundSize: 'cover', backgroundPosition: 'center' } : undefined}>
            {src ? <img className="nd-img" src={src} alt={data.title} decoding="async" loading="lazy" />
                 : <div className="nd-img nd-ph" />}
            <span className="play-btn"><IcPlay size={18} /></span>
          </button>
          <button className="nd-exp" onClick={() => open({ src: src, title: data.title })} title="看大图"><IcExpand size={14} /></button>
        </div>
      )}
      <div className="nd-ft"><span className="nd-name">{data.title}</span></div>
    </div>
  );
}

const nodeTypes = { prompt: PromptNode, image: ImageNode, video: VideoNode };

/* ===== 数据 ===== */
const base = (f) => f.replace(/\.(png|jpe?g|svg)$/i, '');
const IMG = (id, x, y, title, file, tag, meta, orig) => ({
  id, type: 'image', position: { x, y },
  data: { title, t64: T0 + base(file) + '.svg', t160: T1 + base(file) + '.svg', t480: T4 + base(file) + '.svg',
          t1200: T12 + base(file) + '.svg', orig: orig ? M + orig : null, tag, meta },
});
const VID = (id, x, y, title, src, poster, meta, audio = false) => ({
  id, type: 'video', position: { x, y },
  data: { title, src: M + src, t64: T0 + base(poster) + '.svg', t160: T1 + base(poster) + '.svg', t480: T4 + base(poster) + '.svg',
          t1200: T12 + base(poster) + '.svg', meta, audio },
});
const P = (id, x, y, title, text) => ({ id, type: 'prompt', position: { x, y }, data: { title, text } });

const realNodes = [];
const EDGE_GRAY = '#4A5265';
const realEdges = [];
const POSTERS = Array.from({ length: 10 }, (_, n) => ['sample' + n + '.svg', '几何示例 ' + (n + 1)]);

function stressNodes(n) {
  const out = [];
  const COLS = Math.max(6, Math.ceil(Math.sqrt(n) * 1.9)), GX = 344, GY = 272;
  for (let k = 0; k < n; k++) {
    const [file, name] = POSTERS[k % POSTERS.length];
    const b = base(file);
    out.push({
      id: 's' + k, type: 'image',
      position: { x: (k % COLS) * GX, y: Math.floor(k / COLS) * GY },
      data: { title: name + ' #' + (k + 1), t64: T0 + b + '.svg', t160: T1 + b + '.svg', t480: T4 + b + '.svg',
              t1200: T12 + b + '.svg', orig: T12 + b + '.svg', tag: '压测', meta: '1536×864' },
    });
  }
  return out;
}

/* ===== 大图查看 ===== */
function Lightbox({ item, onClose }) {
  useEffect(() => {
    const k = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  if (!item) return null;
  return (
    <div className="lb" onClick={onClose}>
      <button className="lb-x" onClick={onClose} aria-label="关闭"><IcClose size={18} /></button>
      <img className="lb-img" src={item.src} alt={item.title} onClick={(e) => e.stopPropagation()} />
      <div className="lb-name">{item.title}<em>点任意处或按 Esc 关闭</em></div>
    </div>
  );
}

/* ===== 底部状态胶囊：自己订阅自己的计时器，不牵动主界面 ===== */
function StatusPill({ stat, total, debug }) {
  const [fps, setFps] = useState(0);
  const [dom, setDom] = useState(0);
  useEffect(() => {
    if (!debug) return;
    let frames = 0, last = performance.now(), raf = 0;
    const tick = (t) => {
      frames += 1;
      if (t - last >= 500) {
        setFps(Math.round((frames * 1000) / (t - last)));
        setDom(document.querySelectorAll('.react-flow__node').length);
        frames = 0; last = t;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [debug]);
  return (
    <div className="hud">
      <span><i className="dot dot-p" />提示词 <b>{stat.prompt}</b></span>
      <i className="div" />
      <span><i className="dot dot-i" />图片 <b>{stat.image}</b></span>
      <i className="div" />
      <span><i className="dot dot-v" />视频 <b>{stat.video}</b></span>
      {debug && <><i className="div" />
        <span>渲染 <b>{dom}</b>/<b>{total}</b></span>
        <i className="div" />
        <span>帧率 <b>{fps}</b></span></>}
    </div>
  );
}

/* ===== 底部缩放条：只让它自己随缩放重渲染 ===== */
function ZoomBar({ onFit }) {
  const zoom = useStore((s) => s.transform[2]);
  const rf = useReactFlow();
  const [full, setFull] = useState(false);
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  };
  useEffect(() => {
    const h = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', h);
    return () => document.removeEventListener('fullscreenchange', h);
  }, []);
  return (
    <div className="zoom">
      <button onClick={() => rf.zoomOut({ duration: 120 })} title="缩小"><IcMinus /></button>
      <button className="pct" style={{ border: 0, background: 'transparent', cursor: 'pointer' }}
        onClick={() => rf.zoomTo(1, { duration: 160 })} title="回到 100%">{Math.round(zoom * 100)}%</button>
      <button onClick={() => rf.zoomIn({ duration: 120 })} title="放大"><IcPlus /></button>
      <i className="div" />
      <button onClick={onFit} title="适应全部"><IcFit /></button>
      <button onClick={toggleFull} title={full ? '退出全屏' : '全屏'}><IcFull /></button>
    </div>
  );
}

/* ===== 外壳 ===== */
function Shell() {
  const qs = new URLSearchParams(window.location.search);
  const bootLevel = (() => {
    const n = Number(qs.get('stress') || 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  })();
  const [level, setLevel] = useState(bootLevel);
  const [nodes, setNodes, onNodesChange] = useNodesState(bootLevel ? stressNodes(bootLevel) : []);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const { fitView, screenToFlowPosition, setViewport, getViewport } = useReactFlow();
  const storeApi = useStoreApi();
  const stageRef = useRef(null);
  const fileRef = useRef(null);
  const seq = useRef(0);
  const [lightbox, setLightbox] = useState(null);
  const [menu, setMenu] = useState(false);
  const [debug, setDebug] = useState(qs.get('debug') === '1');

  const noLod = qs.has('nolod');

  /* 清晰度分级：不在 Shell 里订阅 zoom（否则每一帧都要重渲染整个界面），
     改用 store 订阅 + 防抖，只在等级真正变化时才 setState */
  const zoomRef = useRef(1);
  const tierTimer = useRef(null);
  const [tier, setTier] = useState(1);
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    const unsub = storeApi.subscribe((s) => {
      zoomRef.current = s.transform[2];
      clearTimeout(tierTimer.current);
      tierTimer.current = setTimeout(() => {
        const z = zoomRef.current;
        const next = noLod ? 1 : (z >= 0.8 ? 2 : z >= 0.45 ? 1 : 0);
        setTier((t) => (t === next ? t : next));
      }, 220);
    });
    return () => { unsub(); clearTimeout(tierTimer.current); };
  }, [storeApi, noLod]);

  useEffect(() => { window.__setView = setViewport; window.__fit = fitView; }, [setViewport, fitView]);

  /* ===== 视口裁剪（tldraw 式：节点常驻 DOM，只切 display） =====
     为什么不用「过滤 nodes 数组」：每改一次数组，React Flow 就要对全部 N 个节点
     重做一次 diff，2000 张时松手后要反复挂载/卸载（实测 DOM 增删 3537~3921、
     最慢一帧 183ms）。常驻 + display 切换不改数组，松手后增删 = 0
     （A/B 见 画布优化调研-20261106/ab2-*.md，6/6 行通过）。 */
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const edgesRef = useRef(edges);
  edgesRef.current = edges;
  /* cullStat 只被写、从未被读：原来每次松手 setState 会白触发一次 Shell 重渲染，改成 ref 承接。 */
  const cullStatRef = useRef(null);
  const { register, stats: cullStats } = useCull({ nodesRef, edgesRef, getViewport, edges: 'keep',
    onStats: (s) => { cullStatRef.current = s; } });
  /* 验收探针：bench.mjs:359 判据是 typeof === 'function'，所以挂函数。
     契约更正：stats() 恒返回对象（空表为 {0,0,0,0}），不会返回 null。
     性能红线：只允许在就绪轮询与 stop() 之后读，绝不能放进 rAF 帧循环或手势窗口。 */
  useEffect(() => {
    window.__cullStats = cullStats;
    return () => { try { delete window.__cullStats; } catch { window.__cullStats = undefined; } };
  }, [cullStats]);

  const applyLevel = useCallback((n) => {
    if (n === 0) { window.location.search = ''; return; }
    setLevel(n);
    setNodes(n === 0 ? realNodes : stressNodes(n));
    setEdges(n === 0 ? realEdges : []);
    setTier(n === 0 ? 1 : 0);
    setTimeout(() => fitView({ padding: 0.03, maxZoom: 1, duration: 300 }), 60);
  }, [setNodes, setEdges, fitView]);

  const onConnect = useCallback(
    (c) => setEdges((eds) => addEdge({
      ...c, type: 'smoothstep', label: '新连线',
      labelStyle: { fill: '#A2A9B6', fontFamily: 'var(--cx-mono)', fontSize: 11 },
      labelBgStyle: { fill: '#14161A', stroke: 'rgba(255,255,255,.08)', strokeWidth: 1 },
      labelBgPadding: [5, 2],
      labelBgBorderRadius: 4,
      style: { stroke: EDGE_GRAY, strokeWidth: 1.5 },
      markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: EDGE_GRAY },
    }, eds)),
    [setEdges],
  );

  const onPick = useCallback(async (ev) => {
    const files = Array.from(ev.target.files || []);
    const at = screenToFlowPosition({ x: window.innerWidth / 2 - 160, y: 140 });
    try {
      // 顺序生成缩略图，避免多段视频同时解码挤占画布手势。
      for (const [k, file] of files.entries()) {
        const asset = await localAsset(file); await putAsset(asset);
        const item = { id: 'asset_' + asset.id, type: asset.video ? 'video' : 'image',
          position: { x: at.x + (k % 3) * 344, y: at.y + Math.floor(k / 3) * 272 },
          data: { title: file.name, asset_id: asset.id, tag: '本地素材', meta: asset.width + '×' + asset.height } };
        const [shown] = await displayNodes([item]);
        setNodes(ns => ns.concat(shown));
      }
    } catch (e) { setNotice(e.message); }
  }, [screenToFlowPosition, setNodes]);

  const delSel = useCallback(() => {
    setNodes((ns) => ns.filter((n) => !n.selected));
    const removed = new Set(nodesRef.current.filter(n => n.selected).map(n => n.id));
    setEdges((es) => es.filter((e) => !e.selected && !removed.has(e.source) && !removed.has(e.target)));
    setMenu(false);
  }, [setNodes, setEdges]);

  const stat = useMemo(() => {
    const n = nodes.reduce((a, x) => { a[x.type] = (a[x.type] || 0) + 1; return a; }, {});
    return { prompt: n.prompt || 0, image: n.image || 0, video: n.video || 0 };
  }, [nodes]);

  /* 手势期间不再整体降档：节点常驻后，降档 = 2000 次结构/图片切换，反而更贵 */
  const effTier = tier;
  const [notice, setNotice] = useState('');
  const local = useProjects({ nodesRef, edgesRef, setNodes, setEdges, nodes, edges, moving, disabled: level > 0 });
  const createProject = async () => {
    const name = window.prompt('新项目名称', '新的创作项目');
    if (name?.trim()) try { await local.create(name.trim()); } catch (e) { setNotice(e.message); }
  };
  const exportProject = async () => {
    try {
      const project = { ...local.project, nodes: nodesRef.current, edges: edgesRef.current };
      const blob = new Blob([JSON.stringify(project, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob), a = document.createElement('a');
      a.href = url; a.download = 'project-' + project.id + '.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { setNotice(e.message); }
  };


  return (
    <div className="wrap">
      <header className="bar">
        <div className="bar-l">
          <span className="logo"><IcGrid size={16} /></span>
          <div className="brand"><b>AI 无线发布</b></div>
        </div>
        <div className="bar-c">
          <span className="doc">{level ? `性能测试 · ${level} 张` : (local.project?.name || '我的创作项目')}</span>
          <i className="sep" />
          <span className="save" role="status"><i />{level ? '性能测试，不保存' : local.status}</span>
        </div>
        <div className="bar-r">
          <button className="btn primary" onClick={() => fileRef.current?.click()}><IcPlus size={14} />添加素材</button>
          <button className="btn" onClick={() => fitView({ padding: 0.12, duration: 420 })}>适应全部</button>
          <div className="menu-wrap">
            <button className="btn ico" onClick={() => setMenu((v) => !v)} title="更多"><IcMore /></button>
            {menu && (
              <>
                <div style={{ position: 'fixed', inset: 0, zIndex: 19 }} onClick={() => setMenu(false)} />
                <div className="menu">
                  <button onClick={createProject}>新建项目</button>
                  {local.projects.map(p => <button key={p.id} onClick={() => { local.run({ protocol: 1, id: crypto.randomUUID(), type: 'project.open', project_id: p.id }).catch(e => setNotice(e.message)); setMenu(false); }}>{p.name}</button>)}
                  <button onClick={() => { local.run({ protocol: 1, id: crypto.randomUUID(), type: 'graph.arrange', project_id: local.project.id, layout: 'storyboard' }).then(() => fitView({ padding: 0.12, duration: 200 })).catch(e => setNotice(e.message)); setMenu(false); }}>一键整理连线</button>
                  <button onClick={exportProject}>导出当前图谱</button>
                  <button onClick={() => { if (window.confirm('重新读取已保存项目？未保存的界面编辑请先导出当前图谱。')) local.reload().catch(e => setNotice(e.message)); setMenu(false); }}>重新载入已保存项目</button>
                  <button onClick={delSel}>删除选中</button>
                  <div className="mdiv" />
                  <div className="mhd">视图</div>
                  {[0, 500, 1000, 2000].map((n) => (
                    <button key={n} onClick={() => { applyLevel(n); setMenu(false); }}>
                      {n === 0 ? '回到我的项目' : `${n} 张压测`}
                      {level === n && <span className="chk">✓</span>}
                    </button>
                  ))}
                  <div className="mdiv" />
                  <button onClick={() => setDebug((v) => !v)}>
                    性能监控{debug && <span className="chk">✓</span>}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <div className="body">
        <aside className="rail">
          <button className="on" title="选择"><IcCursor size={20} /></button>
          <button onClick={() => fileRef.current?.click()} title="添加素材"><IcPlus size={20} /></button>
          <button title="连线"><IcLink size={20} /></button>
          <i className="div" />
          <button title="新建项目" onClick={createProject}><IcGrid size={20} /></button>
          <button onClick={() => fitView({ padding: 0.12, duration: 420 })} title="适应全部"><IcFit size={20} /></button>
        </aside>

        <div className="stage" ref={stageRef}>
          <OpenCtx.Provider value={setLightbox}>
          <CullCtx.Provider value={register}>
          <TierCtx.Provider value={effTier}>
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            nodeTypes={nodeTypes}
            onlyRenderVisibleElements={false}
            onMoveStart={() => setMoving(true)}
            onMoveEnd={() => setMoving(false)}
            fitView fitViewOptions={{ padding: 0.03, maxZoom: 1 }}
            minZoom={0.03} maxZoom={4}
            proOptions={{ hideAttribution: true }}
            defaultEdgeOptions={{ type: 'smoothstep' }}
          >
            <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="rgba(255,255,255,.055)" />
          </ReactFlow>
          </TierCtx.Provider>
          </CullCtx.Provider>
          </OpenCtx.Provider>

          {/* 低缩放档总览层：zoom < 0.22 时由它接管画面，并把 .react-flow__nodes 整层隐藏；
              0.28 以上交回 DOM。加 ?overview=0 可整层关掉做 A/B 对照。 */}
          {!OV.off && <OverviewLayer nodes={nodes} />}

          {nodes.length === 0 && (
            <div className="empty">
              <div className="box">
                <div className="ic"><IcEmpty size={40} /></div>
                <h2>还没有素材</h2>
                <p>把图片和视频拖进来就能开始整理。<br />视频会自动取封面，图片会自动生成分级缩略图。</p>
                <div className="row">
                  <button className="btn primary" onClick={() => fileRef.current?.click()}>添加素材</button>
                  <button className="btn" onClick={createProject}>新建项目</button>
                </div>
              </div>
            </div>
          )}

          <StatusPill stat={stat} total={nodes.length} debug={debug} />
          <ZoomBar onFit={() => fitView({ padding: 0.12, duration: 420 })} />
        </div>
      </div>

      <input ref={fileRef} type="file" accept="image/*,video/*,.svg,.gif" multiple hidden onChange={(e) => { onPick(e); e.target.value = ''; }} />
      {notice && <div className="local-notice" role="alert">{notice}<button onClick={() => setNotice('')} aria-label="关闭提示"><IcClose /></button></div>}
      <Lightbox item={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

export default function App() {
  return <ReactFlowProvider><Shell /></ReactFlowProvider>;
}
