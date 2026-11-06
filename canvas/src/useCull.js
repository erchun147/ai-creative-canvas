/**
 * useCull —— 视口裁剪（tldraw 式：DOM 常驻 + 只改 display）
 *
 * 独立画布裁剪设计：DOM 常驻，停手后只切换 display。
 *
 * 三条设计红线（照 tldraw packages/editor/src/lib/hooks/useShapeCulling.tsx 的思路，不搬代码）：
 *   1. 不改 nodes / edges 数组本身 —— React Flow 的 NodeRenderer 只订阅「id 列表」，
 *      列表不变它就一次都不 diff，也就没有重新挂载（xyflow NodeRenderer/index.tsx:60-61）。
 *   2. 只写 el.style.display —— 不 setState、不触发 React 提交（useShapeCulling.tsx:70）。
 *   3. 只写真正变了的（entry.culled 比对）—— 没变就跳过（useShapeCulling.tsx:68）。
 *
 * 和 tldraw 的两个差异（也写进了 culling-plan.md 的「没做到的事」）：
 *   - 恢复显示时还原「注册那一刻的 inline display」，不硬写 'block'。
 *     tldraw 的容器本来就是普通 div，可以硬写 block；我们的 .nd 卡片可能是 flex，
 *     硬写 block 会把布局改坏。
 *   - 裁剪集合用固定网格桶，不是 RBush。我们节点尺寸固定、位置稳定，网格桶够用且零依赖。
 */

import { useCallback, useEffect, useRef } from 'react';

const DEFAULT_BUCKET = 512;
const DEFAULT_NODE_W = 340;
const DEFAULT_NODE_H = 265;

function toNum(v, fb) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return fb;
}

/** 取节点尺寸：显式 width/height > measured > 兜底常量 */
function sizeOf(node, fb) {
  return {
    w: toNum(node.width ?? node.measured?.width ?? node.style?.width, fb.w),
    h: toNum(node.height ?? node.measured?.height ?? node.style?.height, fb.h),
  };
}

/**
 * @param {object} opts
 * @param {import('react').MutableRefObject<Array>} opts.nodesRef   节点数组的 ref（每次渲染后指向最新数组）
 * @param {() => {x:number,y:number,zoom:number}} opts.getViewport   与 React Flow 的 getViewport 同签名
 * @param {number} [opts.margin=1.8]   视口放大倍数（1.8 = 四周各留 40% 余量），与 App.jsx:280 同口径
 * @param {import('react').MutableRefObject<Array>} [opts.edgesRef]  边数组的 ref（edges='toggle' 时必填）
 * @param {'keep'|'toggle'} [opts.edges='keep']  边策略：keep=全留，toggle=也切
 * @param {'either'|'both'} [opts.edgeRule='either']  toggle 时的判据：
 *        either = 任一端被裁就切（与 App.jsx:340 现有视觉等价）；
 *        both   = 两端都被裁才切
 * @param {HTMLElement|(() => HTMLElement|null)} [opts.root]  画布容器，默认取 .react-flow
 * @param {number} [opts.idleMs=220]   停手多少毫秒后重算一次（与 App.jsx:248 的 220ms 对齐）
 * @param {'display'|'visibility'} [opts.hideWith='display']  怎么藏：
 *        display=彻底移出渲染树（最省，但 React Flow 量不到 handle，边可能画错）；
 *        visibility=保留布局只跳绘制（handle 仍能量到，边安全）
 * @param {boolean} [opts.auto=true]   false 则由外部自己调 recompute()
 * @param {(s:object)=>void} [opts.onStats]  每次重算后回报统计，可接到 HUD 上
 */
