/* engine/coach.js — 教练层：提示（Top-N）与形势判断（M8；§10/§11/§28）
 * 不自己搜索：search/threat/eval → 人能读的结构。一律 0 基 (x,y)，对外记号由 record.coordText 转换。 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(
    require('./core.js'), require('./patterns.js'), require('./eval.js'), require('./rules.js'),
    require('./search.js'), require('./threat.js'), require('./record.js'));
  else {
    root.G = root.G || {};
    root.G.coach = factory(root.G.core, root.G.patterns, root.G.eval, root.G.rules,
                           root.G.search, root.G.threat, root.G.record);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, PAT, EV, RU, S, THREAT, REC) {
  'use strict';
  const { N, NN, EMPTY, BLACK, WHITE, opp, idxOf } = core;

  const WIN = PAT.WIN;

  /* ---------- 类型标签（§10.1 type 字段）---------- */
  const T = {
    FIVE: '成五', OPEN_FOUR: '活四', DOUBLE_FOUR: '双四', FOUR_THREE: '四三',
    DOUBLE_THREE: '双三', FOUR: '冲四', OPEN_THREE: '活三', DEFEND: '防守', NORMAL: '常规',
  };
  const TL = {};
  TL[PAT.L.WIN] = T.FIVE; TL[PAT.L.OPEN_FOUR] = T.OPEN_FOUR; TL[PAT.L.DOUBLE_FOUR] = T.DOUBLE_FOUR;
  TL[PAT.L.FOUR_THREE] = T.FOUR_THREE; TL[PAT.L.DOUBLE_THREE] = T.DOUBLE_THREE;
  TL[PAT.L.FOUR] = T.FOUR; TL[PAT.L.OPEN_THREE] = T.OPEN_THREE; TL[PAT.L.DEAD] = T.DEFEND;
  function typeOf(level, forbid) {
    if (forbid) return '禁手';
    return TL[level] || T.NORMAL;
  }
  // 兜底：中等型按"是否压住对方威胁"二次判定
  function refineType(board, i, stm, cfg, level, base) {
    if (base === T.FIVE || base === T.OPEN_FOUR || base === T.DOUBLE_FOUR ||
        base === T.FOUR_THREE || base === T.DOUBLE_THREE || base === T.FOUR) return base;
    const o = opp(stm);
    const ld = PAT.levelAt(board, i, o, PAT.forbidMode(o, cfg.rule, cfg.overlineMode));
    return ld >= PAT.L.FOUR ? T.DEFEND : base;
  }

  // 归一到 0..100（§10.1 norm）：与最佳者的比值经 0.35 次幂映射（拉开中段区分度）
  function normalize(values) {
    const best = values[0];
    if (!(best > 0)) return values.map(() => 0);
    return values.map(function (v) {
      if (v <= -WIN / 2) return 0;                        // 必败着法
      const r = v / best;
      if (r >= 1) return 100;
      const p = Math.pow(Math.max(0, r), 0.35);           // 0.35 次幂：拉开中段区分度
      return Math.max(1, Math.round(p * 100));
    });
  }

  /* ---------- 盘上已有五连？（R11）----------
   * ★ 终局后 hint/judge 照常运行会给出荒谬结论（白已五连而黑还有四 ⇒ 误判"黑已胜 100%"、
   *   威胁求解器报假"必胜"）。两入口都先问"棋是否已下完"：每个已落子点当"最后一手"
   *   复用 rules.isWin（口径与真实裁决一致，含 Renju 恰五/长连之别）。 */
  function fiveOnBoard(b, rule, om) {
    for (let i = 0; i < NN; i++) {
      const p = b[i];
      if (p !== EMPTY && RU.isWin(b, i % N, (i / N) | 0, p, rule, om)) return p;
    }
    return 0;
  }

  // VCF→VCT 顺序求解（hint/judge 共用）：deadline/budget 即止
  function solveMate(p, stm, cfg, o, dl) {
    let w = cfg.vcfDepth > 0 ? THREAT.vcfWin(p, stm, { depth: o.vcfDepth || cfg.vcfDepth, budget: o.vcfBudget || cfg.vcfBudget, deadline: dl, rule: cfg.rule, overlineMode: cfg.overlineMode }) : null;
    if (!w && cfg.vctDepth > 0 && Date.now() < dl) w = THREAT.vctWin(p, stm, { depth: o.vctDepth || cfg.vctDepth, budget: o.vctBudget || cfg.vctBudget, deadline: dl, rule: cfg.rule, overlineMode: cfg.overlineMode });
    return w;
  }

  /* ---- hint 提示 Top-N（§10/§28）→ {rank,x,y,i,coord,score,norm,type,win,mate?,mateLen?} ---- */
  function hint(board, stm, opts) {
    const o = opts || {};
    const n = Math.max(1, o.topN === undefined ? 5 : (o.topN | 0));
    const rule = o.rule || 'freestyle';
    const om = o.overlineMode || 'rif';
    const cfg = S.resolveCfg({
      rule: rule, overlineMode: om,
      difficulty: o.difficulty || 'hard',
      depth: o.depth || 4,                                 // 根层单轮搜索深度（≠ 难度 maxDepth）
    });
    if (o.time && o.time.hard) cfg.hardLimit = Math.min(cfg.hardLimit, o.time.hard);

    const b = board instanceof Int8Array ? board : Int8Array.from(board || []);
    if (fiveOnBoard(b, rule, om)) return [];               // ★ 终局：无候选（R11，防假"必胜"）
    const mS = PAT.forbidMode(stm, rule, om);

    // ① 立即取胜点（winningPoints 返回索引 i）→ 全部是必胜手，直接置顶
    const winPts = [];
    for (const i of S.winningPoints(b, stm, mS, rule)) winPts.push(i);

    // ② 根候选分值（bestMoves 已降序）
    let raw;
    if (winPts.length) {
      raw = winPts.map(i => ({ x: i % N, y: (i / N) | 0, i, v: WIN, forbid: 0, viaWin: true }));
    } else {
      raw = S.bestMoves(b, stm, cfg, 0);
      // 禁手着法不进提示列表（对黑棋是自败）
      const keep = raw.filter(m => !m.forbid);
      if (keep.length) raw = keep;
    }

    // ③ 必杀标注 ★R11：只保留 sound 证据源 = 根局面 solveOne（"轮到我"前提正确且 dfs
    //   排除对方成五点）。旧候选级探测跳过对方回合搜杀 ⇒ 假必胜制造机（用户实测踩中），已删；
    //   败着由搜索分识别 + 下方过滤；双四/活四由搜索证明自然标注（WIN−ply）。
    let rootMate = null;                             // { i, via, len }（至多一个：最短杀首选点）
    if (o.useThreat !== false && !winPts.length && (cfg.vcfDepth > 0 || cfg.vctDepth > 0)) {
      const dl = Date.now() + Math.min(o.threatMs === undefined ? 400 : o.threatMs, cfg.hardLimit);
      try {
        const w0 = solveMate(S.posFromBoard(b, stm), stm, cfg, o, dl);
        // ★ plies 已含首选点（move = path[0]），勿再 +1
        if (w0 && w0.move) rootMate = { i: w0.move.y * N + w0.move.x, via: w0.via || 'vcf', len: w0.plies || 1 };
      } catch (e) { /* 探测失败不影响提示 */ }
    }

    // ④ 组装 Top-N ★ 必胜按杀距重排：立即胜 WIN−1；攻方 L 手 ⇒ WIN−(2L−1)；搜索证明 = WIN−ply
    const MATE_TH = PAT.WIN - 1000;                 // 杀分 = WIN − ply
    let bs = 0, bm = null, bl = 0;                     // 多来源取最快杀（R10）：搜索证明与威胁链估计取更短者
    const put = function (sc, mate, len) { if (sc > bs) { bs = sc; bm = mate; bl = len; } };
    const eff = raw.map(function (m) {
      bs = -Infinity; bm = null; bl = 0;
      if (m.viaWin) put(PAT.WIN - 1, 'win', 1);
      if (m.v >= WIN) put(PAT.WIN, 'win', 1);                        // bestMoves 的即胜（成五）
      else if (m.v >= MATE_TH) put(m.v, 'search', Math.ceil((PAT.WIN - m.v) / 2));
      const v = rootMate && rootMate.i === m.i ? rootMate : null;
      if (v) put(PAT.WIN - Math.max(1, v.len * 2 - 1), v.via, v.len);
      if (bs > -Infinity) return { m: m, s: bs, win: 1, mate: bm, len: bl };
      return { m: m, s: m.v, win: 0, mate: null, len: 0 };
    });
    eff.sort((a, b2) => b2.s - a.s);
    // ★ 必败着法不上榜（R11）：走了就输的点只会以 norm=0% 同"必胜"标签出现；
    //   被将死时整表为空 ⇒ UI 显示"无候选"。分组归一（R11）：必胜按杀距 100..80，
    //   普通在 0..78 比值归一 ⇒ "必胜"旁永不见 0%/低分。
    const top = eff.filter(e => e.s > -WIN / 2).slice(0, n);
    const norms = top.map(e => e.win ? Math.max(80, 108 - Math.max(1, e.len) * 8) : 0);
    {
      const pn = normalize(top.filter(e => !e.win).map(e => e.s)).map(v => Math.round(v * 0.78));
      for (let k = 0, j = 0; k < top.length; k++) if (!top[k].win) norms[k] = pn[j++];
    }
    return top.map(function (e, k) {
      const m = e.m;
      const level = PAT.levelAt(b, m.i, stm, mS);
      // ★ 禁手优先级最高：levelAt 的廉价预检可能返回普通等级，需用 forbiddenAt 复核
      const fb = mS > 0 && PAT.forbiddenAt(b, m.i, mS);
      let tp = fb ? '禁手' : typeOf(level, 0);
      if (!fb) tp = refineType(b, m.i, stm, cfg, level, tp);
      return {
        rank: k + 1, x: m.x, y: m.y, i: m.i,
        coord: REC.coordText(m.x, m.y),
        score: Math.round(e.s),
        norm: norms[k],
        type: tp,
        win: !!e.win,
        mate: e.mate,
        mateLen: e.len,
      };
    });
  }

  /* ---- judge 形势判断（§11/§28 → blackRate, label, mate, forbiddenPoints） ---- */
  const LABELS = [
    [0.85, '黑大优'], [0.68, '黑优'], [0.56, '黑稍优'], [0.44, '均势'],
    [0.32, '白稍优'], [0.15, '白优'], [-1, '白大优'],
  ];

  function judge(board, stm, opts) {
    const o = opts || {};
    const rule = o.rule || 'freestyle';
    const om = o.overlineMode || 'rif';
    const b = board instanceof Int8Array ? board : Int8Array.from(board || []);
    // ★ 终局优先（R11）：不检查则白已五连而黑还有四时，会误给"黑已胜 100%"（与实况相反）。
    const fiver = fiveOnBoard(b, rule, om);
    if (fiver) { const bw = fiver === BLACK;
      return { blackRate: bw ? 1 : 0, label: bw ? '黑已胜' : '白已胜', score: bw ? WIN : -WIN,
        source: 'over', mate: null, forbiddenPoints: [], stm: stm }; }
    const mS = PAT.forbidMode(stm, rule, om);
    const o2 = opp(stm);
    let score = 0, source = 'eval';

    // ① 走子方有成五点 ⇒ 已胜；对方双成五点 ⇒ 必负
    if (S.winningPoints(b, stm, mS, rule).length) { score = WIN; source = 'win'; }
    else {
      const ow = S.winningPoints(b, o2, PAT.forbidMode(o2, rule, om), rule);
      if (ow.length >= 2) { score = -WIN; source = 'win'; }
      else if (ow.length === 1) {
        // 对方唯一成五点：堵掉即缓解，是"危"非"必死"。原 −WIN/2 会把大优局误打到 ≈0%。
        score = -2400; source = 'urgent';
      }
    }

    // ② 必杀标注（VCF/VCT）：可选，独立时限
    let mate = null;
    if (source === 'eval' && o.useThreat !== false) {
      const cfg = S.resolveCfg({ rule: rule, overlineMode: om, difficulty: o.difficulty || 'hard' });
      const dl = Date.now() + Math.min(o.threatMs === undefined ? 500 : o.threatMs, cfg.hardLimit);
      try { mate = solveMate(S.posFromBoard(b, stm), stm, cfg, o, dl); } catch (e) { mate = null; }
      if (mate) { score = WIN / 2; source = 'mate'; }                        // 有杀 → 强优但未"已胜"
    }

    // ③ 静态评估兜底 + 统一黑方视角
    if (source === 'eval') {
      score = EV.staticEval(b, stm, { rule: rule, overlineMode: om, lambda: EV.DEFAULT.lambda });
      if (stm === WHITE) score = -score;
    } else {
      score = stm === BLACK ? score : -score;
    }

    const blackRate = evalToWinRate(score);
    let forbiddenPoints = [];
    if (o.forbidden !== false && PAT.forbidMode(BLACK, rule, om) > 0) {
      forbiddenPoints = forbiddenPointsOf(b, rule, om, o.radius === undefined ? 2 : o.radius)
        .map(function (i) { return { x: i % N, y: (i / N) | 0, coord: REC.coordText(i % N, (i / N) | 0) }; });
    }

    return {
      blackRate: blackRate, label: labelOf(blackRate, score), score: Math.round(score), source: source,
      mate: mate ? { side: stm === BLACK ? 'B' : 'W', plies: mate.path ? mate.path.length : 0, via: mate.via || 'vcf' } : null,
      forbiddenPoints: forbiddenPoints, stm: stm,
    };
  }

  // eval → 胜率 S 形映射（§11.1）：logistic，尺度按"四"量级标定（±2400 ≈ 0.73/0.27）
  const S_SCALE = 2400;
  function evalToWinRate(score) {
    if (score >= WIN) return 1;
    if (score <= -WIN) return 0;
    const r = 1 / (1 + Math.exp(-score / S_SCALE));
    return Math.max(0.001, Math.min(0.999, r));
  }
  function labelOf(rate, score) {
    if (score >= WIN) return '黑已胜';
    if (score <= -WIN) return '白已胜';
    for (const pair of LABELS) if (rate >= pair[0]) return pair[1];
    return '白大优';
  }

  // 黑方禁手点（§7/§29.3 红叉）：只扫邻域 radius（与主线程 computeForbidden 同范式）
  function forbiddenPointsOf(board, rule, om, radius) {
    const mode = PAT.forbidMode(BLACK, rule, om);
    if (mode <= 0) return [];
    const out = [];
    const r = radius === undefined ? 2 : radius;
    for (let i = 0; i < NN; i++) {
      if (board[i] !== EMPTY) continue;
      const x = i % N, y = (i / N) | 0;
      let near = false;
      for (let dy = -r; dy <= r && !near; dy++) {
        const ny = y + dy; if (ny < 0 || ny >= N) continue;
        for (let dx = -r; dx <= r; dx++) {
          const nx = x + dx; if (nx < 0 || nx >= N) continue;
          if (board[idxOf(nx, ny)] !== EMPTY) { near = true; break; }
        }
      }
      if (!near) continue;
      if (PAT.forbiddenAt(board, i, mode)) out.push(i);
    }
    return out;
  }

  // heat 出点热力图（§11.1）→ [{ x, y, v }]，v ∈ 0..1（黑优→大）
  function heat(board, stm, opts) {
    const o = opts || {};
    const rule = o.rule || 'freestyle';
    const om = o.overlineMode || 'rif';
    const b = board instanceof Int8Array ? board : Int8Array.from(board || []);
    const cfg = S.resolveCfg({ rule: rule, overlineMode: om, difficulty: o.difficulty || 'normal',
                               depth: o.depth || 2 });
    const raw = S.bestMoves(b, stm, cfg, 0);
    const out = [];
    for (const m of raw) {
      let v = m.forbid ? -WIN : (stm === WHITE ? -m.v : m.v);   // 禁手 = 0；白视角统一到黑
      out.push({ x: m.x, y: m.y, v: Math.max(0, Math.min(1, 1 / (1 + Math.exp(-v / S_SCALE)))) });
    }
    // ★ 禁手点上图（R11）：v=0，如实显示"这里不能走"。
    if (stm === BLACK && o.forbidden !== false) {
      const have = new Set(out.map(p => p.y * N + p.x));
      for (const fi of forbiddenPointsOf(b, rule, om, 7)) {        // radius=7 ⇒ 覆盖全盘
        if (!have.has(fi)) out.push({ x: fi % N, y: (fi / N) | 0, v: 0 });
      }
    }
    return out;
  }

  /* ---------- 用时曲线数据（§9.3 识别长考手） ---------- */
  function timeSeries(rec) {
    // ★ 经 REC.moveAt 取手：直接读 m.timeMs 会在元组产物上得 undefined ⇒ 曲线全 0。
    const mv = (rec && rec.moves) || [];
    if (!mv.length) return [];
    const ts = [], players = [], nos = [];
    for (let k = 0; k < mv.length; k++) {
      const m = (REC && REC.moveAt) ? REC.moveAt(rec, k) : mv[k];
      if (!m) continue;
      ts.push(Number(m.timeMs) || 0);
      players.push(m.player);
      nos.push(Number.isFinite(m.no) ? m.no : k + 1);
    }
    if (!ts.length) return [];
    const mean = ts.reduce(function (a, b) { return a + b; }, 0) / ts.length;
    const sd = Math.sqrt(ts.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / ts.length);
    return ts.map(function (t, k) {
      return { no: nos[k], timeMs: t, player: players[k], mean: Math.round(mean),
               isOutlier: t > mean + 2 * sd && t > 0 };
    });
  }

  return {
    T: T, LABELS: LABELS, S_SCALE: S_SCALE,
    typeOf: typeOf, normalize: normalize, evalToWinRate: evalToWinRate, labelOf: labelOf,
    hint: hint, judge: judge, heat: heat, timeSeries: timeSeries,
    forbiddenPointsOf: forbiddenPointsOf, fiveOnBoard: fiveOnBoard,
  };
});
