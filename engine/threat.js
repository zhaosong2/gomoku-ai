/* engine/threat.js — 威胁空间搜索：VCF / VCT（M5，§25）
 *
 * 设计原则：**只声明可证真的必胜**
 *   · VCF：每一步都是"对方必须封"的强制手，且每节点先排除"对方已有成五点"⇒ 结论严格成立。
 *   · VCT：在 VCF 之上纳入活三点。落子后若"成五点 = 0"（纯活三），则要求：
 *       ① 防守方任何一手都必须"中和"我方的活四点（否则我方活四 → 胜）；
 *       ② 若防守方存在任何"造四/成五"手段（反击）→ 本线**保守判失败**。
 *     因此结论同样可证真，但**可能不完备**（漏掉含复杂反击的杀）——宁漏不假。
 *
 * 廉价精确判据（基于 §33.2 整数编码窗口表，0.19µs/次）：
 *   fivePointsAfter(board, idx, player) = 落 idx 后 player 的成五点数量
 *     Σ 四方向：OPEN_FOUR→2、FOUR→1、FIVE/OVERLINE→9(已连五)
 *     不同方向不会共享成五点 ⇒ 求和精确。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(
    require('./core.js'), require('./patterns.js'), require('./rules.js'), require('./eval.js'));
  else { root.G = root.G || {}; root.G.threat = factory(root.G.core, root.G.patterns, root.G.rules, root.G.eval); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, PAT, RU, EV) {
  'use strict';
  const { N, NN, EMPTY, DIRS, opp } = core;
  const P = PAT.P;
  const ALREADY = 9;                     // 已经连五的哨兵值
  const BUDGET = { budget: true };       // 预算耗尽哨兵
  const _dirs = new Int32Array(4);

  /* ---------- 成五点（移入本模块，search 复用） ----------
   * mode：禁手语境（PAT.forbidMode）。mode>0 时**禁手点不是成五点**（§26.2），
   *      且长连不算成五（黑棋长连是禁手，不是胜）。
   *
   * ★ 评审优化：改走 `RU.isWinAt`（索引版）。原实现每个候选都
   *   `board[i]=p → isWin(x,y,…) → board[i]=EMPTY`：坐标化 + 最多 8 次方向扫描，
   *   且**裸写棋盘**绕过 onCell 钩子，与 §33.3 增量缓存（pos.lc/material）打架。
   *   isWinAt 免坐标、免写盘、单遍四方向，与 isWin 逐位等价（已对拍 6080 样本）。
   *   ⚠ 口径纪律：**不可**改用 fivePointsAfter（窗口口径）——Renju-黑"长连端点"
   *     场景下窗口半径 4 看不见第 6 子 ⇒ 会把非成五点误判为成五点。
   */
  function hasFivePoint(board, p, mode, rule) {
    const n = EV.candidatesInto(board, 2);
    for (let k = 0; k < n; k++) {
      const i = EV.candAt(k);
      if (mode && PAT.forbiddenAt(board, i, mode)) continue;     // 禁手点不是成五点
      if (RU.isWinAt(board, i, p, rule)) return i;
    }
    return -1;
  }
  function winningPoints(board, p, mode, rule) {
    const out = [];
    const n = EV.candidatesInto(board, 2);
    for (let k = 0; k < n; k++) {
      const i = EV.candAt(k);
      if (mode && PAT.forbiddenAt(board, i, mode)) continue;     // 禁手点不是成五点
      if (RU.isWinAt(board, i, p, rule)) out.push(i);
    }
    return out;
  }
  // 在给定格点集合内找"成五点"（比全局快，用于增量式检查）
  function hasFivePointIn(board, p, cells, mode) {
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      if (board[i] !== EMPTY) continue;
      if (fivePointsAfter(board, i, p, mode) >= ALREADY) return i;
    }
    return -1;
  }

  /* ---------- 威胁判定 ---------- */
  function fivePointsAfter(board, idx, player, mode) {
    PAT.dirsAt(board, idx, player, _dirs);
    let c = 0;
    for (let d = 0; d < 4; d++) {
      const v = _dirs[d];
      if (v === P.FIVE) c += ALREADY;                            // 恰好五连
      else if (v === P.OVERLINE) { if (!mode) c += ALREADY; }    // ★ 黑棋（mode>0）长连不算成五
      else if (v === P.OPEN_FOUR) c += 2;
      else if (v === P.FOUR) c += 1;
    }
    return c;
  }
  const makesFive = (b, i, p, m) => fivePointsAfter(b, i, p, m) >= ALREADY;
  const makesFour = (b, i, p, m) => { const c = fivePointsAfter(b, i, p, m); return c >= 1 && c < ALREADY; };
  const makesOpenFour = (b, i, p, m) => fivePointsAfter(b, i, p, m) >= 2;
  function makesOpenThree(board, idx, player, mode) {
    PAT.dirsAt(board, idx, player, _dirs);
    let ot = false, four = false, five = false;
    for (let d = 0; d < 4; d++) {
      const v = _dirs[d];
      if (v === P.FIVE || (v === P.OVERLINE && !mode)) five = true;
      else if (v === P.OPEN_FOUR || v === P.FOUR) four = true;
      else if (v === P.OPEN_THREE) ot = true;
    }
    return ot && !four && !five;
  }

  /* ---------- 受影响格点表：AFF[q] = 9 格窗口含 q 的中心点（去重，-1 填充） ---------- */
  const AFFW = 32;
  const AFF = (function () {
    const a = new Int32Array(NN * AFFW).fill(-1);
    for (let q = 0; q < NN; q++) {
      const qx = q % N, qy = (q / N) | 0;
      let n = 0;
      for (let d = 0; d < 4; d++) {
        const dx = DIRS[d][0], dy = DIRS[d][1];
        for (let k = -4; k <= 4; k++) {
          if (k === 0) continue;
          const jx = qx - dx * k, jy = qy - dy * k;      // 以 j 为中心时 q 落在其 k 偏移
          if (jx < 0 || jx >= N || jy < 0 || jy >= N) continue;
          const j = jy * N + jx;
          let dup = false;
          for (let t = 0; t < n; t++) if (a[q * AFFW + t] === j) { dup = true; break; }
          if (!dup && n < AFFW) a[q * AFFW + n++] = j;
        }
      }
    }
    return a;
  })();

  /* ---------- 候选生成 ---------- */
  // kind: 3=成五 2=活四/双四 1=冲四 0=活三
  function threatMoves(board, atk, opts) {
    const includeThree = !!(opts && opts.includeThree);
    const mode = (opts && opts.mode) | 0;                       // ★ 禁手语境（黑棋 renju 时走禁手即负）
    const cand = EV.candidates(board, (opts && opts.radius) || 2);
    const out = [];
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k];
      if (board[i] !== EMPTY) continue;
      if (mode && PAT.forbiddenAt(board, i, mode)) continue;    // 禁手着法：不是有效威胁
      const cnt = fivePointsAfter(board, i, atk, mode);
      let kind;
      if (cnt >= ALREADY) kind = 3;
      else if (cnt >= 2) kind = 2;
      else if (cnt === 1) kind = 1;
      else if (includeThree && makesOpenThree(board, i, atk, mode)) kind = 0;
      else continue;
      const x = i % N, y = (i / N) | 0;
      const base = kind === 3 ? 1e7 : kind === 2 ? 1e6 : kind === 1 ? 1e5 : 1e4;
      // 同档内按组合等级 + 靠中心排序（只影响效率，不影响正确性）
      const key = base + PAT.levelAt(board, i, atk, mode) * 10 - (Math.abs(x - 7) + Math.abs(y - 7));
      out.push({ i: i, kind: kind, key: key });
    }
    out.sort((a, b) => b.key - a.key);
    const res = new Array(out.length);
    for (let k = 0; k < out.length; k++) res[k] = out[k].i;
    return res;
  }

  /* ---------- 公共 DFS 骨架 ----------
   * 返回 true 表示"攻方确认必胜"，并把着法**根→叶**依次压入 path。
   */
  function dfs(pos, atk, depth, ctx, path, useThree) {
    if (--ctx.budget < 0) throw BUDGET;
    const board = pos.board, def = opp(atk);

    // ① 我方有成五点 → 直接成五
    const f = hasFivePoint(board, atk, ctx.atkMode, ctx.rule);
    if (f >= 0) { path.push(f); return true; }
    if (depth <= 0) return false;
    // ② 对方也有成五点 → 我方强制手不成立（对方会先成五）
    if (hasFivePoint(board, def, ctx.defMode, ctx.rule) >= 0) return false;

    const cands = threatMoves(board, atk, { radius: ctx.radius, includeThree: useThree, mode: ctx.atkMode });
    for (let k = 0; k < cands.length; k++) {
      const i = cands[k], x = i % N, y = (i / N) | 0;
      core.makeMove(pos, x, y, atk);
      let won = false, ok = false;
      try {
        if (RU.isWin(board, x, y, atk, ctx.rule)) { path.push(i); won = true; }
        else {
          const cnt = fivePointsAfter(board, i, atk, ctx.atkMode);
          if (cnt >= 2) {
            // 活四 / 双四：两个成五点封不住 → 胜
            path.push(i); won = true;
          } else if (cnt === 1) {
            // 唯一成五点 → 对方被迫封
            const b = hasFivePoint(board, atk, ctx.atkMode, ctx.rule);
            if (b < 0) { /* 窗口模型与严格判定不一致：保守放弃本线 */ }
            else if (ctx.defMode && PAT.forbiddenAt(board, b, ctx.defMode)) {
              // ★ 逼禁（§7.3）：唯一封点对防守方是禁手 → 防守方无法封，攻方直接胜
              path.push(i); won = true;
            } else {
              path.push(i);
              core.makeMove(pos, b % N, (b / N) | 0, def);
              try { ok = dfs(pos, atk, depth - 1, ctx, path, useThree); } finally { core.unmakeMove(pos); }
              if (!ok) path.pop();
            }
          } else if (useThree) {
            // 纯活三：防守方所有"非中和"着法都会被我方活四击败；只需检验中和点 + 反击
            path.push(i);
            const r = resolveOpenThree(pos, atk, ctx, depth - 1, path);
            if (r === 'win') ok = true;
            else path.pop();                                    // 'fail' / 'counter' 均保守失败
          }
        }
      } finally { core.unmakeMove(pos); }
      if (won || ok) return true;
    }
    return false;
  }

  /* ---------- 活三节点：求"中和点集"并逐一验证 ----------
   * 返回 'win'（必胜）/ 'fail'（有中和点能挡住）/ 'counter'（防守方能反击 → 保守失败）
   */
  function resolveOpenThree(pos, atk, ctx, depth, path) {
    const board = pos.board, def = opp(atk);
    const cand = EV.candidates(board, ctx.radius);

    // 我方活四点集合 A0（落子后即成活四的点）
    const A0 = [];
    for (let k = 0; k < cand.length; k++) {
      const j = cand[k];
      if (board[j] !== EMPTY) continue;
      if (ctx.atkMode && PAT.forbiddenAt(board, j, ctx.atkMode)) continue;   // 我方禁手点不是威胁
      if (fivePointsAfter(board, j, atk, ctx.atkMode) >= 2) A0.push(j);
    }
    if (!A0.length) return 'fail';                   // 本手没造出活三威胁（不应发生）

    const neutral = [];
    for (let t = 0; t < cand.length; t++) {
      const q = cand[t];
      if (board[q] !== EMPTY) continue;
      // 防守方走不了的点（对其为禁手）：既不能中和，也不能反击 → 直接跳过
      if (ctx.defMode && PAT.forbiddenAt(board, q, ctx.defMode)) continue;
      core.makeMove(pos, q % N, (q / N) | 0, def);
      let counter = false, isNeutral = true;
      try {
        // 反击检查：只在受影响的格点里看（防守方新出现的四/五必在 q 的窗口内）
        const base = q * AFFW;
        for (let s = 0; s < AFFW; s++) {
          const j = AFF[base + s];
          if (j < 0) break;
          if (board[j] !== EMPTY) continue;
          if (ctx.defMode && PAT.forbiddenAt(board, j, ctx.defMode)) continue;  // 防守方禁手点不算反击
          const cd = fivePointsAfter(board, j, def, ctx.defMode);
          if (cd >= 1) { counter = true; break; }      // 造四或成五 → 反击
          if (fivePointsAfter(board, j, atk, ctx.atkMode) >= 2) isNeutral = false;
        }
        if (!counter && isNeutral) {
          // 未受影响的我方活四点若仍存在，则本手未中和
          for (let k = 0; k < A0.length; k++) {
            const j = A0[k];
            if (j === q || board[j] !== EMPTY) continue;
            if (isAffected(q, j)) continue;            // 已在上面判断过
            if (fivePointsAfter(board, j, atk, ctx.atkMode) >= 2) { isNeutral = false; break; }
          }
        }
      } finally { core.unmakeMove(pos); }
      if (counter) return 'counter';
      if (isNeutral) neutral.push(q);
    }
    if (!neutral.length) return 'win';                 // 对方无从中和 → 我方活四必胜
    // 逐一验证：每个中和点之后我方仍能强制取胜
    for (let t = 0; t < neutral.length; t++) {
      const q = neutral[t];
      core.makeMove(pos, q % N, (q / N) | 0, def);
      let sub = false;
      try { sub = dfs(pos, atk, depth, ctx, path, ctx.useThree); } finally { core.unmakeMove(pos); }
      if (!sub) return 'fail';
    }
    return 'win';
  }

  const isAffected = (q, j) => { const base = q * AFFW; for (let s = 0; s < AFFW; s++) { const v = AFF[base + s]; if (v < 0) break; if (v === j) return true; } return false; };

  /* ---------- 入口：深度递增（天然得到最短杀） ---------- */
  function solve(useThree, pos, atk, opts) {
    const o = opts || {};
    const maxDepth = Math.max(2, o.depth | 0);
    const rule = o.rule || pos.rule || 'freestyle';
    const om = o.overlineMode || 'rif';
    const ctx = {
      budget: o.budget || 120000, radius: o.radius || 2,
      useThree: useThree,
      rule: rule,                                                  // 规则名（判定"恰好五连"）
      atkMode: PAT.forbidMode(atk, rule, om),                      // 攻方禁手语境
      defMode: PAT.forbidMode(opp(atk), rule, om),                 // 守方禁手语境（"逼禁"依赖它）
    };
    const t0 = Date.now();
    const deadline = o.deadline || 0;
    const budget0 = ctx.budget;
    for (let d = 2; d <= maxDepth; d += 2) {
      const path = [];
      try {
        if (dfs(pos, atk, d, ctx, path, useThree)) {
          // ★ A7（§4.5）：opts.verify=true 时追加一次"对手抢杀扫描"；被反驳 ⇒ 本线不算胜。
          //   默认 false ⇒ 行为与既有完全一致（回滚 = 不传字段，零风险）。
          if (o.verify && refutePath(pos, atk, path, { rule: rule, overlineMode: om })) continue;
          const mv = path[0];
          return {
            move: { x: mv % N, y: (mv / N) | 0 },
            path: path.slice(), plies: path.length,
            via: useThree ? 'vct' : 'vcf',
            nodes: budget0 - ctx.budget, timeMs: Date.now() - t0,
          };
        }
      } catch (e) { if (e !== BUDGET) throw e; }
      if (ctx.budget < 0) break;
      if (deadline && Date.now() > deadline) break;
    }
    return null;
  }
  const vcfWin = (pos, atk, opts) => solve(false, pos, atk, opts);
  const vctWin = (pos, atk, opts) => solve(true, pos, atk, opts);

  /* ---------- ★ A7 反向验证（§4.5，Stahlfaust GBThreat.cs:400-478）----------
   * 动机：`vcfWin/vctWin` 已是 sound（dfs 每节点先排除对方成五点），但**只有"我搜到一条线"
   *   这一个证据**。本条追加**一次从对手视角的"抢杀扫描"**：把"疑似有杀"升级为"确认有杀"。
   *
   * 完备性依据（Stahlfaust doc/solution.tex:435-450）：攻方类别 k ⇒ 守方只需类别 ≤ k−1 的威胁
   *   ⇒ 类别 1（成五）总有**单子解** ⇒ 守方搜索**完备**。
   *   本实现取该结论的保守版：重放 path，在每个攻方落点**之前**检查守方是否已有成五点
   *   （类别 0，最强威胁）。有 ⇒ 我方这条线走不完 ⇒ 可反驳。
   *
   * ★★ path 的语义（易错）：
   *   `dfs` 里 `path.push(i)` **只推攻方手**；守方应手是 dfs 内部直接 makeMove 落盘、**不入 path**
   *   （见 dfs 的 `cnt === 1` 分支）。故 path = **纯攻方手序列**，与 `verifyPath` 的解释一致。
   *   refutePath 必须按此重放：每走一步攻方手，**自己补上守方的强制应手**（唯一挡点）。
   *
   * ★ 为什么 sound（不引入假阴性）：
   *   守方若在攻方某手之前已有成五点，dfs 的 `② 对方也有成五点 → return false` 早该判本线失败
   *   ⇒ 合法 path 上本检查恒不触发；一旦触发，说明该线前提被破坏（真可反驳）。
   *   另注：**path 前缀可能已在盘上**（调用方从既有局面起搜时 path[0] 常是已落的 first 手）⇒ 跳过。
   *
   * ⚠ renju 兼容：接受 rule/overlineMode；黑方禁手点**不算**其威胁。
   * @returns {boolean} true = 该线可被反驳（调用方应撤回）
   */
  function refutePath(pos, atk, path, opts) {
    const o = opts || {};
    const rule = o.rule || pos.rule || 'freestyle';
    const om = o.overlineMode || 'rif';
    const atkMode = PAT.forbidMode(atk, rule, om);
    const defMode = PAT.forbidMode(opp(atk), rule, om);
    if (!path || path.length < 1) return true;                 // 空线无可信度
    const def = opp(atk);
    let placed = 0;                                            // 本次落子数（含补的守方手）
    const undo = () => { for (let j = placed - 1; j >= 0; j--) core.unmakeMove(pos); };
    for (let k = 0; k < path.length; k++) {
      const i = path[k];
      if (pos.board[i] !== EMPTY) {                            // 前缀已落（first 手）⇒ 跳过（仍占一轮）
        if (pos.board[i] !== atk) { undo(); return true; }
        continue;
      }
      core.makeMove(pos, i % N, (i / N) | 0, atk);
      placed++;
      // ★ 先判攻方是否已终局（成五 / ≥2 成五点）⇒ 对局已定、守方来不及 ⇒ 该线成立。
      //   ⚠ 必须**在查守方之前**判：否则"攻方活四 + 守方另有成五点"的合法线会被误杀
      //   （这正是假阴性风险所在）。
      const atkWon = RU.isWin(pos.board, i % N, (i / N) | 0, atk, rule, om);
      const atkThreats = winningPoints(pos.board, atk, atkMode, rule).length;
      if (atkWon || atkThreats >= 2) { undo(); return false; }
      // ★ 守方是否能立即成五（在我方这一手之后）⇒ 抢在我们前面 ⇒ 可反驳。
      //   ⚠ 这一步必须在"线路走完"判定**之前**：末手若给守方留下成五点，该线同样不成立。
      const defFp = winningPoints(pos.board, def, defMode, rule);
      if (defFp.length > 0) { undo(); return true; }
      if (k === path.length - 1) { undo(); return false; }     // 线路走完且守方无成五点 ⇒ 成立
      // ★ 补守方强制应手：镜像 dfs 的 `cnt === 1` 分支（唯一挡点；对守方是禁手则我方直接胜）
      const b = hasFivePoint(pos.board, atk, atkMode, rule);   // 我方唯一成五点 = 守方必挡点
      if (b < 0 || (defMode && PAT.forbiddenAt(pos.board, b, defMode))) { undo(); return false; }
      core.makeMove(pos, b % N, (b / N) | 0, def);
      placed++;
    }
    undo();
    return false;                                              // 未被反驳 ⇒ 该线成立
  }

  return {
    winningPoints, hasFivePoint, hasFivePointIn,
    fivePointsAfter, makesFive, makesFour, makesOpenFour, makesOpenThree,
    threatMoves, vcfWin, vctWin, refutePath, ALREADY, AFF, AFFW,
  };
});
