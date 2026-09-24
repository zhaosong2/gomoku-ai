/* engine/search.js — 搜索（M3 完成 + M7 增强版）
 * Negamax + PVS + 迭代加深 + 渴望窗 + 置换表(平铺 typed array) + killer/history 排序
 * + 静态搜索(quiescence) + 时限降级 L0/L1/L3（§24 / §34.4 / §24.7）
 *
 * M7 增强（§19 里程碑 8 / §17.1 / §24.2 / §24.5）：
 *   ① IID 内部迭代加深：TT 无着法时先浅搜取着（§24.2）
 *   ② LMR 用规格公式 r = max(0, floor(log d·log i/2))（旧实现是与规格无关的奇偶 hack）
 *   ③ 次级 killer 槽 + history malus（未剪枝着法扣分）
 *   ④ 根层存 TT 并把上一轮最佳着法用于排序（旧实现根层从不存 TT → 迭代加深白做排序）
 *   ⑤ TT 标志位修正：基于**原始窗口**算 EXACT/LOWER/UPPER（旧实现恒存 UPPER，实测 2351/2351）★正确性
 *   ⑥ TT 着法 key 校验 + TT 代龄(age) + 规则盐隔离（§24.5）★正确性
 *
 * ⑤⑥ 是**正确性修复**，不受开关控制；①②③④ 是可调启发式，由 `cfg.h` 位开关控制
 * （H_LMR=1 / H_HIST=2 / H_IID=4 / H_ROOT=8，默认全开 15；设 0 退回 M7 前启发式，供 §17.2 A/B）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(
    require('./core.js'), require('./patterns.js'), require('./eval.js'), require('./rules.js'), require('./threat.js'), require('./book.js'));
  else { root.G = root.G || {}; root.G.search = factory(root.G.core, root.G.patterns, root.G.eval, root.G.rules, root.G.threat, root.G.book); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core, PAT, EV, RU, THREAT, BOOK) {
  'use strict';
  const { N, NN, EMPTY, BLACK, WHITE, opp, idxOf, ZOB } = core;

  const INF = 1e9;
  const MATE = PAT.WIN - 1000;          // 杀分阈值
  const TIMEOUT = { timeout: true };    // 超时哨兵

  /* ★ M7 启发式按位开关（§17.4 调参 / §17.2 A/B 对比用；模块级变量，热路径零开销）
   * 注意：TT 标志位修正、TT 着法 key 校验、代龄与规则盐属于**正确性修复**，不受开关控制。
   */
  const H_LMRF = 1;    // LMR 用 §24.2 规格公式（替代旧的奇偶 hack）
  const H_KILL2 = 2;   // 次级 killer 槽
  const H_IID = 4;     // 内部迭代加深
  const H_ROOT = 8;    // 根层存 TT + 复用上一轮最佳着法
  const H_LMRR = 16;   // 削减后若 v>α，再全深零窗重搜（更准但更贵）
  const H_MALUS = 32;  // history malus：未剪枝的安静着法扣分
  // ★ A2+A4 收官（2026-09-20）：RAZOR/MCUT/VERIFY 并入 H_ALL（63→703→2751）；
  //   VDP（本引擎 PVS 窗口下无触发场景，杀题 nodes 0.0%）/FUTILE（实战快验 −134 Elo，depth 回落）
  //   **弃用留档**——位常量保留，可用 cfg.h 手动开启复盘。回滚 = cfg.h 传 63（旧默认）。
  const H_VDP    = 64;   // A2a victory distance pruning：杀分窗口外直接返回（纯正确性剪枝）
  const H_RAZOR  = 128;  // A2b razoring：浅层静态分过低时先试 quiesce（✓ 并入：节点 −44.2%，Elo CI 含 0）
  const H_FUTILE = 256;  // A2c extended futility：浅层劣势节点只搜威胁着法（✗ 弃：节点 −62% 但实战 −134 Elo）
  const H_MCUT   = 512;  // A2d 着法数裁剪：深层且前若干着全差时砍尾部（✓ 并入：节点 −30.9%，depth 持平，Elo CI 含 0）
  const H_VERIFY = 2048; // A4 取胜线复核：PV 节点胜分窄窗验证，fail-low 再全窗 cautious 重搜（§4.4）
  const H_LEAFVCF = 1024; // A3 叶节点 VCF：depth<=0 时先试 VCF 再 quiesce（§4.3；须 cfg.leafVcfDepth>0）
  const H_ALL = H_LMRF | H_KILL2 | H_IID | H_ROOT | H_LMRR | H_MALUS | H_RAZOR | H_MCUT | H_VERIFY;

  // ★ A4 复核触发计数（只读验收用）：触发数 / 总节点应 <1%（§4.4 门槛）
  let verifyCount = 0;
  // ★ A3 叶 VCF 计数（只读验收用）：命中率 = hits/calls，<2% 则应关掉（§4.3 成本护栏）
  let leafVcfCalls = 0;
  let leafVcfHits = 0;
  let H = H_ALL;

  // 取消标志检查（§28 abort）：位于时间检查点，几乎零成本
  function checkCancel(cfg) {
    const c = cfg.cancel;
    if (c && c[0] === 1) throw TIMEOUT;
  }

  const DEFAULT = {
    rule: 'freestyle', overlineMode: 'rif',              // §26.2 长连判定（rif=官方 / strict=长连一律负）
    lambda: 0.9, width: 12, radius: 2,
    maxDepth: 8, hardLimit: 3000, ttBits: 18, aspiration: 50,
    lmrStart: 4, qDepth: 6, incr: true,
    // ★ A6 增量材料表（§4.7）：默认 **false = 现状**（不维护 pos.material，零开销）。
    //   打开后 pos.material 维护「双方 8 类单棋型计数」，口径与 countBoth / lc.tot 逐位一致，
    //   供 A5 `wldOf` 做 O(1) 胜负判定。回滚 = 不传该字段。
    incrMaterial: false,
    // ★ A11 禁手评估缓存（§4.12）：默认 false=现状。开启后 forbiddenAt 走局部窗哈希缓存
    //   （P-F 命中率 57.0%，renju depth4 端到端省 20.6%）。收益集中在 renju（freestyle 调用为 0）。
    forbidMemo: false,
    // ★ A9 候选位图（§4.10）：默认 false=现状。开启后 candidates() 收集阶段改走 Uint32Array(8)
    //   位图（跳空 word），实测 3.23→2.71 µs（快 16%），输出顺序逐位一致。回滚 = 不传。
    candBit: false,
    // ★ M7 启发式按位开关（H_LMR|H_HIST|H_IID|H_ROOT = 15）；设 0 可退回 M7 前启发式，供 A/B 对比
    h: H_ALL, iidDepth: 4, iidStep: 2, iidMode: 1,
    // §24.2 的规格公式在本引擎浅层会算出 0（等于不削减），实测劣于旧启发式；
    // 按下限 2 标定后节点数大幅下降且结论不变（见 §35 M7 标定记录）。可用 cfg.lmrMin 覆盖。
    lmrMin: 2,
    // 威胁搜索（§25）：depth 为 0 表示关闭
    vcfDepth: 0, vctDepth: 0, vcfBudget: 60000, vctBudget: 40000, threatMs: 900,
    // ★ A3 叶节点 VCF（§4.3）：depth<=0 时先试浅 VCF 再 quiesce。
    //   leafVcfDepth 默认 0 = **常关**（不传字段即回滚）；leafVcfBudget 默认 2000，
    //   必须**远小于**根层 vcfBudget，否则每个叶节点都贵。
    leafVcfDepth: 0, leafVcfBudget: 2000,
    // 对方 VCF 规避：对根候选前 avoidK 个做"落子后对方是否 VCF 必胜"的检查
    avoidOpp: false, avoidK: 6, avoidDepth: 6, avoidBudget: 15000,
    // 开局库（§12.4 / §12.4.3）：前 bookPly 手直接出书招，在进入搜索前返回
    //   · 现役是**前缀匹配树**（按实战胜率选点，直到匹配不上为止）；树缺数据时回落到线库。
    //   · bookShrink：经验贝叶斯收缩系数 K（score=(w+K·prior)/(n+K)），样本越少越向先验回归。
    //   · bookModel：'tree'（默认，§12.4.3 胜率选点）/ 'line'（旧线库，按频次抽样）/ 'auto'（树优先，缺数据时回落）
    useBook: true, bookPly: 12, bookTopK: 8, bookShrink: 120, bookTie: 0.02,
    bookModel: 'tree', rnd: null,
  };

  /* ---------- 难度预设（§13 / §32，按规则分别标定） ---------- */
  const DIFFICULTY = {
    easy:   { maxDepth: 3,  hardLimit: 300,  width: 10, radius: 1, lambda: 1.0,  ttBits: 16 },
    normal: { maxDepth: 5,  hardLimit: 1000, width: 14, radius: 2, lambda: 0.95, ttBits: 18 },
    hard:   { maxDepth: 7,  hardLimit: 2000, width: 18, radius: 2, lambda: 0.9,  ttBits: 18,
              vcfDepth: 8,  vctDepth: 6,  vcfBudget: 60000,  vctBudget: 40000, threatMs: 700,
              avoidOpp: true,  avoidK: 6, avoidDepth: 6, avoidBudget: 12000 },
    master: { maxDepth: 12, hardLimit: 3000, width: 22, radius: 2, lambda: 0.9,  ttBits: 20,
              vcfDepth: 16, vctDepth: 12, vcfBudget: 180000, vctBudget: 120000, threatMs: 1200,
              avoidOpp: true,  avoidK: 8, avoidDepth: 8, avoidBudget: 25000 },
  };
  function difficultyCfg(name, rule) {
    const d = DIFFICULTY[name] || DIFFICULTY.hard;
    const cfg = Object.assign({}, d);
    // Renju 模式禁手判定成本更高 → 深度下调 1~2（§32）
    if (rule === 'renju') cfg.maxDepth = Math.max(2, cfg.maxDepth - 2);
    return cfg;
  }
  // 合并：DEFAULT ← 难度预设 ← 显式参数（显式优先）
  function resolveCfg(cfgIn) {
    const a = cfgIn || {};
    const base = a.difficulty ? difficultyCfg(a.difficulty, a.rule) : null;
    return base ? Object.assign({}, DEFAULT, base, a) : Object.assign({}, DEFAULT, a);
  }

  /* ---------- 难度标定快照（§13 / §17.4）----------
   * ★ 为什么需要它：§13 要求难度档位**按规则分别标定**（freestyle / renju 各一套时
   *   深/宽/限时）。仅靠 `difficultyCfg` 的"renju 深度 −2"无法表达"同档位两规则
   *   各自不同的限时与威胁搜索开关"，标定工具也无法把**实测**出来的参数注入引擎。
   *   机制：`SEARCH.setDifficultyOverride(name, patch)` 注册后，`difficultyCfg` 会
   *   优先套用该快照（快照含 maxDepth 时跳过规则微调）。标定工具用它跑 A/B，
   *   标定完成后把胜出的数值回写到上面的 DIFFICULTY 表。
   *   约束：只影响 `difficulty` 预设路径；`think(pos, {maxDepth:...})` 显式参数不受影响。
   */
  const DIFFICULTY_OVERRIDE = Object.create(null);
  function setDifficultyOverride(name, patch) { DIFFICULTY_OVERRIDE[name] = patch || null; }
  function difficultyOverrides() { return DIFFICULTY_OVERRIDE; }

  /* ---------- 置换表（§24.5 / §34.4：平铺 typed array） ---------- */
  let TT = null, TT_AGE = 1;                  // ★ age：区分"本轮"与"上一轮残留"（§24.5）
  let SALT = 0;                               // ★ 规则盐：freestyle / renju / strict 互不污染（§24.5）
  function ttInit(bits) {
    if (TT && TT.bits === bits) return;                     // 同尺寸复用，避免反复分配
    const size = 1 << bits;
    TT = {
      bits: bits, size: size, mask: size - 1,
      key: new Int32Array(size), depth: new Int8Array(size).fill(-1), flag: new Int8Array(size),
      val: new Int32Array(size), move: new Int32Array(size).fill(-1),
      age: new Uint8Array(size),                            // ★ §24.5 TTEntry.age
    };
    TT_AGE = 1;
  }
  function ttClear() { if (TT) { TT.depth.fill(-1); TT.move.fill(-1); TT.age.fill(0); } }
  // 每轮 think 推进一代：老代条目优先级低于新代（"depth-preferred + always-replace 混合"）
  function ttNewGen() {
    if (!TT) return;
    TT_AGE = (TT_AGE + 1) & 255;
    if (TT_AGE === 0) { TT_AGE = 1; ttClear(); }            // 代龄回绕 → 整表失效
  }
  function ruleSalt(cfg) {
    let s = 0;
    if (cfg.rule === 'renju') s ^= 0x5bf03635;              // 禁手规则下同一局面的值完全不同
    if (cfg.overlineMode === 'strict') s ^= 0x1b873593;
    return s | 0;
  }
  function hashOf(pos) { return (pos.zobLo ^ SALT) | 0; }
  function toTT(v, ply) { return v >= MATE ? v + ply : (v <= -MATE ? v - ply : v); }
  function fromTT(v, ply) { return v >= MATE ? v - ply : (v <= -MATE ? v + ply : v); }
  function ttProbe(hash, depth, alpha, beta, ply) {
    const i = (hash >>> 0) & TT.mask;
    if (TT.depth[i] < 0 || TT.key[i] !== (hash | 0)) return null;   // 空槽 / 键不符
    if (TT.depth[i] < depth) return null;
    const v = fromTT(TT.val[i], ply), f = TT.flag[i];
    if (f === 0) return v;                       // EXACT
    if (f === 1 && v <= alpha) return v;         // UPPER
    if (f === 2 && v >= beta) return v;          // LOWER
    return null;
  }
  // ★ 取 TT 着法必须校验 key：否则会拿"同槽位别的局面"的着法当首选（旧实现未校验）
  function ttMoveAt(hash) {
    const i = (hash >>> 0) & TT.mask;
    return (TT.depth[i] >= 0 && TT.key[i] === (hash | 0)) ? TT.move[i] : -1;
  }
  // TT 里该局面已存的最大深度（-1 = 无条目）；IID 模式 2 用它判断"着法是否已过时"
  function ttDepthAt(hash) {
    const i = (hash >>> 0) & TT.mask;
    return (TT.depth[i] >= 0 && TT.key[i] === (hash | 0)) ? TT.depth[i] : -1;
  }
  // ★ flag 必须基于**原始窗口**：调用方传 (origAlpha, beta)（旧实现传被抬高后的 alpha → 恒为 UPPER）
  function ttStore(hash, depth, alpha, beta, value, move, ply) {
    const i = (hash >>> 0) & TT.mask;
    if (TT.age[i] === TT_AGE && TT.depth[i] > depth) return;   // 同代内深优先；跨代一律覆盖
    TT.key[i] = hash | 0;
    TT.depth[i] = depth;
    TT.val[i] = toTT(value, ply);
    TT.move[i] = move;
    TT.age[i] = TT_AGE;
    TT.flag[i] = value <= alpha ? 1 : (value >= beta ? 2 : 0);
  }

  /* ---------- 排序启发 ---------- */
  let killer = [], histB = new Int32Array(NN), histW = new Int32Array(NN);
  const HIST_MAX = 1 << 20;                   // 防止长时间搜索累加溢出
  function bumpHist(stm, i, inc) {
    const h = stm === BLACK ? histB : histW;
    const v = h[i] + inc;
    h[i] = v > HIST_MAX ? HIST_MAX : (v < -HIST_MAX ? -HIST_MAX : v);
  }
  // 杀手着法：两个槽位（主 / 次），次级给半额加分（§24.3）
  function storeKiller(ply, i) {
    const k = killer[ply] || (killer[ply] = [-1, -1]);
    if (k[0] === i) return;
    if (H & H_KILL2) k[1] = k[0];             // ★ 次级槽（M7）
    k[0] = i;
  }

  /* ---------- LMR 削减表（§24.2：r = max(0, floor(log d · log i / 2))） ----------
   * 旧实现是 Math.min(2, 1 + ((k+depth)&1))——与规格无关、只看奇偶，且浅层也照样削 1~2 层。
   * 预计算成查表，热路径零 log 开销；上限钳到 depth-1，保证 depth-1-r ≥ 0。
   */
  const LMR_MAXD = 40, LMR_MAXI = 80;
  const LMR_TAB = (function () {
    const t = new Int8Array(LMR_MAXD * LMR_MAXI);
    for (let d = 0; d < LMR_MAXD; d++) for (let i = 0; i < LMR_MAXI; i++) {
      let r = 0;
      if (d >= 2 && i >= 1) r = Math.floor(Math.log(d) * Math.log(i) / 2);
      t[d * LMR_MAXI + i] = Math.max(0, Math.min(d - 1, r));
    }
    return t;
  })();
  // min：削减量下限（§17.4 标定用；规格公式在浅层/靠前候选处会算出 0，实测不如"至少削 1~2"）
  // ★ 钳位顺序很重要：必须先取 max(min,·) 再用 depth-1 封顶，否则 min 会把子深度削成负数
  function lmrReduce(depth, i, min) {
    const lo = min | 0;
    const cap = depth - 1 > 0 ? depth - 1 : 0;
    const spec = (depth < LMR_MAXD && i < LMR_MAXI)
      ? LMR_TAB[depth * LMR_MAXI + i]
      : Math.max(0, Math.floor(Math.log(Math.max(2, depth)) * Math.log(Math.max(1, i)) / 2));
    const r = spec < lo ? lo : spec;
    return r < cap ? r : cap;
  }

  /* ---------- 立即取胜点（§25 基础能力） ---------- */
  // 实现移到 threat.js（单一实现，供 VCF/VCT 复用）
  const winningPoints = THREAT.winningPoints;

  /* ---------- 着法生成与排序（§24.3） ---------- */
  const _info = { level: 0 };                       // 复用容器：避免每候选分配对象
  function genMoves(pos, cfg, ply, ttMove) {
    const board = pos.board, stm = pos.stm;
    const o = opp(stm);
    // 对方"一步成五点"：无论排序如何都必须保留，避免宽度裁剪丢防守（§5.3 排序注意点）
    // 注意：对方若是黑棋（Renju），其禁手点不是成五点（不能靠"成五"取胜）→ 交给 winngPoints 过滤
    const mustBlock = winningPoints(board, o, PAT.forbidMode(o, cfg.rule, cfg.overlineMode), cfg.rule);
    const blockSet = mustBlock.length ? new Set(mustBlock) : null;
    const cand = EV.candidates(board, cfg.radius);
    const list = [];
    for (let k = 0; k < cand.length; k++) {
      const i = cand[k], x = i % N, y = (i / N) | 0;
      // ★ 排序主键 = attack + λ·defend（§4.4）；TT/killer/history 只做小幅加权，
      //   绝不允许把防守分值压成噪声（否则丢关键防点 → 假必败）
      // 同一次调用内复用定级结果（level / forbid），避免重复 classify
      let s = EV.moveScoreAt(board, i, stm, cfg, _info);
      // ★ 禁手着法（Renju 黑）：评分表已给 −1e9（§4.6），搜索中还会被直接判为立即负（见 pvs）
      const fb = _info.forbid;
      if (fb) s -= 1e13;                               // 禁手沉底（但**不删除**：设计坚持"惩罚而非禁止"）
      else if (blockSet && blockSet.has(i)) s += 1e13; // 必挡 > 一切
      else if (i === ttMove) s += 1e12;                // TT 着法
      const kl = killer[ply];
      if (kl) { if (kl[0] === i) s += 1e4; else if ((H & H_KILL2) && kl[1] === i) s += 5e3; }   // ★ 次级 killer
      s += (stm === BLACK ? histB[i] : histW[i]) * 1e-4;
      list.push({ i: i, x: x, y: y, s: s, forbid: fb, forcing: !fb && _info.level >= PAT.L.FOUR });
    }
    list.sort((a, b) => b.s - a.s);
    // 根层"对方 VCF 规避"过滤（§25.4 防守侧）：只在确实排除了处着法时生效
    if (ply === 0 && cfg.rootAllowed) {
      const f = [];
      for (let k = 0; k < list.length; k++) if (cfg.rootAllowed.has(list[k].i)) f.push(list[k]);
      if (f.length) return f.slice(0, cfg.width);
    }
    return list.slice(0, cfg.width);
  }

  /* ---------- 增量评估缓存挂载（§33.3 + A6 §4.7） ---------- */
  // 每个 pos 一份"过 idx 的 4 线双方计数"快照缓冲 + post 相位用的单线 scratch（避免热路径分配）
  const _line4 = new Int32Array(4 * 2 * PAT.NCLS);
  const _lineCur = new Int32Array(PAT.NCLS);
  // 快照语义：phase==='post' 时用"上一事件在 pre 相位记下的"4 线内容当 before。
  // ★ 为什么必须有 'pre'/'post' 两相：原地递增型结构（material）需要在"变化前后各读一次"
  //   才能求差；只有 post 相位时 before 只能取"上一次 post"的内容，而**其他落子会改变
  //   同一条线**，差值与真值必然漂移（实测 2026/2400 步）。见 core.js makeMove 的注释。
  function cellHook(pos, idx, phase) {
    // ① 线分缓存（§33.3）：内容寻址，重算过 idx 的 4 条线即可，与相位无关
    if (pos.lc) PAT.cacheUpdate(pos.lc, idx, pos.board);
    // ② 材料表（A6）：必须原地递增，且需要 before/after 两侧读数
    if (pos.material) {
      if (phase === 'pre') PAT.lines4Counts(pos.board, idx, _line4);            // 变化前 → before
      else PAT.materialInc(pos.material, idx, pos.board, _line4, 0, _lineCur);  // 变化后
    }
  }
  function attachCache(pos, on) {
    if (on === false) { pos.lc = null; pos.material = null; pos.onCell = null; return; }
    pos.lc = PAT.newLineCache(pos.board);   // 全量建一次（72 线）
    pos.material = null;                    // ★ A6 默认关：由 cfg.incrMaterial 显式打开
    pos.onCell = cellHook;                  // 之后 make/unmake 增量维护
  }
  // A6：在 attachCache 之上追加材料表（cfg.incrMaterial === true 时调用）
  function attachMaterial(pos) {
    pos.material = PAT.materialOf(pos.board);
    pos.onCell = cellHook;
  }
  // 依 cfg 一次挂好两套缓存（think 的热路径入口）
  function attachIncr(pos, cfg) {
    const on = cfg.incr !== false;
    attachCache(pos, on);
    if (on && cfg.incrMaterial === true) attachMaterial(pos);
  }

  /* ---------- 静态搜索（§24.6） ---------- */
  function quiesce(pos, alpha, beta, cfg, ply, deadline) {
    nodes++;
    if ((nodes & 511) === 0 && Date.now() > deadline) throw TIMEOUT;
    if ((nodes & 511) === 0) checkCancel(cfg);
    const board = pos.board, stm = pos.stm, o = opp(stm);
    const mS = PAT.forbidMode(stm, cfg.rule, cfg.overlineMode);
    const mO = PAT.forbidMode(o, cfg.rule, cfg.overlineMode);
    if (winningPoints(board, stm, mS, cfg.rule).length) return PAT.WIN - ply;
    const ow = winningPoints(board, o, mO, cfg.rule);
    if (ow.length >= 2) return -(PAT.WIN - ply - 1);
    const stand = EV.staticEvalPos(pos, cfg);               // ★ 增量 O(1)（§33.3）
    if (ply >= cfg.qDepth) return stand;
    if (ow.length === 1) {                                  // 必应：唯一封点
      const i = ow[0];
      // ★ 逼禁：唯一封点对走子方（黑）是禁手 → 无法封堵 → 立即负（§7.3）
      if (mS > 0 && PAT.forbiddenAt(board, i, mS)) return -(PAT.WIN - ply);
      core.makeMove(pos, i % N, (i / N) | 0, stm);
      let v; try { v = -quiesce(pos, -beta, -alpha, cfg, ply + 1, deadline); } finally { core.unmakeMove(pos); }
      return v;
    }
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const list = [];
    for (const i of EV.candidates(board, cfg.radius)) {
      const lv = PAT.levelAt(board, i, stm, mS);
      // 禁手着法不进静态搜索（Renju 黑；freestyle 下长连是胜，必须保留）
      // ★ 用严格判定（forbiddenAt）而非 lv：`lv === DOUBLE_*` 是**窗口**口径，
      //   与严格口径在 ≈0.01% 的点上不一致（2026-09-20 #33 修正）。
      if (mS > 0 && PAT.forbiddenAt(board, i, mS)) continue;
      if (lv >= PAT.L.FOUR) list.push({ i: i, x: i % N, y: (i / N) | 0, s: PAT.LEVEL_M[lv] });
    }
    list.sort((a, b) => b.s - a.s);
    const top = list.slice(0, 6);
    for (const m of top) {
      core.makeMove(pos, m.x, m.y, stm);
      let v; try { v = -quiesce(pos, -beta, -alpha, cfg, ply + 1, deadline); } finally { core.unmakeMove(pos); }
      if (v > alpha) alpha = v;
      if (alpha >= beta) break;
    }
    return alpha;
  }

  /* ---------- PVS（§24.1） ---------- */
  let nodes = 0;
  function pvs(pos, depth, alpha, beta, cfg, ply, deadline) {
    nodes++;
    if ((nodes & 1023) === 0 && Date.now() > deadline) throw TIMEOUT;
    if ((nodes & 1023) === 0) checkCancel(cfg);
    const hash = hashOf(pos);
    const hit = ttProbe(hash, depth, alpha, beta, ply);
    if (hit !== null) return hit;
    // ★ A2a VDP（§4.2，PentaZen search.cpp:356-361）：轮走方最优分 ≤ WIN−ply（本手成五封顶）、
    //   最差分 ≥ −(WIN−(ply+1))。窗口完全落在可达域外 ⇒ 直接返回边界（fail-soft）。
    //   纯数学剪枝：不引入估值 ⇒ 根层结论必须与关时完全一致（等价性 diff==0 是硬验收）。
    //   早退不经过 ttStore ⇒ 不污染 TT。
    if (H & H_VDP) {
      const mateMax = PAT.WIN - ply;
      if (alpha >= mateMax) return mateMax;
      if (beta < -mateMax + 1) return -mateMax + 1;
    }
    if (depth <= 0) {
      // ★ A3 叶节点 VCF（§4.3，PentaZen search.cpp:369-376）：叶节点**先试 VCF 再 quiesce**。
      //   顺序不可反：quiesce 会先把局面"平静化"，VCF 的机会就丢了（与 PentaZen 一致）。
      //   开闸三条件：① 位开关 H_LEAFVCF ② cfg.leafVcfDepth>0 ③ 上一步不是已成五（已成五无需再证）。
      if ((H & H_LEAFVCF) && cfg.leafVcfDepth > 0) {
        const li = pos.hist[pos.hist.length - 1];
        const justWon = li !== undefined &&
          RU.isWin(pos.board, core.xOf(li), core.yOf(li), opp(pos.stm), cfg.rule, cfg.overlineMode);
        if (!justWon) {
          leafVcfCalls++;
          const w = THREAT.vcfWin(pos, pos.stm, {
            depth: cfg.leafVcfDepth, budget: cfg.leafVcfBudget,
            deadline, rule: cfg.rule, overlineMode: cfg.overlineMode,
          });
          if (w) {
            leafVcfHits++;
            // ★ 2026-09-20 裁决（#34，施工图 A3 缺陷）：**不用施工图伪码的 `PAT.WIN-1000-ply`**。
            //   该口径 = MATE − ply < MATE，会同时破坏三处杀分语义：
            //     ① `think()` 的 `bestV >= MATE` 见杀早停判不出（迭代加深白跑更贵的层）；
            //     ② `toTT/fromTT` 的 `v >= MATE` 分支不命中 ⇒ TT 里不带杀语义（ply 补偿丢失）；
            //     ③ `bench-mates`/分析侧 `|score| >= 99999000` 判据漏判（实测把已解出的题判为未解）。
            //   统一为与 pvs 成五返回（search.js `v = PAT.WIN - ply`）**完全一致**的杀分口径。
            return PAT.WIN - ply;
          }
        }
      }
      return quiesce(pos, alpha, beta, cfg, ply, deadline);
    }

    // ★ A2b razoring（§4.2，PentaZen :444-446）：非 PV 浅节点、静态分远低于 alpha ⇒
    //   先跑 quiesce 试探；连静态搜索都够不到 alpha ⇒ 返回 q（fail-low）。
    //   ⚠ 2026-09-20 实测修正：规格字面 `return se`（裸静态分）在本引擎产生**方向性乐观偏差**
    //   （40 中局 diff 40/40，劣势局被系统性抬高，如 −606→−411、−40→+392）——五子棋 quiesce
    //   与 se 的战术差距远大于国象。q 已算出、零额外成本且严格更准 ⇒ 返回 q。
    //   ⚠ 仍属估值口径 ⇒ 不写 TT（避免 ply 补偿污染，§4.2 契约）。
    if ((H & H_RAZOR) && depth <= 2 && beta - alpha <= 1) {
      const se = EV.staticEvalPos(pos, cfg);
      if (se + 200 * depth < alpha) {
        const q = quiesce(pos, alpha, beta, cfg, ply, deadline);
        if (q < alpha) return q;
      }
    }

    let ttMove = ttMoveAt(hash);
    /* ★ IID 内部迭代加深（§19 M7 / §17.1）：先浅搜一层拿好着法再排序。只在 PV 节点做（零窗做了是浪费）。
     *   iidMode=1（标准）：仅当 TT **完全没有着法**时触发。
     *     ⚠ 实测：迭代加深下浅层搜索早已为每个局面留下着法，此闸门几乎从不触发（见 §35 M7 记录）。
     *   iidMode=2（本项目的必要改造）：当 TT 着法的**存储深度 < 本次需求 − iidStep** 时也触发——
     *     否则深度 5 的节点会拿"深度 1 时存下的着法"当首选，排序质量差。
     */
    if ((H & H_IID) && depth >= cfg.iidDepth && beta - alpha > 1) {
      const lack = cfg.iidMode === 2 ? (ttDepthAt(hash) < depth - cfg.iidStep) : (ttMove < 0);
      if (lack) {
        pvs(pos, depth - cfg.iidStep, alpha, beta, cfg, ply, deadline);   // 结果写入 TT
        ttMove = ttMoveAt(hash);
      }
    }

    const stm = pos.stm;
    const moves = genMoves(pos, cfg, ply, ttMove);
    if (!moves.length) return 0;

    // ★ A2c extended futility（§4.2，PentaZen :448-450）：非 PV 浅节点、静态分已远低于 alpha ⇒
    //   非威胁着法不可能把分数拉回 alpha，跳过（continue，非 return）。
    //   forcing 谓词**零成本复用 genMoves 已算好的 m.forcing**（=落子成 ≥ 冲四等级，:245）——
    //   施工图方案 A（moveScoreAt≥活三分）反而多算一次；语义对齐"威胁着法"，比"≥活三"略严（多剪），
    //   若题库退化再放宽。se 惰性计算：仅位开且条件可能成立时才算。
    const futActive = (H & H_FUTILE) && depth <= 3 && beta - alpha <= 1;
    const seFut = futActive ? EV.staticEvalPos(pos, cfg) : 0;

    const origAlpha = alpha;                 // ★ TT 标志位必须基于原始窗口
    let best = -INF, bestMove = -1, first = true, k = 0;
    for (const m of moves) {
      // ★ A2c：非威胁着法在劣势浅节点直接跳过（不搜索、不计 k——k 语义是"已完整搜索数"）
      if (futActive && !m.forcing && seFut + 120 * depth <= alpha) continue;
      core.makeMove(pos, m.x, m.y, stm);
      let v;
      try {
        if (m.forbid) v = -(PAT.WIN - ply);                                 // ★ 禁手 ⇒ 走者判负（§26）
        else if (RU.isWin(pos.board, m.x, m.y, stm, cfg.rule, cfg.overlineMode)) v = PAT.WIN - ply;
        else if (first) v = -pvs(pos, depth - 1, -beta, -alpha, cfg, ply + 1, deadline);
        else {
          const r = (depth >= 3 && k >= cfg.lmrStart && !m.forcing)
            ? ((H & H_LMRF) ? lmrReduce(depth, k, cfg.lmrMin) : Math.min(2, 1 + ((k + depth) & 1))) : 0;
          v = -pvs(pos, depth - 1 - r, -alpha - 1, -alpha, cfg, ply + 1, deadline);
          // ★ 削减后反而抬高 alpha → 全深零窗重搜（更准；实测代价不小，故单独一位开关）
          if ((H & H_LMRR) && v > alpha && r > 0) v = -pvs(pos, depth - 1, -alpha - 1, -alpha, cfg, ply + 1, deadline);
          if (v > alpha && v < beta) v = -pvs(pos, depth - 1, -beta, -alpha, cfg, ply + 1, deadline);
        }
        // ★ A4 取胜线复核（§4.4，PentaZen :520-527 原义适配；此处仍在 makeMove 状态中）：
        //   PV 节点搜出 ≥MATE 的着法（排除本手直接成五——那是规则级事实无需验证）→
        //   先窄窗 (−MATE, −MATE+1) 试探对方能否反驳；fail-low 再全窗 cautious 重搜拿权威值。
        //   ⚠ 对施工图伪码的三处偏差（均对齐 PentaZen 原义，2026-09-20 裁决）：
        //   ①per-move 落点（伪码的 rootSearch 落点 + ply>=1 在彼处恒 false = 死代码，施工图缺陷⑤）；
        //   ②双层：单层会把窄窗边界毛刺（MATE−1）误当真实值降级真胜线；
        //   ③cautious = 重搜期间清 H_MCUT（对齐 PentaZen :472 move-count 豁免——A4 是 A2d 的兜底）
        //     且清 H_VERIFY（防嵌套递归）。TT 污染不在防御范围（同 TT 复核被 ttProbe 短路）。
        if ((H & H_VERIFY) && beta - alpha > 1 && ply >= 1 && v >= MATE && v < PAT.WIN - ply) {
          verifyCount++;
          const savedH = H;
          H = savedH & ~(H_MCUT | H_VERIFY);
          try {
            const s = -pvs(pos, depth - 1, -MATE, -MATE + 1, cfg, ply + 1, deadline);
            if (s < MATE) v = -pvs(pos, depth - 1, -beta, -alpha, cfg, ply + 1, deadline);
          } finally { H = savedH; }
        }
      } finally { core.unmakeMove(pos); }
      if (v > best) { best = v; bestMove = m.i; }
      if (best > alpha) alpha = best;
      if (alpha >= beta) {
        if (!m.forcing) { storeKiller(ply, m.i); bumpHist(stm, m.i, depth * depth); }
        break;
      }
      // ★ history malus：没能剪枝的安静着法扣分（M7；旧实现只加分不扣分 → 历史很快被噪声填满）
      if ((H & H_MALUS) && !m.forcing) bumpHist(stm, m.i, -depth * depth);
      first = false; k++;
      // ★ A2d 着法数裁剪（§4.2，PentaZen :471-478）：浅层（≤4）且已试 4+depth² 个着法、
      //   当前最佳仍远低于 alpha（差 40+）⇒ 尾部着法大概率无望，直接砍。
      //   风险最高的一条（可能砍掉正解）⇒ 单独一位、题库必须不降才并入。
      //   break 后 best<alpha 走 ttStore 上界 flag——是搜索值非估值，可安全入库。
      if ((H & H_MCUT) && depth <= 4 && k >= 4 + depth * depth && best < alpha + 40) break;
    }
    // ★ A2c 守卫：该节点无威胁着法且全被 futility 跳过 ⇒ best 仍为 -INF，
    //   返回静态分（fail-low 估值）且**不写 TT**（-INF/估值入库都会污染父节点）。
    if (best === -INF) return seFut;
    ttStore(hash, depth, origAlpha, beta, best, bestMove, ply);
    return best;
  }

  /* ---------- 根节点（渴望窗 + PVS） ---------- */
  let lastRootValue = null;
  function rootSearch(pos, depth, cfg, deadline, lo, hi, prevMove) {
    const stm = pos.stm;
    const hash = hashOf(pos);
    // ★ 迭代加深必须复用"上一轮最佳着法"：旧实现根层从不存 TT，也从不回传，
    //   导致每轮迭代都从零排序（TT 槽里还是别的局面的残留着法）——迭代加深的排序收益全丢。
    const ttM = ((H & H_ROOT) && prevMove >= 0) ? prevMove : ttMoveAt(hash);
    const moves = genMoves(pos, cfg, 0, ttM);
    const oLo = lo, oHi = hi;                    // 原始窗口（存 TT 算 flag 用）
    let alpha = lo, bestM = null, bestV = -INF, first = true, timeout = false;
    for (const m of moves) {
      core.makeMove(pos, m.x, m.y, stm);
      let v;
      try {
        if (m.forbid) v = -(PAT.WIN - 1);                                   // ★ 禁手 ⇒ 走者判负（§26）
        else if (RU.isWin(pos.board, m.x, m.y, stm, cfg.rule, cfg.overlineMode)) v = PAT.WIN - 1;
        else if (first) v = -pvs(pos, depth - 1, -hi, -alpha, cfg, 1, deadline);
        else {
          v = -pvs(pos, depth - 1, -alpha - 1, -alpha, cfg, 1, deadline);
          if (v > alpha && v < hi) v = -pvs(pos, depth - 1, -hi, -alpha, cfg, 1, deadline);
        }
      } catch (e) {
        core.unmakeMove(pos);
        if (e === TIMEOUT) { timeout = true; break; }
        throw e;
      }
      core.unmakeMove(pos);
      if (v > bestV) { bestV = v; bestM = m; }
      if (v > alpha) alpha = v;
      first = false;
    }
    if ((H & H_ROOT) && !timeout && bestM) ttStore(hash, depth, oLo, oHi, bestV, bestM.i, 0);   // ★ 根层也入 TT
    lastRootValue = bestV;
    return { timeout: timeout, move: bestM, value: bestV };
  }

  /* ---------- L0：立即战术（§24.7） ---------- */
  function tacticalMove(pos, cfg) {
    const b = pos.board, stm = pos.stm, o = opp(stm);
    const mS = PAT.forbidMode(stm, cfg.rule, cfg.overlineMode);
    const mO = PAT.forbidMode(o, cfg.rule, cfg.overlineMode);
    const w = winningPoints(b, stm, mS, cfg.rule);
    if (w.length) return pt(w[0]);
    const ow = winningPoints(b, o, mO, cfg.rule);
    if (ow.length >= 2) return null;                       // 对方双威胁：无单一救着
    if (ow.length === 1) {
      // 唯一封点若是走子方禁手 → 无法封堵（逼禁）；不返回该点，交给搜索/VCF 判负
      if (!(mS > 0 && PAT.forbiddenAt(b, ow[0], mS))) return pt(ow[0]);
    }
    for (const i of EV.candidates(b, cfg.radius)) {
      const lv = PAT.levelAt(b, i, stm, mS);
      // ★ 严格判定（2026-09-20 #33）：不再从 lv === DOUBLE_* 推断禁手（窗口口径会假阳）
      if (mS > 0 && PAT.forbiddenAt(b, i, mS)) continue;
      if (lv >= PAT.L.OPEN_FOUR) return { x: i % N, y: (i / N) | 0 };
    }
    return null;
    function pt(i) { return { x: i % N, y: (i / N) | 0 }; }
  }

  /* ---------- 威胁搜索：VCF → VCT（§25.4） ---------- */
  function threatSolve(pos, cfg, t0, tactBudget) {
    const stm = pos.stm;
    // ★ A1-a（施工图 §4.1）：威胁搜索拿 think() 切好的独立预算 tactBudget，不再直接吃 hardLimit
    //   （否则战术超支会侵占主搜索份额）。不传第 4 参时保持旧行为（兼容直接调用方）。
    const share = Number.isFinite(tactBudget) ? Math.min(cfg.threatMs, tactBudget)
                                              : Math.min(cfg.threatMs, Math.max(50, cfg.hardLimit));
    const dl = t0 + share;
    const o = { rule: cfg.rule, overlineMode: cfg.overlineMode };      // 求解器须知道规则（禁手/恰好五）
    if (cfg.vcfDepth > 0) {
      const w = THREAT.vcfWin(pos, stm, { depth: cfg.vcfDepth, budget: cfg.vcfBudget, deadline: dl, rule: o.rule, overlineMode: o.overlineMode });
      if (w) return w;
    }
    if (cfg.vctDepth > 0 && Date.now() < dl) {
      const w2 = THREAT.vctWin(pos, stm, { depth: cfg.vctDepth, budget: cfg.vctBudget, deadline: dl, rule: o.rule, overlineMode: o.overlineMode });
      if (w2) return w2;
    }
    return null;
  }

  /* ---------- 开局库出招（§12.4 / §12.4.3）----------
   * 位置：`tacticalMove` 之后、`threatSolve`/迭代加深之前。
   *   · 放在 L0 之后 ⇒ 绝不会因为有书招而漏掉"眼前就能赢/必须堵"的战术点；
   *   · 放在 VCF/VCT 与迭代加深之前 ⇒ 开局阶段完全不进搜索，**省下整手耗时**，
   *     同时避开 §4.7(5) 指出的"稀疏局面静态评估不可靠"。
   *
   * ★ 模型（§12.4.3，用户指定）：前缀匹配树。
   *   从已下 2 手起逐层下探 → 命中约 26 个"第 3 手"候选（平均 443 局/个）→ 取**实战胜率**
   *   收缩估计最高的一手；再以 3 手下探（约 155 个候选）看第 4 手……**直到匹配不上任何棋谱**。
   *   树缺数据时回落到旧线库（按频次抽样）。
   *
   * ★ 启用前提（三条，缺一不可）：
   *   ① `cfg.useBook` 且未超过 `cfg.bookPly`；
   *   ② **`pos.hist.length === pos.stones`** —— 历史必须与实际盘面子数一致。
   *      这一条挡住了 `posFromBoard()` 构造的局面（历史为空而棋盘有子）：那种局面拿
   *      ''(空序列) 去查会命中"黑1=天元"，是**错的**。
   *   ③ 书招落点确实为空；且 Renju 下黑方不得是禁手点（数据来自 RIF 实战，
   *      理论上恒成立，但跨规则/对称展开后仍加一道兜底）。
   */
  function openingMove(pos, cfg) {
    if (!cfg.useBook || !BOOK) return null;
    if (pos.hist.length >= (cfg.bookPly | 0)) return null;
    if (pos.hist.length !== pos.stones) return null;

    // ★ bookModel 用于 A/B 与回滚：'line' 强制走旧线库（按频次抽样），
    //   这样"胜率选点 vs 频次抽样"可以在**剂量相同**的两侧对照（否则对手一偏离就脱书，
    //   开库侧平均只用到 1~2 手书招，任何 A/B 都测不出差异）。
    const preferLine = cfg.bookModel === 'line';
    let c = null;
    if (!preferLine && BOOK.defaultTreeMove) {
      c = BOOK.defaultTreeMove(pos.hist, { shrink: cfg.bookShrink, tie: cfg.bookTie });
    }
    if (!c && BOOK.defaultMove) {                  // 树不可用/未命中 ⇒ 回落到旧线库
      c = BOOK.defaultMove(pos.hist, {
        ruleSet: cfg.rule === 'renju' ? 'rif' : 'freestyle', topK: cfg.bookTopK,
        rnd: typeof cfg.rnd === 'function' ? cfg.rnd : Math.random,
      });
    }
    if (!c) return null;
    const i = idxOf(c.x, c.y);
    if (pos.board[i] !== EMPTY) return null;
    if (cfg.rule === 'renju' && pos.stm === BLACK) {
      const mS = PAT.forbidMode(BLACK, cfg.rule, cfg.overlineMode);
      if (mS > 0 && PAT.forbiddenAt(pos.board, i, mS)) return null;
    }
    return c;
  }

  /* ---------- 对方 VCF 规避（防守侧，§25.4） ----------
   * 对根候选前 K 个：落子后若**对方**存在 VCF 必胜，则该着法危险。
   * 仅当"确实筛掉了危险着法"时才启用过滤（避免全危险时把着法清空）。
   */
  function avoidOpponentVcf(pos, cfg, rootMoves) {
    if (!cfg.avoidOpp || cfg.vcfDepth <= 0) return null;
    const stm = pos.stm, def = opp(stm);
    const K = Math.min(cfg.avoidK, rootMoves.length);
    const allowed = new Set();
    let danger = 0;
    for (let k = 0; k < K; k++) {
      const m = rootMoves[k], x = m.x, y = m.y;
      core.makeMove(pos, x, y, stm);
      let oppWin = null;
      try {
        if (!m.forbid && !RU.isWin(pos.board, x, y, stm, cfg.rule, cfg.overlineMode)) {
          oppWin = THREAT.vcfWin(pos, def, {
            depth: cfg.avoidDepth, budget: cfg.avoidBudget,
            rule: cfg.rule, overlineMode: cfg.overlineMode,
          });
        }
      } finally { core.unmakeMove(pos); }
      if (oppWin || m.forbid) danger++; else allowed.add(m.i);   // 自走禁手同样视为危险着法
    }
    if (danger === 0 || allowed.size === 0) return null;    // 无需过滤 / 无法过滤
    return allowed;
  }

  /* ---------- 主入口 ---------- */
  function think(pos, cfgIn) {
    const cfg = resolveCfg(cfgIn);
    H = cfg.h === undefined ? H_ALL : (cfg.h | 0);          // ★ M7 启发式按位开关
    const t0 = Date.now();
    // ★ A1-a（施工图 §4.1）：预算切分——战术（VCF/VCT）拿独立份额 tactBudget，
    //   主搜索拿剩余 budgetMax，互相不得侵占。总闸 deadline 保留给兜底判定（不变）。
    const HARD = Math.max(1, cfg.hardLimit);
    const TACT_RATIO = Number.isFinite(cfg.tacticalRatio) ? cfg.tacticalRatio : 0.35;
    const tactBudget = Math.min(cfg.threatMs, Math.max(50, HARD * TACT_RATIO));
    const deadline = t0 + HARD;
    ttInit(cfg.ttBits);
    ttNewGen();                                             // ★ 推进 TT 代龄（§24.5）
    SALT = ruleSalt(cfg);                                   // ★ 规则盐隔离（§24.5）
    attachIncr(pos, cfg);                                   // §33.3 + A6 增量缓存
    killer = new Array(cfg.maxDepth + 2);
    histB.fill(0); histW.fill(0);
    nodes = 0; lastRootValue = null;
    // ★ A11 禁手评估缓存（§4.12）：按 cfg 打开/关闭（默认 false ⇒ 与旧行为逐位一致）。
    //   缓存键含盘面内容 ⇒ 跨 think() 复用也正确；但每次 think 重置计数便于观测命中率。
    PAT.forbidMemoSet(cfg.forbidMemo === true);
    // ★ A9 候选位图（§4.10）：全局门控（threat/operators/search 都直接调 EV.candidates）
    EV.setCandBit(cfg.candBit === true);

    const t = tacticalMove(pos, cfg);                       // L0
    if (t) return { move: t, score: PAT.WIN, depth: 0, nodes: 0, timeMs: Date.now() - t0,
                    fallbackLevel: 0, via: 'l0' };

    const bk = openingMove(pos, cfg);                   // §12.4 / §12.4.3 开局库（前缀树）
    if (bk) return { move: { x: bk.x, y: bk.y }, score: 0, depth: 0, nodes: 0,
                     timeMs: Date.now() - t0, fallbackLevel: 0, via: 'book',
                     book: { opening: bk.opening, weight: bk.w, source: bk.source,
                             depth: bk.depth, cands: bk.cands, games: bk.games,
                             rate: bk.rate, score: bk.score } };

    // ★ A1-a：战术段计时 → 主搜索拿剩余份额。
    //   ⚠ 施工图伪码写 mainDeadline = t0 + budgetMax，会把战术耗时扣两次
    //   （主搜索实际只剩 HARD−2·tactUsed）——正确基准是主搜索起点 mainStart。
    const tactT0 = Date.now();
    const w = threatSolve(pos, cfg, tactT0, tactBudget);    // §25.4 VCF → VCT（独立预算）
    const tactUsed = Date.now() - tactT0;
    let budgetMax = Math.max(50, HARD - tactUsed);          // 主搜索份额（A1-c 稳定收缩会改 → let）
    const mainStart = Date.now();                           // 主搜索起点 = 战术段结束时刻
    let mainDeadline = mainStart + budgetMax;               // 主闸（let：A1-c 收缩时同步收紧）
    if (w) {
      return { move: w.move, score: PAT.WIN - 2, depth: 0, nodes: w.nodes,
               timeMs: Date.now() - t0, fallbackLevel: 0, via: w.via, path: w.path };
    }

    const root0 = genMoves(pos, cfg, 0, -1);                // L1 兜底
    if (!root0.length) return null;
    const allowed = avoidOpponentVcf(pos, cfg, root0);      // 对方 VCF 规避（可选）
    if (allowed) cfg.rootAllowed = allowed;
    let best = { x: root0[0].x, y: root0[0].y }, bestV = -INF, reached = 0;

    let rootIdx = -1;                                       // 上一轮最佳着法（供下一轮排序）
    // ★ A1-b（施工图 §4.1）：预测式停止——下一层预计耗时 BUDGET_K×lastTd 会撞主闸就不开这层。
    //   Carbon A7 / Stahlfaust A7 / PentaZen A1 三方共识。
    //   ⚠⚠ 2026-09-20 会话 8 **整体回滚为默认关**（BUDGET_K 默认 0 = 永不预测停止）——实测证据：
    //     · normal/hard 档搜索**远早于时限完成**（58/284ms vs 1000/2000ms，时限富余 10~17×，
    //       stopped 0/12）⇒ **A1 无作用对象**（它优化"时限用尽时怎么分配"，而这些档位用不到时限）；
    //     · master 档时限利用率 96.3% 本就无浪费，A1 只降深度：K 扫描 K=0 深度 9.75 →
    //       K=1 9.00 → K=4 8.25 → K=8 7.75，**无任何 K 能追平 K=0**。
    //     · 动机依据 P-B"68.4% 浪费"失真：`tools/_probe-lastlayer.js` 默认 `--ms=100`，
    //       用 `difficulty:'hard'` + 显式覆盖 hardLimit=100 ⇒ 该"浪费"只在人为压缩时限时成立。
    //   ⇒ 机制代码保留在 cfg 通道内（可复现/将来档位变化后重评），默认值 = 旧行为。
    //     · 旧行为回滚（施工图原写 Infinity 是错的：now+∞ 恒撞闸 ⇒ d=4 即激进停摆）。
    const BUDGET_K = Number.isFinite(cfg.layerFactor) ? cfg.layerFactor : 0;
    // ★ A1-c（施工图 §4.1）：稳定性收缩 + 提前终止。——同上整体回滚为默认关（STAB=1.0 / STOP_EARLY=1.0）。
    //   ⚠ 收缩后 mainDeadline 基准必须仍是 mainStart（施工图伪码写 t0 + budgetMax，
    //   与 A1-a 同一双重扣减问题：会把战术+已耗时间再扣一遍）。
    const STAB = Number.isFinite(cfg.stabilFactor) ? cfg.stabilFactor : 1.0;
    const STOP_EARLY = Number.isFinite(cfg.stopEarly) ? cfg.stopEarly : 1.0;
    let lastBestI = -1;
    let lastTd = 0, stopped = false, shrunk = false;
    for (let d = 2; d <= cfg.maxDepth; d += 2) {
      const now = Date.now();
      if (d > 2 && lastTd > 0 && now + BUDGET_K * lastTd >= mainDeadline) { stopped = true; break; }  // A1-b
      let lo = -INF, hi = INF;
      if (lastRootValue !== null && d >= 4) { lo = lastRootValue - cfg.aspiration; hi = lastRootValue + cfg.aspiration; }
      const tLayer0 = now;
      let r;
      try { r = rootSearch(pos, d, cfg, mainDeadline, lo, hi, rootIdx); }   // ★ A1-a：主闸（原 deadline 总闸保留给兜底）
      catch (e) { if (e !== TIMEOUT) throw e; break; }
      if (!r.timeout && (lo > -INF || hi < INF) && (r.value <= lo || r.value >= hi)) {
        try { r = rootSearch(pos, d, cfg, mainDeadline, -INF, INF, rootIdx); }  // 渴望窗失败 → 全窗重搜
        catch (e) { if (e !== TIMEOUT) throw e; break; }
      }
      lastTd = Date.now() - tLayer0;
      // ★ A1-c：最佳着稳定（同上轮）且 d≥7 ⇒ 收缩"本手剩余预算"（更早收手、省时给后续手），
      //   不是乘层耗时预测（v1.3 修正：旧稿乘 lastTd 方向与 PentaZen 原义相反）
      const bestI = r.move ? r.move.i : -1;
      if (bestI >= 0 && bestI === lastBestI && d >= 7 && budgetMax * STAB >= 200) {
        budgetMax = Math.max(200, budgetMax * STAB);
        mainDeadline = mainStart + budgetMax;               // 同步收紧主闸（mainStart 基准）
        shrunk = true;
      }
      lastBestI = bestI;
      if (r.move) { best = { x: r.move.x, y: r.move.y }; bestV = r.value; reached = d; rootIdx = r.move.i; }
      if (r.timeout) break;
      // ★ A1-c：总耗时已过预算 70% → 主动收手（PentaZen；省下的时间留给后续手换思考）。
      //   budgetMax 用收缩后的当前值（与稳定收缩联动 ⇒ 越稳越早收）。
      if (Date.now() - t0 > budgetMax * STOP_EARLY) { stopped = true; break; }
      if (bestV >= MATE || bestV <= -MATE) break;                        // 已见杀
    }
    const el = Date.now() - t0;
    return {
      move: best, score: bestV, depth: reached, nodes: nodes,
      timeMs: el,
      // ★ 降级语义（§24.7 + M9 难度标定）：既区分"时限内完成全部迭代"与"被时限打断"，
      //   也保留"一层都没搜完"的 L1 兜底。缺了这一位，难度标定工具会把
      //   "深层迭代必然超时"误读成"引擎降级"。
      // ★ A1-a：打断判定从"总耗时超 hardLimit"改为"主搜索段超 budgetMax"——
      //   切分后总闸是 HARD 而主闸是 mainStart+budgetMax，被主闸打断时 el≈HARD−tactUsed，
      //   旧判定 el > cfg.hardLimit 恒 false，会把"被打断"静默漂白成"时限内完成"。
      fallbackLevel: reached ? (el - tactUsed > budgetMax ? 2 : 0) : 1,
      timeInfo: () => ({ budgetMax, tactBudget, tactUsed, lastTd, stopped, shrunk }),   // ★ A1-a/b/c 观测导出（只读）
    };
  }
  /* ---------- 兼容：从裸棋盘构造 Position 并浅搜（供 gen-book 使用） ----------
   * ★ 可选参数 `hist`：真实落子序列（`[[x,y]...]` / `[{x,y}...]` / `[idx...]` 均可）。
   *   加上它的理由（**一个真实的接线缺陷**，不是洁癖）：Worker 的 `move` 请求原先只带
   *   `board`+`stm`，于是只能用本函数重建局面 ⇒ **hist 为空而棋盘有子** ⇒ §12.4 开局库
   *   的前提②(`hist.length === stones`) 恒不成立 ⇒ **开局库在真实产品里一次都不命中**
   *   （Node 基准因为用 core.makeMove 攒历史，反而全都命中，极易造成"测过了"的错觉）。
   *   调用方（worker-entry / ui）负责把历史传进来。
   *   校验不过就**静默退回无历史**（宁可不出書招，也不能拿错序列去查库）：
   *   ① 长度必须等于棋子数；② 每点必须在盘内且非空；③ 不得重复。
   */
  function posFromBoard(board, stm, hist) {
    const pos = core.createPosition();
    pos.board.set(board);
    pos.stm = stm;
    let hi = 0, lo = 0, n = 0;
    for (let i = 0; i < NN; i++) {
      const v = board[i]; if (!v) continue;
      n++; const z = ZOB.z[v - 1][i]; hi ^= z[0]; lo ^= z[1];
    }
    pos.stones = n;
    if (stm === WHITE) { hi ^= ZOB.turn[0]; lo ^= ZOB.turn[1]; }
    pos.zobHi = hi; pos.zobLo = lo;
    if (hist && hist.length === n && n > 0) {
      const ids = [], seen = new Set();
      let ok = true;
      for (const h of hist) {
        let i;
        if (Array.isArray(h)) i = idxOf(h[0], h[1]);
        else if (h && typeof h === 'object' && 'x' in h) i = idxOf(h.x, h.y);
        else if (typeof h === 'number') i = h;
        else { ok = false; break; }
        if (!(i >= 0 && i < NN) || !board[i] || seen.has(i)) { ok = false; break; }
        seen.add(i); ids.push(i);
      }
      if (ok) pos.hist = ids;
    }
    attachCache(pos);                       // §33.3：默认带上增量缓存
    return pos;
  }

  function bestMoves(board, stm, cfgIn, topK) {
    const cfg = resolveCfg(cfgIn);
    H = cfg.h === undefined ? H_ALL : (cfg.h | 0);
    SALT = ruleSalt(cfg);
    const pos = posFromBoard(board, stm);
    ttInit(cfg.ttBits); ttNewGen(); killer = new Array(cfg.maxDepth + 2);
    attachIncr(pos, cfg);                                   // §33.3 + A6 增量缓存
    nodes = 0;
    // ★ A9 候选位图（§4.10）：与 think() 一致设置全局门控（genMoves 直调 EV.candidates）
    EV.setCandBit(cfg.candBit === true);
    const moves = genMoves(pos, cfg, 0, -1);
    const out = [];
    for (const m of moves) {
      core.makeMove(pos, m.x, m.y, stm);
      let v;
      try {
        if (m.forbid) v = -PAT.WIN;                                        // 禁手 ⇒ 该着法自败
        else if (RU.isWin(pos.board, m.x, m.y, stm, cfg.rule, cfg.overlineMode)) v = PAT.WIN;
        else v = -pvs(pos, Math.max(1, cfg.depth || 3) - 1, -INF, INF, cfg, 1, Date.now() + 1e9);
      } finally { core.unmakeMove(pos); }
      out.push({ x: m.x, y: m.y, i: m.i, v: v, forbid: m.forbid });
    }
    out.sort((a, b) => b.v - a.v);
    return topK ? out.slice(0, topK) : out;
  }

  return { DEFAULT, DIFFICULTY, difficultyCfg, setDifficultyOverride, difficultyOverrides, resolveCfg, think, bestMoves, winningPoints, tacticalMove,
           lastNodes: () => nodes,              // 供基准/测试观测（bestMoves 不返回节点数）
           threatSolve, avoidOpponentVcf, ttClear, ttNewGen, ttDepthAt, lmrReduce, posFromBoard, attachCache,
           attachIncr, attachMaterial,        // ★ A6：备选挂载路径（think 已内联，这里供测试/工具显式调用）
           H: { LMRF: H_LMRF, LMRR: H_LMRR, KILL2: H_KILL2, MALUS: H_MALUS, IID: H_IID, ROOT: H_ROOT,
                VDP: H_VDP, RAZOR: H_RAZOR, FUTILE: H_FUTILE, MCUT: H_MCUT, VERIFY: H_VERIFY,
                LEAFVCF: H_LEAFVCF, ALL: H_ALL },
           verifyStat: () => verifyCount,   // ★ A4 验收：复核触发数（只读；随 ttClear 不清零，进程级累计）
           leafVcfStat: () => ({ calls: leafVcfCalls, hits: leafVcfHits }),   // ★ A3 验收：叶 VCF 调用/命中
           leafVcfReset: () => { leafVcfCalls = 0; leafVcfHits = 0; },       //    （进程级累计，可显式清零）
           THREAT, TT: () => TT };
});
