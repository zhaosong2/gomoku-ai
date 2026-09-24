/* tools/verify-mate.js — 杀棋路径的**独立复算器**（供测试与题库工具共用）
 *
 * 刻意不复用求解器的任何内部状态：只用「规则判定 + 成五点定义」重新重放路径，
 * 用来证明"求解器声称的必胜"确实成立（可证真），以及"题库里的答案"确实正确。
 *
 * 终局合法的三种形态：
 *   · 该手直接成五；
 *   · 该手留下 >=2 个成五点（活四/双四 → 封不住，下一手必成五）；
 *   · （仅 VCT）该手造活三且满足 VCT 前提（交由 PVS 交叉复核补强）。
 */
const core = require('../engine/core.js');
const PAT = require('../engine/patterns.js');
const RU = require('../engine/rules.js');
const TH = require('../engine/threat.js');
const SEARCH = require('../engine/search.js');

const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

// 连珠坐标 H8 → {x,y}（列 A-O，行 1-15 自下而上）
function parseCoord(s) {
  const t = String(s).trim().toUpperCase();
  if (!/^[A-O]\d{1,2}$/.test(t)) return null;
  const x = t.charCodeAt(0) - 65;
  const y = 15 - parseInt(t.slice(1), 10);
  if (x < 0 || x >= N || y < 0 || y >= N) return null;
  return { x: x, y: y };
}
// "h8h9i10g8..." → [{x,y}, ...]（列 A-O + 行 1-15，注意 i10 是 3 字符）
function parseSeq(str) {
  const s = String(str).replace(/[\s,;.]+/g, '');
  const toks = s.match(/[A-Oa-o]\d{1,2}/g);
  if (!toks) return null;
  if (toks.join('').length !== s.length) return null;         // 有无法识别的残余
  const out = [];
  for (const t of toks) {
    const p = parseCoord(t);
    if (!p) return null;
    out.push(p);
  }
  return out;
}
const fmt = i => '(' + (i % N) + ',' + ((i / N) | 0) + ')';
const boardOf = stones => {
  const b = new Int8Array(NN);
  for (const s of stones) {
    const i = idxOf(s[0], s[1]);
    if (b[i] !== EMPTY) return null;
    b[i] = s[2];
  }
  return b;
};

function verifyPath(stones, atk, path, opt) {
  const allowOt = !!(opt && opt.allowOpenThree);
  const b = boardOf(stones);
  if (!b) return 'STONES_OVERLAP';
  const def = core.opp(atk);
  const pos = SEARCH.posFromBoard(b, atk);
  if (path.length === 0) return 'EMPTY_PATH';

  const atkFive0 = TH.hasFivePoint(b, atk) >= 0;
  const defFive0 = TH.hasFivePoint(b, def) >= 0;
  if (defFive0 && !atkFive0) return 'DEF_WINS_FIRST';
  if (path.length >= 2 && atkFive0) return 'ATK_ALREADY_HAS_FIVE_POINT';

  for (let k = 0; k < path.length; k++) {
    const i = path[k], x = i % N, y = (i / N) | 0;
    const last = (k === path.length - 1);
    if (pos.board[i] !== EMPTY) return 'OCCUPIED@' + k + fmt(i);
    core.makeMove(pos, x, y, atk);
    const board = pos.board;

    if (RU.isWin(board, x, y, atk)) return last ? 'OK' : 'WIN_TOO_EARLY@' + k;

    const cnt = TH.fivePointsAfter(board, i, atk);
    if (cnt >= 2) return last ? 'OK' : 'SHOULD_HAVE_WON@' + k;
    if (cnt === 1) {
      if (last) return 'PATH_NOT_WIN';
      if (TH.hasFivePoint(board, def) >= 0) return 'DEF_WINS_FIRST@' + k;
      const fp = TH.winningPoints(board, atk);
      if (fp.length !== 1) return 'FORCE_NOT_UNIQUE@' + k + '(n=' + fp.length + ')';
      core.makeMove(pos, fp[0] % N, (fp[0] / N) | 0, def);
      continue;
    }
    if (!allowOt) return 'NOT_FORCING@' + k;
    if (!last) return 'OPEN_THREE_MIDPATH@' + k;
    return 'OK_OPEN_THREE';
  }
  return 'PATH_NOT_WIN';
}

// 求解 + 复算（题库与测试的统一门槛）
function solveAndVerify(stones, atk, opt) {
  const o = opt || {};
  const b = boardOf(stones);
  if (!b) return { ok: false, why: 'STONES_OVERLAP' };
  // ★ A7（§4.5）：useVerify 透传给引擎（默认 false ⇒ 与既有行为一致）
  const vopts = { depth: o.vcfDepth || 20, budget: o.vcfBudget || 300000 };
  if (o.useVerify) vopts.verify = true;
  if (o.rule) vopts.rule = o.rule;
  if (o.overlineMode) vopts.overlineMode = o.overlineMode;
  let r = TH.vcfWin(SEARCH.posFromBoard(b, atk), atk, vopts);
  let verdict = null;
  if (r) verdict = verifyPath(stones, atk, r.path, { allowOpenThree: false });
  if ((!r || verdict !== 'OK') && o.useVct !== false) {
    const vopts2 = { depth: o.vctDepth || 16, budget: o.vctBudget || 200000 };
    if (o.useVerify) vopts2.verify = true;
    if (o.rule) vopts2.rule = o.rule;
    if (o.overlineMode) vopts2.overlineMode = o.overlineMode;
    const r2 = TH.vctWin(SEARCH.posFromBoard(b, atk), atk, vopts2);
    if (r2) {
      const v2 = verifyPath(stones, atk, r2.path, { allowOpenThree: true });
      if (v2 === 'OK' || v2 === 'OK_OPEN_THREE') { r = r2; verdict = v2; }
      else if (!r) { return { ok: false, why: 'VCT_' + v2, path: r2.path }; }
    }
  }
  return { ok: !!r && (verdict === 'OK' || verdict === 'OK_OPEN_THREE'), why: verdict, res: r };
}

module.exports = { parseCoord, parseSeq, fmt, boardOf, verifyPath, solveAndVerify };
