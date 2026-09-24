/* ui/render.js — Canvas 渲染（M1）
 * 设计依据：§29.1（高 DPI / 分层）、§29.3（叠加层）、§29.5（步数徽标）
 * M1 为单层直绘；后续接入 gridLayer 离屏缓存与 overlayLayer。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.G = root.G || {}; root.G.render = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const N = 15;
  /* ★ 坐标标注（与棋谱记谱一致 §9.1）：
   *   列标 A–O 在**上边**（x=0→A … x=14→O）；行标 15–1 在**左边**（y=0→15 … y=14→1）。
   *   与 engine/record.js 的 `coordText(x,y) = String.fromCharCode(65+x) + (15-y)` 完全一致，
   *   也与 engine/data/openings.js 的 `R('H8') → {x:7,y:7}`（天元）一致。
   *   ⇒ 棋盘上写 H8 的那一格，棋谱里就是 H8。
   *
   *   空间：原来 pad = 1·cell，四周仅剩半格余量，放不下带文字的标尺。
   *   改为「四边非对称」：左/上 pad 留够文字（LABEL_PAD_CELL 倍格），右/下保持小留白。
   *   ★ 为保证网格仍是**正方形**（否则圆形的棋子会被拉成椭圆），
   *     cell 必须按两个方向的可用空间取**较小值**：cell = min((s-2m)/N, (s-2m)/N)。
   *     这里左右各 m、上下各 m，故天然相等；写成 min() 是为了防止将来改成非对称时不报警。 */
  const PAD_RATIO = 0.16;            // 右/下最小留白（格）
  const LABEL_RATIO = 0.62;          // 左/上给文字的额外留白（格）
  const STAR = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];

  // 与 record.coordText 同一口径（此处独立实现，避免 render 依赖 record 模块）
  function colLabel(x) { return String.fromCharCode(65 + x); }   // 0→A
  function rowLabel(y) { return String(15 - y); }                // 0→15

  function roundRect(ctx, x, y, w, h, r) {
    if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function Renderer(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onResize = (opts && opts.onResize) || null;
    this.size = 0; this.cell = 0; this.pad = 0;
    this._lastCss = -1; this._lastDpr = -1;
    const self = this;
    this._resize();
    window.addEventListener('resize', function () { self._resize(); if (self.onResize) self.onResize(); });
    if (window.ResizeObserver) {
      new ResizeObserver(function () { self._resize(); if (self.onResize) self.onResize(); }).observe(canvas);
    }
  }

  Renderer.prototype._resize = function () {
    const css = this.canvas.clientWidth || 560;
    const dpr = window.devicePixelRatio || 1;
    // 仅尺寸真正变化时才重建位图——设置 canvas.width 会清空画布，
    // 避免 ResizeObserver 首次触发造成"白板"（§34 稳健性）。
    if (css === this._lastCss && dpr === this._lastDpr) return;
    this._lastCss = css; this._lastDpr = dpr;
    this.size = css;
    this.canvas.width = Math.round(css * dpr);
    this.canvas.height = Math.round(css * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    /* 网格尺寸闭式解。设左/上边距 M、右/下边距 m、格距 c，则：
     *   M + (N−1)·c + m = s
     *   M = m + LABEL_RATIO·c          （左/上多留 LABEL_RATIO 格给文字）
     *   ⇒ 2m + (N − 1 + LABEL_RATIO)·c = s，取 m = PAD_RATIO·c 代入：
     *   ⇒ c = s / (N − 1 + LABEL_RATIO + 2·PAD_RATIO)
     * 因为左右对等、上下对等，网格天然是正方形（棋子不会被拉成椭圆）。 */
    this.cell = css / (N - 1 + LABEL_RATIO + 2 * PAD_RATIO);
    if (!(this.cell > 0)) this.cell = 1;
    const m = this.cell * PAD_RATIO;
    this.padX = css - m - (N - 1) * this.cell;   // 左边距（= 右 m + LABEL_RATIO·c）
    this.padY = this.padX;                        // 对称
    this.pad = this.padX;                         // 兼容既有调用（posToPx 语义不变）
  };

  Renderer.prototype.posToPx = function (x, y) {
    return { px: this.padX + x * this.cell, py: this.padY + y * this.cell };
  };

  // 屏幕(CSS px) → 棋盘坐标；返回 null 表示未命中交点
  Renderer.prototype.pxToPos = function (px, py) {
    const x = Math.round((px - this.padX) / this.cell);
    const y = Math.round((py - this.padY) / this.cell);
    if (x < 0 || x >= N || y < 0 || y >= N) return null;
    const c = this.posToPx(x, y);
    if (Math.hypot(px - c.px, py - c.py) > this.cell * 0.55) return null;
    return { x, y };
  };

  Renderer.prototype._stone = function (x, y, v, scale, alpha) {
    const ctx = this.ctx, c = this.posToPx(x, y);
    const r = this.cell * 0.43 * (scale === undefined ? 1 : scale);
    if (r <= 0) return;
    if (alpha !== undefined && alpha < 1) ctx.globalAlpha = Math.max(0, alpha);
    const g = ctx.createRadialGradient(c.px - r * 0.35, c.py - r * 0.4, r * 0.15, c.px, c.py, r);
    if (v === 1) { g.addColorStop(0, '#737373'); g.addColorStop(1, '#0a0a0a'); }
    else { g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#d6d6d6'); }
    ctx.beginPath(); ctx.arc(c.px, c.py, r, 0, Math.PI * 2);
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = v === 1 ? '#000' : '#b8b8b8';
    ctx.lineWidth = 1; ctx.stroke();
    if (alpha !== undefined && alpha < 1) ctx.globalAlpha = 1;
  };

  // state: { board, lastMove:{x,y}|null, winLine:[{x,y}]|null, hover:{x,y}|null,
  //          showNo:boolean, order:Int16Array,
  //          forbidden:Set<idx>|null（M6 禁手点红叉 §29.3）, hoverForbid:boolean,
  //          heat:[{x,y,v}]|null（M8 §11 热力图）, candidates:[{x,y,norm,rank,type,win}]|null（M8 §10）,
  //          preview:{x,y}|null（侧栏列表 hover 预览）,
  //          ghost:{x,y,v,strong}|null（★ 触屏落子的"幽灵子"预览：v=1 黑 / 2 白，
  //                 strong=true 表示已进入待确认态（画得更实、带十字准星）；缺省不画）,
  //          anim:{ t:number(ms,单调递增), dropUser:number(ms 衰减起点), dropIdx:number|0,
  //                 pulse:boolean }|null（M10 §14 动画；缺省/降级时传 null ⇒ 静态绘制） }
  Renderer.prototype.draw = function (state) {
    const ctx = this.ctx, s = this.size, cell = this.cell;
    const padX = this.padX, padY = this.padY;
    ctx.clearRect(0, 0, s, s);

    // ★ M10 动画相位（§14）。anim 为 null 或 reduceMotion 时全部退化为静态 —— 绘制语义不变。
    const A = state.anim || null;
    const DROP_MS = A ? A.dropMs || 180 : 0;
    const t = A ? A.t : 0;
    const dropOn = !!(A && A.dropIdx && DROP_MS > 0);
    const dropP = dropOn ? Math.min(1, Math.max(0, (t - (A.dropUser || 0)) / DROP_MS)) : 1;

    // 棋盘底
    ctx.fillStyle = '#e8c48f'; roundRect(ctx, 0, 0, s, s, 10); ctx.fill();
    ctx.strokeStyle = '#c9a76e'; ctx.lineWidth = 1;
    roundRect(ctx, 0.5, 0.5, s - 1, s - 1, 10); ctx.stroke();

    // 网格
    ctx.strokeStyle = '#8a6a3b'; ctx.lineWidth = 1;
    const x0 = padX, y0 = padY, x1 = padX + (N - 1) * cell, y1 = padY + (N - 1) * cell;
    for (let i = 0; i < N; i++) {
      const px = x0 + i * cell, py = y0 + i * cell;
      ctx.beginPath(); ctx.moveTo(x0, py); ctx.lineTo(x1, py); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, y0); ctx.lineTo(px, y1); ctx.stroke();
    }

    // 星位
    ctx.fillStyle = '#6b4f2a';
    for (const [x, y] of STAR) {
      const c = this.posToPx(x, y);
      ctx.beginPath(); ctx.arc(c.px, c.py, cell * 0.075, 0, Math.PI * 2); ctx.fill();
    }

    // ★ 坐标标注（§9.1 与棋谱记谱同一口径）：列标 A–O 在上边、行标 15–1 在左边。
    //   用与棋盘木纹同色系的深棕，字号随格距缩放，不喧宾夺主。
    if (state.showCoord !== false) {
      const fs = Math.max(8, Math.round(cell * 0.40));
      const prevAlign = ctx.textAlign, prevBaseline = ctx.textBaseline;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '600 ' + fs + 'px system-ui, "Segoe UI", sans-serif';
      ctx.fillStyle = '#7a5c2e';
      // 列标：上边（y 方向在 padY 之上，取半格偏移）
      const ly = Math.max(fs * 0.62, padY - cell * 0.52);
      for (let x = 0; x < N; x++) ctx.fillText(colLabel(x), padX + x * cell, ly);
      // 行标：左边（x 方向在 padX 之左）
      const lx = Math.max(fs * 0.68, padX - cell * 0.52);
      for (let y = 0; y < N; y++) ctx.fillText(rowLabel(y), lx, padY + y * cell);
      ctx.textAlign = prevAlign; ctx.textBaseline = prevBaseline;
    }

    // ★ 热力图（§29.3 叠加层，位于网格之上、棋子之下）：价值渐变方块
    if (state.heat && state.heat.length) {
      for (const h of state.heat) {
        if (!h || h.x === undefined || h.y === undefined) continue;
        const c = this.posToPx(h.x, h.y), half = cell * 0.42;
        const v = Math.max(0, Math.min(1, h.v || 0));
        // 黑优→深、白优→浅（五子棋非金融场景，不用红绿 §29.3）
        ctx.fillStyle = v >= 0.5
          ? 'rgba(30,30,30,' + (0.06 + (v - 0.5) * 2 * 0.42).toFixed(3) + ')'
          : 'rgba(255,255,255,' + (0.10 + (0.5 - v) * 2 * 0.50).toFixed(3) + ')';
        ctx.fillRect(c.px - half, c.py - half, half * 2, half * 2);
      }
    }

    // 悬停预览
    if (state.hover && !state.board[state.hover.y * N + state.hover.x]) {
      const c = this.posToPx(state.hover.x, state.hover.y), r = cell * 0.43;
      ctx.beginPath(); ctx.arc(c.px, c.py, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.14)'; ctx.fill();
    }

    // 棋子（含步数徽标 §29.5；M10：最新一手做"落子淡入 + 缩放"）
    const board = state.board, order = state.order;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const v = board[y * N + x];
      if (!v) continue;
      const isDrop = dropOn && (y * N + x) === A.dropIdx;
      // 落子动画：ease-out 缩放入场（0.6 → 1.0），配合透明度
      let sc = 1, al = 1;
      if (isDrop && dropP < 1) {
        const e = 1 - (1 - dropP) * (1 - dropP);        // ease-out quad
        sc = 0.6 + 0.4 * e;
        al = e;
      }
      this._stone(x, y, v, sc, al);
      if (state.showNo && order) {
        const no = order[y * N + x];
        if (no) {
          const c = this.posToPx(x, y);
          const big = no >= 10;
          const fs = Math.round(cell * (big ? 0.40 : 0.48));
          if (isDrop && dropP < 1) ctx.globalAlpha = al;
          ctx.font = '600 ' + fs + 'px system-ui, "Segoe UI", sans-serif';
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = v === 1 ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.9)';
          ctx.strokeText(String(no), c.px, c.py + cell * 0.02);
          ctx.fillStyle = v === 1 ? '#f4f4f4' : '#2b2b2b';
          ctx.fillText(String(no), c.px, c.py + cell * 0.02);
          if (isDrop && dropP < 1) ctx.globalAlpha = 1;
        }
      }
    }

    // ★ 候选点（§10 / §29.3）：半径 ∝ 推荐度的半透明圆 + Top1 描边 + 序号
    //   M10：Top1 做"脉冲"（半径随正弦微幅呼吸）；anim 缺省时不脉冲。
    const pulse = !!(A && A.pulse);
    const pulseK = pulse ? 1 + 0.08 * Math.sin(t / 320) : 1;
    if (state.candidates && state.candidates.length) {
      for (const q of state.candidates) {
        if (!q || q.x === undefined) continue;
        if (board[q.y * N + q.x]) continue;                      // 已占点不画
        const c = this.posToPx(q.x, q.y);
        const tt = Math.max(0, Math.min(1, (q.norm === undefined ? 0 : q.norm) / 100));
        const rBase = cell * (0.16 + 0.24 * tt);
        const r = q.rank === 1 ? rBase * pulseK : rBase;
        ctx.beginPath(); ctx.arc(c.px, c.py, r, 0, Math.PI * 2);
        ctx.fillStyle = q.win ? 'rgba(230,74,25,0.34)' : 'rgba(21,101,192,0.28)';
        ctx.fill();
        ctx.strokeStyle = q.win ? 'rgba(230,74,25,0.75)' : 'rgba(21,101,192,0.65)';
        ctx.lineWidth = (q.rank === 1) ? 2.4 : 1.2;
        ctx.stroke();
        if (q.rank) {
          const fs = Math.round(cell * 0.30);
          ctx.font = '700 ' + fs + 'px system-ui, "Segoe UI", sans-serif';
          ctx.fillStyle = q.rank === 1 ? '#b3261e' : '#0d47a1';
          ctx.fillText(String(q.rank), c.px, c.py + cell * 0.02);
        }
      }
    }
    // 侧栏 hover 预览：高亮圈
    if (state.preview) {
      const c = this.posToPx(state.preview.x, state.preview.y);
      ctx.beginPath(); ctx.arc(c.px, c.py, cell * 0.46, 0, Math.PI * 2);
      ctx.strokeStyle = '#1565c0'; ctx.lineWidth = 2.5; ctx.stroke();
    }

    /* ★ 触屏落子的"幽灵子"（小屏模式）：点选后**先不落子**，先把"将要落在哪、什么颜色"
     *   画出来给用户看（这就是"确认后落子"的可见依据）。三种状态：
     *     · 手指按住时（未确认，strong=false）——淡一点，跟着手指走；
     *     · 松手进入待确认（strong=true）——更实 + 十字准星，配合底部确认条；
     *     · 拖动释放落子不经过这里（那是一次性动作，落子后直接变成真子）。
     *   ⚠ 画在候选点/预览圈之后：它是"用户当前的选择"，必须压在最上层可辨识。
     *   ⚠ setLineDash 必须显式复位 —— 否则后面画禁手红叉/最后一手标记会带上虚线。 */
    if (state.ghost && !board[state.ghost.y * N + state.ghost.x]) {
      const gh = state.ghost, c = this.posToPx(gh.x, gh.y), r = cell * 0.43;
      this._stone(gh.x, gh.y, gh.v === 2 ? 2 : 1, 1, gh.strong ? 0.66 : 0.5);
      if (gh.strong) {
        const k = cell * 0.16;
        ctx.strokeStyle = 'rgba(21,101,192,0.95)';
        ctx.lineWidth = Math.max(1.4, cell * 0.05);
        ctx.beginPath();
        ctx.moveTo(c.px - k * 1.5, c.py); ctx.lineTo(c.px - k * 0.55, c.py);
        ctx.moveTo(c.px + k * 0.55, c.py); ctx.lineTo(c.px + k * 1.5, c.py);
        ctx.moveTo(c.px, c.py - k * 1.5); ctx.lineTo(c.px, c.py - k * 0.55);
        ctx.moveTo(c.px, c.py + k * 0.55); ctx.lineTo(c.px, c.py + k * 1.5);
        ctx.stroke();
      }
      ctx.setLineDash([cell * 0.17, cell * 0.13]);
      ctx.beginPath(); ctx.arc(c.px, c.py, r * (gh.strong ? 1.18 : 1.30), 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(21,101,192,' + (gh.strong ? 0.95 : 0.75) + ')';
      ctx.lineWidth = Math.max(1.5, cell * 0.06);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // 禁手点：红叉（M6 / §29.3 叠加层）
    if (state.forbidden && state.forbidden.size) {
      const r = cell * 0.20;
      ctx.strokeStyle = '#d32f2f';
      ctx.lineWidth = Math.max(1.5, cell * 0.055);
      for (const i of state.forbidden) {
        const c = this.posToPx(i % N, (i / N) | 0);
        ctx.beginPath();
        ctx.moveTo(c.px - r, c.py - r); ctx.lineTo(c.px + r, c.py + r);
        ctx.moveTo(c.px + r, c.py - r); ctx.lineTo(c.px - r, c.py + r);
        ctx.stroke();
      }
    }
    // 悬停到禁手点：加粗红圈警示
    if (state.hoverForbid && state.hover) {
      const c = this.posToPx(state.hover.x, state.hover.y);
      ctx.beginPath(); ctx.arc(c.px, c.py, cell * 0.43, 0, Math.PI * 2);
      ctx.strokeStyle = '#d32f2f'; ctx.lineWidth = 3; ctx.stroke();
    }

    // 最后一手标记
    if (state.lastMove) {
      const c = this.posToPx(state.lastMove.x, state.lastMove.y);
      ctx.beginPath(); ctx.arc(c.px, c.py, cell * 0.12, 0, Math.PI * 2);
      ctx.fillStyle = '#e64a19'; ctx.fill();
    }

    // 胜负高亮（M10：五连闪烁 —— 描边宽度与亮度随正弦脉动；anim 缺省时静态）
    if (state.winLine) {
      const blink = !!(A && A.blink);
      const bk = blink ? 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(t / 260)) : 1;   // 0.5~1.0
      for (const p of state.winLine) {
        const c = this.posToPx(p.x, p.y);
        ctx.beginPath(); ctx.arc(c.px, c.py, cell * 0.45, 0, Math.PI * 2);
        ctx.strokeStyle = blink ? 'rgba(230,74,25,' + (0.45 + 0.55 * bk).toFixed(3) + ')' : '#e64a19';
        ctx.lineWidth = blink ? 2 + 2.5 * bk : 3; ctx.stroke();
      }
    }
  };

  /* ===== 坐标工具（与 record.coordText 同口径，供 UI / 测试复用） ===== */
  Renderer.prototype.coordAt = function (x, y) { return colLabel(x) + rowLabel(y); };

  return { Renderer, N, STAR, colLabel, rowLabel };
});
