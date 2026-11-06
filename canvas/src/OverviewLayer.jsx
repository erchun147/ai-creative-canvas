/* ============================================================================
 * OverviewLayer —— 低缩放档「单张位图总览」层（A/B 实验件）
 *
 * 归属：网站前端
 * 开启：URL 加 ?overview=1        （纯 canvas 渲染整块板）
 *       URL 加 ?overview=1&ovmax=0.06 （仅记录阈值，供观察，不改行为）
 * 关闭：不加参数 = 原 DOM 路线，行为与之前完全一致
 *
 * 设计依据：画布优化调研-20261106/网站前端.md §5
 *   压测实测（run1.json / run2.json，视口 1512×900，minZoom 0.05）：
 *     2000 张时整块板 29726px 宽，×0.05 = 1486px < 视口 1512px
 *     → 缩放到下限时 2000 张全部同时可见，视口裁剪数学上不可能生效
 *     → 松手后要一次性挂载 2000 个节点（实测 DOM 增删 3592 / 4126）
 *     → 真窗口实测松手后最慢帧 52ms（缩小）/ 200ms（放大）
 *   本层的作用：把那一档的 2000 个 DOM 节点换成 1 个 <canvas>，
 *   让「松手后 DOM 增删」和「松手后卡帧」同时归零。
 *
 * 约束（有意为之）：
 *   - 不改 App.jsx 的渲染/裁剪逻辑，只作为 ReactFlow 的一个子元素叠加
 *   - 不引用 canvas.css 的任何类名，只用它的 --cx-* 令牌值（UI设计师改令牌
 *     时本层自动跟随，不需要改代码）
 *   - 不新增依赖
 * ========================================================================== */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore, useReactFlow } from '@xyflow/react';

/* 卡片尺寸：与 canvas.css 的 .nd-media / .nd-mini 保持一致
   （2026-11-06 01:04 版 canvas.css:203 `.nd-media{width:320px}`、:341 `.nd-mini{width:320px;height:180px}`） */
export const NODE_W = 320;
export const NODE_H = 180;

/* 低于这个屏幕宽度就只做整像素 blit，不画圆角/描边/色条（在 0.05 档这些装饰不足 1px） */
const SIMPLE_BELOW = 24;
/* 装饰路径（圆角 + 描边 + 类型色条）默认关闭，加 ?ovdeco=1 打开。
   实测依据（2026-11-06，bench.mjs，视口 1512×900，软件渲染，2000 张）：
     带装饰  → 缩小方向手势期出现 1 帧 249.9ms
     纯 blit → 缩小/放大 手势期最慢 16.8ms，>50ms = 0
   原因：卡片尺寸大时每张要 save/clip/roundRect/restore/stroke，
   几百张可见时在软件光栅下直接顶到几十上百毫秒。
   打开装饰后必须重跑压测确认不复发。 */
const DECO = (() => {
  try { return new URLSearchParams(window.location.search).get('ovdeco') === '1'; } catch { return false; }
})();
/* 自算 fit 时与原 fitViewOptions 对齐：padding 3%，maxZoom 1，minZoom 0.05 */
const FIT_PADDING = 0.03;
const FIT_MAX = 1;
const FIT_MIN = 0.03;

/* ---------- 低缩放档接管阈值 ----------
   卡片 320px 宽：
     zoom=0.22 → 卡宽 70px（canvas 用 t64 原生 64x36 位图，缩放倍率 ≈1.1，肉眼无损）
     zoom=0.10 → 卡宽 32px
     zoom=0.05 → 卡宽 16px（全块板 1486px < 视口，裁剪本就无效）
   迟滞：低于 ENTER 交给 canvas，高于 EXIT 交回 DOM，中间保持不动，避免反复横跳。 */
const ENTER = 0.22;
const EXIT = 0.28;
/* 交回 DOM 必须等手势停下：放大过程中一旦穿过 EXIT 就恢复 .react-flow__nodes 的
   display，会在当帧触发 2000 张卡片的布局/绘制，实测 2000 张放大手势期 2 帧 116.6ms、
   1000 张 1 帧 66.7ms（bench marker DwalCgv0）。进入 canvas 方向不做延迟——
   那只是隐藏 1 个容器 + 画一张 canvas，成本与卡片数无关。 */