export function useCull(opts = {}) {
  const {
    nodesRef,
    getViewport,
    margin = 1.8,
    edgesRef = null,
    edges = 'keep',
    edgeRule = 'either',
    root = null,
    idleMs = 220,
    hideWith = 'display',
    auto = true,
    onStats = null,
  } = opts;

  const entriesRef = useRef(new Map()); // id -> { el, culled, base }
  const edgeEntriesRef = useRef(new Map()); // edgeId -> { el, hidden, base }
  const refCacheRef = useRef(new Map()); // id -> 稳定的 callback ref
  const visRef = useRef(null); // Set<string> | null（null = 还没算过，新注册的一律显示）

  const lastVpRef = useRef({ x: NaN, y: NaN, zoom: NaN });
  const lastCountRef = useRef(-1);
  const edgeDomStampRef = useRef(-1);
  const rafRef = useRef(0);
  const timerRef = useRef(null);
  const bootedRef = useRef(false);

  /* 会随渲染变化的入参用 ref 兜住，避免 effect 反复重建 */
  const getVpRef = useRef(getViewport);
  getVpRef.current = getViewport;
  const onStatsRef = useRef(onStats);
  onStatsRef.current = onStats;
  const cfgRef = useRef({ margin, edges, edgeRule, root, idleMs, hideWith });
  cfgRef.current = { margin, edges, edgeRule, root, idleMs, hideWith };

  /* 藏/显：display 走 style.display；visibility 走 style.visibility */
  const hideEl = (el, base) => {
    if (cfgRef.current.hideWith === 'visibility') el.style.visibility = 'hidden';
    else el.style.display = 'none';
  };
  const showEl = (el, base) => {
    if (cfgRef.current.hideWith === 'visibility') el.style.visibility = base.vis;
    else el.style.display = base.disp;
  };

  const containerOf = useCallback(() => {
    const r = cfgRef.current.root;
    if (typeof r === 'function') return r();
    if (r) return r;
    return document.querySelector('.react-flow');
  }, []);

  /* ---------- 节点容器注册 ----------
     用法：<div ref={register(id)} />；同一个 id 永远返回同一个函数，
     这样 React 不会每次渲染都「解绑再绑定」。 */
  const register = useCallback((id) => {
    const cache = refCacheRef.current;
    let fn = cache.get(id);
    if (fn) return fn;
    fn = (el) => {
      if (!el) {
        entriesRef.current.delete(id);
        return;
      }
      // 记下原始 inline 值，恢复时写回它们（不硬写 block，避免把 flex 卡片改坏）
      const base = { disp: el.style.display || '', vis: el.style.visibility || '' };
      const vis = visRef.current;
      const culled = vis ? !vis.has(id) : false;
      if (culled) hideEl(el, base);
      entriesRef.current.set(id, { el, culled, base });
    };
    cache.set(id, fn);
    return fn;
  }, []);

  /* ---------- 重算一次（停手后调用，也可以外部手动调） ---------- */
  const recompute = useCallback(() => {
    const t0 = performance.now();
    const nodes = (nodesRef && nodesRef.current) || [];
    const vp = (getVpRef.current && getVpRef.current()) || { x: 0, y: 0, zoom: 1 };
    const zoom = vp.zoom > 0 ? vp.zoom : 1;
    const box = containerOf();
    const rect = box ? box.getBoundingClientRect() : { width: window.innerWidth, height: window.innerHeight };
    const m = cfgRef.current.margin;
    const w = rect.width / zoom;
    const h = rect.height / zoom;
    const L = -vp.x / zoom - (w * (m - 1)) / 2;
    const T = -vp.y / zoom - (h * (m - 1)) / 2;
    const R = L + w + w * (m - 1);
    const B = T + h + h * (m - 1);

    /* 1) 建网格桶。节点按 AABB 塞进它覆盖到的每一个桶（340×265 的卡 + 512 的桶 = 最多 2×2 个） */
    const bucket = DEFAULT_BUCKET;
    const grid = new Map();
    const fb = { w: DEFAULT_NODE_W, h: DEFAULT_NODE_H };
    for (const n of nodes) {
      if (!n || n.id == null) continue;
      const x = toNum(n.position?.x, 0);
      const y = toNum(n.position?.y, 0);
      const { w: nw, h: nh } = sizeOf(n, fb);
      const c0 = Math.floor(x / bucket);
      const c1 = Math.floor((x + nw) / bucket);
      const r0 = Math.floor(y / bucket);
      const r1 = Math.floor((y + nh) / bucket);
      for (let cx = c0; cx <= c1; cx++) {
        for (let cy = r0; cy <= r1; cy++) {
          const k = cx + ':' + cy;
          let a = grid.get(k);
          if (!a) grid.set(k, (a = []));
          a.push(n);
        }
      }
    }

    /* 2) 只查询覆盖视口的那几个桶，桶内再做精确矩形判定 */
    const vis = new Set();
    const bx0 = Math.floor(L / bucket);
    const bx1 = Math.floor(R / bucket);
    const by0 = Math.floor(T / bucket);
    const by1 = Math.floor(B / bucket);
    for (let cx = bx0; cx <= bx1; cx++) {
      for (let cy = by0; cy <= by1; cy++) {
        const a = grid.get(cx + ':' + cy);
        if (!a) continue;
        for (const n of a) {
          const id = n.id;
          if (vis.has(id)) continue;
          const x = toNum(n.position?.x, 0);
          const y = toNum(n.position?.y, 0);
          const { w: nw, h: nh } = sizeOf(n, fb);
          if (x + nw > L && x < R && y + nh > T && y < B) vis.add(id);
        }
      }
    }
    visRef.current = vis;

    /* 3) 只写变了的；没变不写（tldraw useShapeCulling.tsx:68） */
    let shown = 0;
    let hidden = 0;
    for (const [id, entry] of entriesRef.current) {
      const culled = !vis.has(id);
      if (culled === entry.culled) {
        if (culled) hidden++;
        else shown++;
        continue;
      }
      if (culled) hideEl(entry.el, entry.base);
      else showEl(entry.el, entry.base);
      entry.culled = culled;
      if (culled) hidden++;
      else shown++;
    }

    /* 4) 边：keep = 什么都不做；toggle = 按端点判据切 */
    let hiddenEdges = 0;
    if (cfgRef.current.edges === 'toggle') {
      const ruleEither = cfgRef.current.edgeRule !== 'both';
      const list = (edgesRef && edgesRef.current) || [];

      /* DOM 侧：边没有 ref 可用，只能按 .react-flow__edge[data-id] 收；
         边数量变了就重建一次（O(E)，只在重算时发生） */
      if (edgeDomStampRef.current !== list.length || edgeEntriesRef.current.size === 0) {
        edgeDomStampRef.current = list.length;
        edgeEntriesRef.current.clear();
        for (const el of document.querySelectorAll('.react-flow__edge')) {
          const eid = el.getAttribute('data-id');
          if (eid != null) edgeEntriesRef.current.set(eid, { el, hidden: undefined, base: el.style.display || '' });
        }
      }

      const byId = new Map();
      for (const e of list) if (e && e.id != null) byId.set(String(e.id), e);

      for (const [eid, entry] of edgeEntriesRef.current) {
        const e = byId.get(eid);
        if (!e) continue;
        const sIn = vis.has(e.source);
        const tIn = vis.has(e.target);
        const culled = ruleEither ? !(sIn && tIn) : !sIn && !tIn;
        if (culled === entry.hidden) {
          if (culled) hiddenEdges++;
          continue;
        }
        entry.el.style.display = culled ? 'none' : entry.base;
        entry.hidden = culled;
        if (culled) hiddenEdges++;
      }
    }

    const out = {
      total: nodes.length,
      visible: shown,
      hidden,
      hiddenEdges,
      ms: +(performance.now() - t0).toFixed(2),
      zoom: +zoom.toFixed(4),
    };
    if (onStatsRef.current) onStatsRef.current(out);
    return out;
  }, [containerOf, nodesRef, edgesRef]);

  /* ---------- 自动驱动：每帧读一次视口，停手 idleMs 后重算一次 ---------- */
  useEffect(() => {
    if (!auto) return undefined;
    let alive = true;

    const schedule = (delay) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (alive) recompute();
      }, delay);
    };

    const loop = () => {
      if (!alive) return;
      const vp = (getVpRef.current && getVpRef.current()) || null;
      if (vp) {
        const moved =
          vp.x !== lastVpRef.current.x || vp.y !== lastVpRef.current.y || vp.zoom !== lastVpRef.current.zoom;
        if (moved) {
          lastVpRef.current = { x: vp.x, y: vp.y, zoom: vp.zoom };
          schedule(cfgRef.current.idleMs); // 手势中一直被重置 → 期间绝不重算
        }
        const cnt = ((nodesRef && nodesRef.current) || []).length;
        if (cnt !== lastCountRef.current) {
          lastCountRef.current = cnt;
          schedule(0); // 节点数量变了，立刻重算
        }
        if (!bootedRef.current) {
          bootedRef.current = true;
          schedule(30); // 首帧兜一次：等 React Flow 量完尺寸
        }
      }
      rafRef.current = requestAnimationFrame(loop);
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => {
      alive = false;
      cancelAnimationFrame(rafRef.current);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [auto, recompute, nodesRef]);

  const stats = useCallback(() => {
    let hidden = 0;
    for (const e of entriesRef.current.values()) if (e.culled) hidden++;
    let hiddenEdges = 0;
    for (const e of edgeEntriesRef.current.values()) if (e.hidden) hiddenEdges++;
    const total = entriesRef.current.size;
    return { total, hidden, visible: total - hidden, hiddenEdges };
  }, []);

  return { register, recompute, stats };
}

export default useCull;
