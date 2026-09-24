/* engine/rules.js — 胜负裁决与规则插件（§7 / §8 / §26）
 *
 * 两条铁律（设计 §4.6 / §7.3）：
 *  ① **AI 决策不调用本模块**——禁手由 `Renju-黑` 评分表的 −1e9 惩罚表达（patterns.levelAt 的 mode>0）。
 *     本模块只用于 **终局裁决 / 复盘校验 / 禁手点标红**。
 *  ② 裁决必须与评分**同一口径**：两者都基于 patterns 的严格禁手判定（forbiddenCore），
 *     故不会出现"AI 以为合法、裁决判负"的不一致。
 *
 * 规则差异：
 *  · freestyle（无禁手）：任一方 maxRun ≥ 5 即胜（长连算胜）。
 *  · renju（RIF）：白棋 ≥5 胜；黑棋**恰好五连**（某方向段长 == 5）胜；
 *      黑棋长连（≥6）/ 四四 / 三三为禁手负；
 *      黑一手**同时**成「恰好五连」与任一禁手 → 五连优先，判黑胜（五三三 / 五四四 / 五长连）。
 *      `overlineMode='strict'` 时改为"长连一律判负"（含五长连）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./core.js'), require('./patterns.js'));
  else { root.G = root.G || {}; root.G.rules = factory(root.G.core, root.G.patterns); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, PAT) {
  'use strict';
  const { N, EMPTY, BLACK, WHITE, DIRS, idxOf, inBoard } = core;

  const WIN = 'win', LOSE = 'lose', NONE = 'none';
  const DEFAULT_OVERLINE = 'rif';

  /* ---------- 连续段 ---------- */
  // 过 (x,y) 在 (dx,dy) 方向的连续同色段长度（含该点）
  function runLength(board, x, y, player, dx, dy) {
    let len = 1;
    for (let s = 1; ; s++) {
      const nx = x + dx * s, ny = y + dy * s;
      if (!inBoard(nx, ny) || board[idxOf(nx, ny)] !== player) break;
      len++;
    }
    for (let s = 1; ; s++) {
      const nx = x - dx * s, ny = y - dy * s;
      if (!inBoard(nx, ny) || board[idxOf(nx, ny)] !== player) break;
      len++;
    }
    return len;
  }

  function maxRun(board, x, y, player) {
    let m = 0;
    for (let d = 0; d < 4; d++) {
      const l = runLength(board, x, y, player, DIRS[d][0], DIRS[d][1]);
      if (l > m) m = l;
    }
    return m;
  }

  // 四方向中存在"恰好五连"的方向数（★ 不是 >=5：纯长连不算成五，§26.2）
  function countExactFives(board, x, y, player) {
    let n = 0;
    for (let d = 0; d < 4; d++) if (runLength(board, x, y, player, DIRS[d][0], DIRS[d][1]) === 5) n++;
    return n;
  }

  /* ---------- 胜负判定 ---------- */
  // 规则感知的"成五"：renju 黑棋必须**恰好**五连（§26.2）
  // ★ 判据是 countExactFives > 0 而非 maxRun === 5：
  //   "五长连"（一向恰好五 + 另一向六连）maxRun = 6，但**五连优先**应判胜（§31 #6b）。
  function isWin(board, x, y, player, rule, overlineMode) {
    const m = maxRun(board, x, y, player);
    if (rule !== 'renju' || player !== BLACK) return m >= 5;
    if (overlineMode === 'strict') return m < 6 && countExactFives(board, x, y, player) > 0;
    return countExactFives(board, x, y, player) > 0;
  }

  // 落子后裁决：'win' | 'lose' | 'none'（★ 落子后立即调用，§4.7 时机 C）
  function judge(board, x, y, player, rule, overlineMode) {
    if (rule !== 'renju' || player === WHITE) return maxRun(board, x, y, player) >= 5 ? WIN : NONE;
    const om = overlineMode || DEFAULT_OVERLINE;
    // strict：长连一律负（含"五长连"，§26.2）
    if (om === 'strict' && maxRun(board, x, y, BLACK) >= 6) return LOSE;
    // 恰好五连优先：一切禁手失效（五三三 / 五四四 / 五长连）
    if (countExactFives(board, x, y, BLACK) > 0) return WIN;
    // ★ 不能按 maxRun 提前剪枝：三三/四四的 maxRun 可能只有 2（如"BB.B"型跳三）
    const mode = PAT.forbidMode(BLACK, 'renju', om);
    if (PAT.forbiddenCore(board, idxOf(x, y), mode)) return LOSE;
    return NONE;
  }

  // 空点是否禁手（供 UI 标红 / 复盘校验）：返回 0 或禁手等级（L.OVERLINE / DOUBLE_FOUR / DOUBLE_THREE）
  function isForbidden(board, idx, rule, overlineMode) {
    if (rule !== 'renju') return PAT.FD_NONE;
    return PAT.forbiddenAt(board, idx, PAT.forbidMode(BLACK, 'renju', overlineMode));
  }

  // 返回获胜连线的全部坐标（用于高亮）；无则 null
  function winningLine(board, x, y, player, rule) {
    for (let d = 0; d < 4; d++) {
      const dx = DIRS[d][0], dy = DIRS[d][1];
      const len = runLength(board, x, y, player, dx, dy);
      const ok = (rule === 'renju' && player === BLACK) ? len === 5 : len >= 5;
      if (!ok) continue;
      const cells = [];
      let sx = x, sy = y;
      while (inBoard(sx - dx, sy - dy) && board[idxOf(sx - dx, sy - dy)] === player) { sx -= dx; sy -= dy; }
      let cx = sx, cy = sy;
      while (inBoard(cx, cy) && board[idxOf(cx, cy)] === player) { cells.push({ x: cx, y: cy }); cx += dx; cy += dy; }
      return cells;
    }
    return null;
  }

  /* ---------- 规则插件（§7.1） ---------- */
  const RULES = {
    freestyle: {
      name: 'freestyle',
      label: '无禁手',
      overlineMode: DEFAULT_OVERLINE,
      checkWin: (b, x, y, p) => (isWin(b, x, y, p, 'freestyle') ? WIN : NONE),
      isForbidden: () => PAT.FD_NONE,
      /** 同一棋型在两模式下的分值差异由 patterns 的规则表承担（§4.2/§7.4） */
      forbidMode: () => 0,
    },
    renju: {
      name: 'renju',
      label: '有禁手（Renju）',
      overlineMode: DEFAULT_OVERLINE,
      checkWin: (b, x, y, p, om) => judge(b, x, y, p, 'renju', om),
      isForbidden: (b, idx, om) => isForbidden(b, idx, 'renju', om),
      forbidMode: () => PAT.forbidMode(BLACK, 'renju', DEFAULT_OVERLINE),
    },
  };
  function get(rule) { return RULES[rule] || RULES.freestyle; }

  return {
    WIN, LOSE, NONE, RULES, get,
    runLength, maxRun, countExactFives,
    isWin, judge, isForbidden, winningLine,
  };
});