const EXIT_IDLE_MS = 220;
/* 隐藏 DOM 节点层的方式：display（默认）或 content-visibility（?ovhide=cv） */
const _spHide = (() => {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
})();
const HIDE_MODE = _spHide.get('ovhide') === 'cv' ? 'cv' : 'display';

/* ---------- URL 开关（App.jsx 只读这个常量，不解析参数） ---------- */
const _sp = (() => {
  try { return new URLSearchParams(window.location.search); } catch { return new URLSearchParams(); }
})();
export const OV = {
  on: (typeof window !== 'undefined' && window.__FORCE_OVERVIEW === true)
    || _sp.get('overview') === '1' || _sp.get('overview') === 'always',
  off: _sp.get('overview') === '0',
  raw: _sp.get('overview') || ((typeof window !== 'undefined' && window.__FORCE_OVERVIEW) ? 'forced' : ''),
  max: Number(_sp.get('ovmax') || 0.06),
};

/* ---------- 缩略图缓存：整站只有有限张图，一次解码反复画 ---------- */
const imgs = new Map();   // src -> { el, ok, err }
const subs = new Set();   // 图片加载完成后的重绘订阅者
function getImg(src) {
  let e = imgs.get(src);
  if (e) return e;
  e = { el: new Image(), ok: false, err: false };
  imgs.set(src, e);
  e.el.decoding = 'async';
  e.el.onload = () => { e.ok = true; subs.forEach((f) => f()); };
  e.el.onerror = () => { e.err = true; subs.forEach((f) => f()); };
  e.el.src = src;
  return e;
}

/* ---------- 预缩放位图缓存：key = src@宽x高，避免每帧对 2000 张做缩放 ---------- */
const scaled = new Map();
function scaledBitmap(src, imgEl, kw, kh) {
  const key = src + '@' + kw + 'x' + kh;
  let c = scaled.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = kw; c.height = kh;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = true;
  cx.imageSmoothingQuality = 'low';
  cx.drawImage(imgEl, 0, 0, kw, kh);
  scaled.set(key, c);
  if (scaled.size > 128) scaled.delete(scaled.keys().next().value);
  return c;
}

/* 按屏幕尺寸挑缩略图档位。
   DOM 路线下这一步要换 2000 个 <img> 的 src（实测松手后 42 次换图）；
   canvas 路线下最多只有 10 个素材 × 4 档 = 40 张位图，换档成本与卡片数无关。 */
function pickSrc(d, sw) {
  if (sw <= 64) return d.t64 || d.t160 || d.t480;
  if (sw <= 200) return d.t160 || d.t480 || d.t64;
  if (sw <= 640) return d.t480 || d.t1200 || d.t160;
  return d.t1200 || d.t480 || d.t160;
}

function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export default function OverviewLayer({ nodes = [], hidden = false, autoFit = false, enter = ENTER, exit = EXIT }) {
  const hostRef = useRef(null);
  const cvsRef = useRef(null);
  const tokRef = useRef(null);
  const fittedRef = useRef(false);
  const nodesLayerRef = useRef(null);
  /* 手势状态：zRef 记最近一次缩放值，lastMoveRef 记最近一次视口变动时刻，
     idleTick 是「停手 EXIT_IDLE_MS 之后」的重评估信号（只用于 交回 DOM 这一侧） */
  const zRef = useRef(1);
  const lastMoveRef = useRef(0);
  const idleTimerRef = useRef(0);
  const [idleTick, setIdleTick] = useState(0);
  const transform = useStore((s) => s.transform);
  const { setViewport } = useReactFlow();
  const [size, setSize] = useState({ w: 0, h: 0 });
  /* 低缩放档是否由 canvas 接管 */
  const [active, setActive] = useState(false);
  /* tick 必须进 draw 的依赖：图片 onload 只 bump 状态，若 draw 的 useCallback 依赖不变，
     重渲染不会重新排绘制，画布会永远停在没有图的那一帧（实测踩过）。 */
  const [tick, bump] = useState(0);

  /* ---------- 0. 档位判定 + 隐藏 DOM 节点层 ----------
     判定用带迟滞的双阈值（进入 < enter，退出 > exit），避免在阈值附近反复横跳。
     隐藏的是「整个 .react-flow__nodes 容器」而不是逐个节点：
       - 一次 display 改动，作用在 1 个元素上，不触发 2000 个子树的样式重算
       - bench.mjs 的 MutationObserver 只统计 childList（bench.mjs:144），
         属性变化不计入「DOM 增删」，所以这里不会污染那项指标
       - 用 useLayoutEffect：在浏览器绘制前生效，让 useCull 在同一次提交里
         恢复 display 的卡片来不及绘制，这才是真正消掉松手后那 1~2 帧的关键 */
  useLayoutEffect(() => {
    const z = Array.isArray(transform) ? transform[2] : transform?.zoom;
    if (!Number.isFinite(z)) return;
    zRef.current = z;
    lastMoveRef.current = performance.now();
    clearTimeout(idleTimerRef.current);
    idleTimerRef.current = setTimeout(() => setIdleTick((n) => n + 1), EXIT_IDLE_MS);
    setActive((prev) => {
      /* 已在 canvas：只有「放大穿过 EXIT」且手势已停才交回 DOM */
      if (prev) return z > exit ? performance.now() - lastMoveRef.current >= EXIT_IDLE_MS - 32 ? false : prev : prev;
      /* 已在 DOM：缩小穿过 ENTER 立刻接管，不必等停手 */
      return z < enter ? true : prev;
    });
  }, [transform, enter, exit]);

  /* 停手 EXIT_IDLE_MS 后补一次评估：把手势期间被压住的「交回 DOM」放出去 */
  useLayoutEffect(() => {
    if (!active) return;
    if (zRef.current > exit && performance.now() - lastMoveRef.current >= EXIT_IDLE_MS - 32) setActive(false);
  }, [idleTick, active, exit]);

  useEffect(() => () => clearTimeout(idleTimerRef.current), []);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    if (!nodesLayerRef.current) {
      const root = host.closest('.react-flow') || document;
      nodesLayerRef.current = root.querySelector('.react-flow__nodes');
    }
    const layer = nodesLayerRef.current;
    if (!layer) return;
    /* 隐藏方式可 A/B：display:none（默认）vs content-visibility:hidden（?ovhide=cv）。
       cv 只在「交回 DOM」那一侧可能更便宜，因为 display 从 none 恢复要重排 2000 棵子树。 */
    if (HIDE_MODE === 'cv') {
      const want = active ? 'hidden' : 'visible';
      if (layer.style.contentVisibility !== want) layer.style.contentVisibility = want;
    } else {
      const want = active ? 'none' : '';
      if (layer.style.display !== want) layer.style.display = want;
    }
  }, [active, size.w]);

  useEffect(() => () => {
    const layer = nodesLayerRef.current;
    if (!layer) return;
    layer.style.display = '';
    layer.style.contentVisibility = '';
  }, []);

  /* ---------- 1. 自己算 fit 视口 ----------
     因为 overview 模式下 <ReactFlow nodes={[]}>，它自带的 fitView 没有参照物，
     默认视口会停在 zoom=1。这里按节点包围盒算一次，与原 fitViewOptions 对齐。 */
  useEffect(() => {
    /* 只有在「应用把 nodes 传成空数组」的沙盘场景才需要自己算 fit；
       正式应用里 nodes 照常交给 React Flow，fitView 由它自己做，这里不插手。 */
    if (!autoFit || hidden || !nodes.length) return;
    const el = hostRef.current;
    const W = el?.clientWidth || window.innerWidth;
    const H = el?.clientHeight || Math.max(400, window.innerHeight - 60);
    if (!W || !H) return;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const n of nodes) {
      const x = n.position.x, y = n.position.y;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x + NODE_W > maxX) maxX = x + NODE_W;
      if (y + NODE_H > maxY) maxY = y + NODE_H;
    }
    const bw = Math.max(1, maxX - minX), bh = Math.max(1, maxY - minY);
    let z = Math.min(W / bw, H / bh) * (1 - FIT_PADDING);
    z = Math.min(FIT_MAX, Math.max(FIT_MIN, z));
    fittedRef.current = true;
    setViewport({
      x: (W - bw * z) / 2 - minX * z,
      y: (H - bh * z) / 2 - minY * z,
      zoom: z,
    });
  }, [nodes, setViewport, hidden, autoFit]);

  /* ---------- 2. 容器尺寸 ---------- */
  useEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ---------- 3. 令牌值：只读 canvas.css 的 --cx-*，不写死颜色 ---------- */
  useEffect(() => {
    const el = hostRef.current;
    if (!el || !size.w) return;
    const cs = getComputedStyle(el);
    const g = (k, d) => (cs.getPropertyValue(k) || d).trim();
    tokRef.current = {
      surface3: g('--cx-surface-3', '#1F2329'),
      lineSoft: g('--cx-line-soft', 'rgba(255,255,255,.05)'),
      r4: parseFloat(g('--cx-r-4', '12')) || 12,
      tImage: g('--cx-t-image', '#4C8DFF'),
      tVideo: g('--cx-t-video', '#2DD4BF'),
    };
    bump((v) => v + 1);
  }, [size.w, size.h]);

  /* ---------- 4. 图片到位后重绘 ---------- */
  useEffect(() => {
    const f = () => bump((v) => v + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);

  /* ---------- 5. 绘制 ---------- */
  const draw = useCallback(() => {
    const host = hostRef.current;
    const cvs = cvsRef.current;
    if (!host || !cvs || hidden) return;
    const w = size.w, h = size.h;
    if (!w || !h) return;
    /* 非接管档：清空画布，把画面完全交回 DOM 节点层 */
    if (!active) {
      const c0 = cvs.getContext('2d');
      c0.setTransform(1, 0, 0, 1, 0, 0);
      c0.clearRect(0, 0, cvs.width, cvs.height);
      if (typeof window !== 'undefined') {
        window.__ov = { mode: 'dom', active: false, cards: nodes.length, drawn: 0, cover: 0, ready: true };
        window.__ovReady = true;
      }
      return;
    }

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pw = Math.round(w * dpr), ph = Math.round(h * dpr);
    if (cvs.width !== pw || cvs.height !== ph) { cvs.width = pw; cvs.height = ph; }

    const ctx = cvs.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'low';

    const tok = tokRef.current || { surface3: '#1F2329', lineSoft: 'rgba(255,255,255,.05)', r4: 12, tImage: '#4C8DFF', tVideo: '#2DD4BF' };
    /* 注意：@xyflow/react 的 transform 是数组 [x, y, zoom]，不是对象。
       早先用对象解构拿到 3 个 undefined，画布全空却仍报 drawn=2000 —— 见下方自检。 */
    const [tx, ty, zoom] = Array.isArray(transform) ? transform : [transform?.x, transform?.y, transform?.zoom];
    if (!Number.isFinite(zoom) || !Number.isFinite(tx) || !Number.isFinite(ty)) {
      if (typeof window !== 'undefined') {
        window.__ov = { mode: 'canvas', error: 'BAD_TRANSFORM', transform: String(transform), drawn: 0 };
      }
      return;
    }
    const sw = NODE_W * zoom, sh = NODE_H * zoom;
    const simple = !DECO || sw < SIMPLE_BELOW;   // 默认整像素 blit 快路径；?ovdeco=1 才走装饰路径
    const kw = Math.max(1, Math.round(sw)), kh = Math.max(1, Math.round(sh));
    const radius = simple ? 0 : Math.min(tok.r4 * zoom, kw / 2, kh / 2);

    let drawn = 0, loaded = 0, pending = 0;
    /* 视口覆盖度：所有画到屏幕上的卡片矩形与视口求交后的面积和 / 视口面积。
       给压测当「画面真的被填满」的证据，防止空画布拿到零增删零超帧的假通过。 */
    let cov = 0;
    const t0 = performance.now();

    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const sx = n.position.x * zoom + tx;
      const sy = n.position.y * zoom + ty;
      if (simple) {
        // 快路径：整数坐标 + 整数尺寸 + 预缩放位图，纯 blit，无缩放无路径
        const bx = Math.round(sx), by = Math.round(sy);
        if (bx + kw < 0 || by + kh < 0 || bx > w || by > h) continue;
        cov += Math.max(0, Math.min(bx + kw, w) - Math.max(bx, 0)) * Math.max(0, Math.min(by + kh, h) - Math.max(by, 0));
        const d = n.data || {};
        const src = pickSrc(d, sw);
        const e = src ? getImg(src) : null;
        drawn++;
        if (e && e.ok) {
          loaded++;
          ctx.drawImage(scaledBitmap(src, e.el, kw, kh), bx, by);
        } else {
          pending++;
          ctx.fillStyle = tok.surface3;
          ctx.fillRect(bx, by, kw, kh);
        }
      } else {
        if (sx + sw < 0 || sy + sh < 0 || sx > w || sy > h) continue;
        cov += Math.max(0, Math.min(sx + sw, w) - Math.max(sx, 0)) * Math.max(0, Math.min(sy + sh, h) - Math.max(sy, 0));
        const d = n.data || {};
        const src = pickSrc(d, sw);
        const e = src ? getImg(src) : null;
        drawn++;
        // 底色
        ctx.fillStyle = tok.surface3;
        roundRectPath(ctx, sx, sy, sw, sh, radius);
        ctx.fill();
        // 图
        if (e && e.ok) {
          loaded++;
          ctx.save();
          roundRectPath(ctx, sx, sy, sw, sh, radius);
          ctx.clip();
          ctx.drawImage(e.el, sx, sy, sw, sh);
          ctx.restore();
        } else {
          pending++;
        }
        // 描边 + 左侧类型色条
        if (kw >= 12) {
          ctx.save();
          roundRectPath(ctx, sx + 0.5, sy + 0.5, sw - 1, sh - 1, radius);
          ctx.strokeStyle = tok.lineSoft;
          ctx.lineWidth = 1;
          ctx.stroke();
          ctx.restore();
          ctx.fillStyle = (n.type === 'video' || d.video) ? tok.tVideo : tok.tImage;
          ctx.fillRect(sx, sy, Math.max(1, 2 * zoom), sh);
        }
      }
    }

    const ms = performance.now() - t0;
    const cover = Math.min(1, Math.round((cov / (w * h)) * 1000) / 1000);
    /* 暴露给压测脚本：证明这一帧真的画了 cards 张，而不是空转 */
    if (typeof window !== 'undefined') {
      window.__ov = {
        mode: 'canvas',
        active: true,
        cards: nodes.length,
        drawn, loaded, pending,
        cover,
        lastDrawMs: Math.round(ms * 100) / 100,
        blit: `${kw}x${kh}`,
        simplePath: simple,
        zoom: Math.round(zoom * 10000) / 10000,
        bitmaps: scaled.size,
        images: imgs.size,
        /* 自检：画布真的把图 blit 上去了才算这一帧有效。
           空画布也能"零卡顿""DOM 增删 0"，那种通过是假的。 */
        ok: drawn > 0 && loaded > 0 && scaled.size > 0,
        blank: drawn > 0 && loaded === 0,
        /* 稳定就绪信号（给 bench 用，见 overview-plan.md §8）：
           ready = 本帧真的把图 blit 上屏了，且画面被卡片覆盖 ≥ 60%；
           paintSeq 单调递增，脚本连读两次相同即认为画面已稳定。 */
        ready: drawn > 0 && loaded > 0 && cover >= 0.6,
        paintSeq: (window.__ov && window.__ov.paintSeq ? window.__ov.paintSeq : 0) + 1,
      };
      if (window.__ov.ready) window.__ovReady = true;
      window.__ovFrames = (window.__ovFrames || 0) + 1;
      if (loaded === 0 && drawn > 0) {
        window.__ovBlankFrames = (window.__ovBlankFrames || 0) + 1;
      }
    }
  }, [nodes, transform, size.w, size.h, hidden, tick, active]);

  /* rAF 合并：一帧内多次 transform 变化只画一次 */
  const rafRef = useRef(0);
  useEffect(() => {
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(rafRef.current);
  }, [draw]);

  /* 首次挂载时把帧计数归零，便于压测从 0 起算 */
  useEffect(() => {
    if (typeof window !== 'undefined') { window.__ovFrames = 0; window.__ovReady = false; window.__ov = { mode: 'idle', ready: false }; }
  }, []);

  const hostStyle = useMemo(() => ({
    position: 'absolute',
    left: 0,
    top: 0,
    width: '100%',
    height: '100%',
    zIndex: 3,
    pointerEvents: 'none',   // 滚轮/拖拽全部透给下面的 React Flow pane
    contain: 'strict',
  }), []);

  return (
    <div ref={hostRef} style={hostStyle} data-ov="1" aria-hidden="true">
      <canvas
        ref={cvsRef}
        data-ov-canvas="1"
        style={{ display: 'block', width: '100%', height: '100%' }}
      />
    </div>
  );
}
