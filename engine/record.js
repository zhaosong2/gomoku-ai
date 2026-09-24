/* engine/record.js — 棋谱：解析 / 校验 / 导出 / 重建（M8）
 * 设计依据：§9 棋谱读取、§9.2 每手属性、§9.4 GameRecord、§27 解析规格
 *  · 纯数据层（无 DOM、无 Canvas）→ 可被 Node 单测、Worker、主线程共用。
 *  · 解析实现复用 book.parseRecord（Renju / 坐标对嗅探 + 0/1 基识别），本模块在其上补：
 *      SGF / Gomocup(TURN x,y) / 自有 JSON / 坐标链降级 / 逐步校验 / 错误定位。
 *  · §27.3 错误码：E_PARSE | E_RANGE | E_OCCUPIED | E_RULE
 */

/* ===== 格式清单（§9.1）===== */
const FMT = {
  AUTO: 'auto',
  JSON: 'json',        // 本应用自有 JSON（GameRecord，完整保留 no/timeMs/comment）
  RENJU: 'renju',      // "1.H8 2.I9 …" / "H8 I9 …"
  XY: 'xy',            // "(7,7) 7,6" / "7 7 7 6"（0/1 基自动）
  SGF: 'sgf',          // 简化 SGF（支持 BL/WL 剩余时间）
  GOMOCUP: 'gomocup',  // "TURN 7,7" 序列
};

/* ===== 错误码（§27.3）===== */
const ERR = {
  E_PARSE: 'E_PARSE', E_RANGE: 'E_RANGE', E_OCCUPIED: 'E_OCCUPIED', E_RULE: 'E_RULE',
};

/* ---------- 工具 ---------- */
function num(v, d) {
  if (v === null || v === undefined || v === '') return d === undefined ? 0 : d;
  const n = Number(v);
  return Number.isFinite(n) ? n : (d === undefined ? 0 : d);
}
function int(v, d) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : (d === undefined ? 0 : d);
}
// 从任意对象里取第一个非空键（容错不同导出器的命名差异）
function pick(o, keys, d) {
  if (!o) return d;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return d;
}

/* ===== 格式嗅探（§27.2）===== */
// 返回 FMT.* ；显式指定时原样返回（非法值回落 AUTO）
function sniff(text) {
  const s = String(text == null ? '' : text);
  const t = s.trim();
  if (!t) return FMT.AUTO;
  if (t[0] === '{' || t[0] === '[') return FMT.JSON;              // 自有 JSON
  if (/\(\s*;|;\s*(GM|FF|SZ)\s*\[/i.test(t)) return FMT.SGF;      // 简化/标准 SGF
  if (/^\s*TURN\s/mi.test(t)) return FMT.GOMOCUP;                 // Gomocup / Piskvork
  if (/[A-Oa-o]\s*\d/.test(t)) return FMT.RENJU;                  // Renju 记谱
  return FMT.XY;                                                  // 坐标对 / 数字序列
}
function resolveFormat(text, fmt) {
  const f = fmt || FMT.AUTO;
  if (f === FMT.AUTO) return sniff(text);
  return f;
}

/* ===== 坐标 ---------- */
// 坐标字符串（导出用）：'H8' 风格；供 §10 HintItem.coord / §27.4 导出
function coordText(x, y) { return String.fromCharCode(65 + x) + (15 - y); }

/* ============================================================
 * 解析：文本 → { ok:true, format, mode, moves:[[x,y]], times, meta }
 *           失败 → { ok:false, error, message, token?, line?, col? }
 * ============================================================ */
function parse(text, opts) {
  const o = opts || {};
  const src = String(text == null ? '' : text);
  const fmt = resolveFormat(src, o.format);
  switch (fmt) {
    case FMT.JSON: return parseJSON(src, o);
    case FMT.SGF: return parseSGF(src, o);
    case FMT.GOMOCUP: return parseGomocup(src, o);
    case FMT.RENJU: return parseRenju(src, o);
    case FMT.XY: return parseXY(src, o);
    default: return fail(ERR.E_PARSE, '无法识别棋谱格式');
  }
}
function fail(error, message, extra) {
  const r = { ok: false, error: error, message: message || '' };
  if (extra) for (const k in extra) if (extra[k] !== undefined) r[k] = extra[k];
  return r;
}
// 定位 token 所在行/列（1 基），供 §27.3 "报行/列"
function locate(src, token) {
  if (!token) return {};
  const at = src.indexOf(token);
  if (at < 0) return {};
  const before = src.slice(0, at);
  const lines = before.split(/\r\n|\r|\n/);
  return { line: lines.length, col: lines[lines.length - 1].length + 1 };
}

/* ---------- JSON（自有 GameRecord）---------- */
function parseJSON(src, o) {
  let obj;
  try { obj = JSON.parse(src); } catch (e) { return fail(ERR.E_PARSE, 'JSON 解析失败：' + String(e.message || e)); }
  if (Array.isArray(obj)) obj = { moves: obj };
  if (!obj || typeof obj !== 'object') return fail(ERR.E_PARSE, 'JSON 顶层应为对象或数组');
  const raw = obj.moves;
  if (!Array.isArray(raw) || !raw.length) return fail(ERR.E_PARSE, 'JSON 缺少非空 moves 数组');
  const moves = [], times = [];
  for (let k = 0; k < raw.length; k++) {
    const m = raw[k];
    let x, y;
    if (Array.isArray(m)) { x = int(m[0], NaN); y = int(m[1], NaN); }
    else if (m && typeof m === 'object') {
      x = int(pick(m, ['x', 'X', 'col'], NaN), NaN); y = int(pick(m, ['y', 'Y', 'row'], NaN), NaN);
      if (!Number.isFinite(x) && m.coord) {                       // 'H8' 形式
        const p = coordFromText(String(m.coord));
        if (p) { x = p.x; y = p.y; }
      } else if (!Number.isFinite(x) && !Number.isFinite(y) && Array.isArray(m.xy)) { x = int(m.xy[0], NaN); y = int(m.xy[1], NaN); }
    } else { return fail(ERR.E_PARSE, 'moves[' + k + '] 格式非法'); }
    if (!Number.isFinite(x) || !Number.isFinite(y)) return fail(ERR.E_PARSE, 'moves[' + k + '] 缺少坐标');
    if (x < 0 || x > 14 || y < 0 || y > 14) return fail(ERR.E_RANGE, 'moves[' + k + '] 坐标越界 (' + x + ',' + y + ')');
    moves.push([x, y]);
    times.push(int(m && m.timeMs, NaN));
  }
  const meta = Object.assign({}, obj.meta || {});
  // 兼容 GameRecord 顶层字段（§9.4）
  for (const k of ['date', 'ruleMode', 'result', 'opening', 'totalMs', 'avgMsPerMove', 'players']) {
    if (obj[k] !== undefined && meta[k] === undefined) meta[k] = obj[k];
  }
  return { ok: true, format: FMT.JSON, mode: 'json', moves: moves, times: times, meta: meta };
}
// 'H8' → {x,y}；非法返回 null
function coordFromText(s) {
  const m = /^([A-Oa-o])(\d{1,2})$/.exec(String(s).trim());
  if (!m) return null;
  const x = m[1].toUpperCase().charCodeAt(0) - 65, row = parseInt(m[2], 10);
  const y = 15 - row;
  if (x < 0 || x > 14 || y < 0 || y > 14) return null;
  return { x: x, y: y };
}

/* ---------- Renju 记谱（含步数前缀 / 用时）---------- */
function parseRenju(src, o) {
  /* 用时标注 `(1.5s)` / `[t=1234]` 先换成占位符 '~'（保住 token 位置），再把秒数按顺序收进 marks。 */
  const marks = [];
  const clean = src.replace(/[（(\[]\s*(?:t\s*=)?\s*(\d+(?:\.\d+)?)\s*s?\s*[)）\]]/gi, function (_all, num) {
    marks.push(Number(num) * 1000);
    return ' ~ ';
  });
  const B = require_book();
  const r = B.parseRecord(clean);
  if (!r.ok) {
    const extra = locate(src, r.token);
    return fail(r.error || ERR.E_PARSE, 'Renju 记谱解析失败' + (r.token ? '：' + r.token : ''), extra.token ? extra : Object.assign({ token: r.token }, extra));
  }
  /* 用时对齐：Renju 惯例是"标注**紧跟它所记的那一手**"（`2.I9(1.5s)` = 第 2 手用时 1.5 s）
   * ⇒ 逐 token 走一遍，遇 '~' 就绑到**刚走过的**那一手。
   * ★ 原实现另有一段"marks ≤ moves 时按第 j 个标注→第 j 手再覆盖一遍"，它会把同一个用时
   *   同时记到前一手（实测 `1.H8 2.I9(1.5s)` 变成 times[0]=times[1]=1500）；已删。 */
  const toks = clean.replace(/[().,;、\t\r\n]+/g, ' ').split(/\s+/).filter(function (t) { return /[A-Za-z]/.test(t) || t === '~'; });
  const times = new Array(r.moves.length).fill(NaN);
  let mi = 0, mv = -1;
  for (let k = 0; k < toks.length; k++) {
    if (toks[k] === '~') { if (mv >= 0 && mi < marks.length) times[mv] = marks[mi]; mi++; }
    else mv++;
  }
  return { ok: true, format: FMT.RENJU, mode: 'renju', moves: r.moves, times: times, meta: {} };
}

/* ---------- 坐标对 ---------- */
function parseXY(src, o) {
  const B = require_book();
  const r = B.parseRecord(src);
  if (!r.ok) {
    const extra = locate(src, r.token);
    return fail(r.error || ERR.E_PARSE, '坐标解析失败' + (r.token ? '：' + r.token : ''), Object.assign({ token: r.token }, extra));
  }
  return { ok: true, format: FMT.XY, mode: 'xy', moves: r.moves, times: [], meta: {} };
}

/* ---------- Gomocup / Piskvork ---------- */
// ★ Gomocup/Piskvork 规范：坐标**固定 0 基**（见 Gomocup 协议 `TURN x,y`，x,y ∈ 0..14）。
//   不能交给 book.parseRecord 的"0/1 基嗅探"——若整盘恰好没出现 0，会被误判为 1 基而整体 +1。
function parseGomocup(src, o) {
  const out = [];
  const re = /^\s*TURN\s+(-?\d+)\s*,\s*(-?\d+)/gim;
  let m;
  while ((m = re.exec(src))) {
    const x = int(m[1], NaN), y = int(m[2], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < 0 || x > 14 || y < 0 || y > 14) {
      const extra = locate(src, 'TURN ' + m[1] + ',' + m[2]);
      return fail(ERR.E_RANGE, 'TURN 坐标越界 (' + x + ',' + y + ')', extra);
    }
    out.push([x, y]);
  }
  if (!out.length) return fail(ERR.E_PARSE, '未找到合法的 TURN x,y 记录');
  return { ok: true, format: FMT.GOMOCUP, mode: 'gomocup', moves: out, times: [], meta: {} };
}

/* ---------- 简化 SGF ---------- */
function parseSGF(src, o) {
  const s = String(src);
  // 属性提取：KEY[value]（支持转义 \] ）
  function props(key) {
    const re = new RegExp(key + '\\s*\\[((?:\\\\.|[^\\]])*)\\]', 'g');
    const out = [];
    let m;
    while ((m = re.exec(s))) out.push(m[1].replace(/\\(.)/g, '$1'));
    return out;
  }
  const sz = props('SZ')[0];
  if (sz && int(sz, 15) !== 15) return fail(ERR.E_RANGE, '仅支持 15×15 棋盘（SZ=' + sz + '）');

  // 着法序列：B[xx] / W[xx]（属性名必须**恰好**是 B 或 W；
  // ★ 不能用 A?[BW] —— 那会把 BL/WL/PB/PW/AB/AW 一起吞掉，也会错切 `]B[` 相邻串）
  const seq = [];
  const re = /(?:^|[^A-Za-z])([BW])\s*((?:\[[^\]]*\])+)/g;
  const reB = /\[((?:\\.|[^\\])*)\]/g;
  let m;
  while ((m = re.exec(s))) {
    const key = m[1];
    let v;
    reB.lastIndex = 0;
    const vals = [];
    while ((v = reB.exec(m[2]))) vals.push(v[1]);
    if (vals.length) seq.push({ player: key, v: vals[0] });
  }
  const moves = [], times = [];
  for (let k = 0; k < seq.length; k++) {
    const v = seq[k].v;
    if (v === '' || v === 'tt' || v === 'pass') continue;        // pass（SGF 惯例：tt / 空）
    const p = sgfPoint(v);
    if (!p) return fail(ERR.E_PARSE, 'SGF 着法坐标非法：' + v);
    moves.push([p.x, p.y]);
    const t = sgfTimeOf(props(k % 2 === 0 ? 'BL' : 'WL'), k);
    times.push(t);
  }
  if (!moves.length) return fail(ERR.E_PARSE, 'SGF 中未找到着法');
  const meta = {};
  const dt = props('DT')[0]; if (dt) meta.date = dt;
  const pb = props('PB')[0], pw = props('PW')[0];
  if (pb || pw) meta.players = { black: pb || '?', white: pw || '?' };
  const ev = props('EV')[0] || props('GN')[0]; if (ev) meta.opening = ev;
  const re2 = props('RE')[0];
  if (re2) {
    const c = re2.trim().charAt(0).toUpperCase();
    meta.result = c === 'B' ? 'B' : (c === 'W' ? 'W' : (c === '0' || c === 'D' ? 'draw' : '?'));
  }
  return { ok: true, format: FMT.SGF, mode: 'sgf', moves: moves, times: times, meta: meta };
}
// SGF 坐标：两字母 a–o（列, 行自上而下）→ (x,y)
function sgfPoint(v) {
  const s = String(v).replace(/\s+/g, '');
  if (s.length < 2) return null;
  const x = s.toLowerCase().charCodeAt(0) - 97;
  const r = s.toLowerCase().charCodeAt(1) - 97;
  if (x < 0 || x > 14 || r < 0 || r > 14) return null;
  return { x: x, y: 14 - r };
}
// BL/WL 值可能是 "1234.56"（秒）或 "1234"（秒）；取第 idx/2 项（每方一条序列）
function sgfTimeOf(list, idx) {
  if (!list || !list.length) return NaN;
  const v = list[Math.min(list.length - 1, idx >> 1)] || list[list.length - 1];
  const f = parseFloat(v);
  return Number.isFinite(f) ? Math.round(f * 1000) : NaN;
}

/* book.js 延迟加载（浏览器走 G.book；避免 Node 顶层循环依赖） */
let _book = null;
function require_book() {
  if (_book) return _book;
  if (typeof require === 'function') { try { _book = require('./book.js'); } catch (e) { /* ignore */ } }
  if (!_book && typeof globalThis !== 'undefined' && globalThis.G && globalThis.G.book) _book = globalThis.G.book;
  if (!_book) throw new Error('record.js 需要 book.js');
  return _book;
}
function setBook(b) { _book = b; }

/* ============================================================
 * 逐步校验：把 moves 铺到棋盘上，产出每手对象 + 错误清单
 * （§27.3 E_OCCUPIED / E_RULE；§9.2 no/player/timeMs）
 * opts.strict = true → 遇错即停；默认 false → 记录错误并**跳过该手**继续
 * ============================================================ */
function buildMoves(flat, opts) {
  const o = opts || {};
  const rule = o.rule || 'freestyle';
  const om = o.overlineMode || 'rif';
  const C = core_();
  const RULES = rules_();
  let pos = C.createPosition();
  const moves = [], errors = [];
  const times = o.times || [];
  for (let k = 0; k < flat.length; k++) {
    const x = flat[k][0], y = flat[k][1];
    if (x < 0 || x > 14 || y < 0 || y > 14) {
      errors.push({ index: k, no: k + 1, error: ERR.E_RANGE, x: x, y: y, message: '坐标越界' });
      if (o.strict) break;
      pos.stm = C.opp(pos.stm);        // ★ 跳过的手仍要翻手番：否则其后每一手的颜色都与棋谱相反
      continue;
    }
    const i = C.idxOf(x, y);
    if (pos.board[i] !== C.EMPTY) {
      errors.push({ index: k, no: k + 1, error: ERR.E_OCCUPIED, x: x, y: y, coord: coordText(x, y), message: '该点已被占用' });
      if (o.strict) break;
      pos.stm = C.opp(pos.stm);        // ★ 同上
      continue;
    }
    const player = pos.stm;
    C.makeMove(pos, x, y, player);
    const verdict = RULES.judge(pos.board, x, y, player, rule, om);
    const mv = {
      no: moves.length + 1, x: x, y: y, player: player,
      timeMs: Number.isFinite(times[k]) ? times[k] : NaN,
      verdict: verdict,
    };
    if (verdict === LOSE_SENTINEL) {
      errors.push({ index: k, no: mv.no, error: ERR.E_RULE, x: x, y: y, coord: coordText(x, y),
                    message: 'Renju 黑棋禁手步（' + (o.overlineMode === 'strict' ? 'strict' : 'rif') + '）' });
    }
    moves.push(mv);
    /* 终局即止。禁手步默认也止（与历史行为一致）；`stopOnRule:false` 才继续导入以便复盘
     * —— 原实现这里**无条件** break，使 §27.3 的 `stopOnRule` 成为一个永不生效的选项。 */
    if (verdict === 'win' || (verdict === LOSE_SENTINEL && o.stopOnRule !== false)) break;
  }
  return { pos: pos, moves: moves, errors: errors,
           hasWin: moves.some(m => m.verdict === 'win'),
           hasForbidden: errors.some(e => e.error === ERR.E_RULE) };
}
const LOSE_SENTINEL = 'lose';

let _core = null, _rules = null;
function core_() {
  if (_core) return _core;
  if (typeof require === 'function') { try { _core = require('./core.js'); } catch (e) {} }
  if (!_core && globalThis.G && globalThis.G.core) _core = globalThis.G.core;
  return _core;
}
function rules_() {
  if (_rules) return _rules;
  if (typeof require === 'function') { try { _rules = require('./rules.js'); } catch (e) {} }
  if (!_rules && globalThis.G && globalThis.G.rules) _rules = globalThis.G.rules;
  return _rules;
}
function setCore(c, r) { _core = c; _rules = r; }

/* ============================================================
 * 记录：moves[] → GameRecord（§9.4）
 * ============================================================ */
// flat：[[x,y]]；times：与 flat 等长（可含 NaN）；info：{ruleMode,result,date,players,opening}
function build(flat, times, info, opts) {
  const o = opts || {};
  const t = times || [];
  const mv = buildMoves(flat, { rule: (info && info.ruleMode) || o.rule || 'freestyle', times: t,
                                overlineMode: o.overlineMode, strict: o.strict, stopOnRule: o.stopOnRule });
  const moves = mv.moves.map(function (m, k) {
    const r = { no: m.no, x: m.x, y: m.y, player: m.player, timeMs: Number.isFinite(t[k]) ? t[k] : 0 };
    if (m.verdict !== 'none') r.verdict = m.verdict;
    return r;
  });
  const rec = {
    format: o.format || 'json',
    ruleMode: (info && info.ruleMode) || o.rule || 'freestyle',
    result: (info && info.result) || resultOf(mv),
    meta: Object.assign({ date: '', players: { black: '', white: '' } }, (info && info.meta) || {}),
    moves: moves,
    board: mv.pos.board.slice(),          // 终局棋盘（§9.4 回放重建）
    errors: mv.errors,
  };
  const players = (info && info.players) || rec.meta.players;
  if (players) rec.meta.players = { black: players.black || '', white: players.white || '' };
  if (info && info.opening) rec.meta.opening = info.opening;
  computeTimes(rec);
  return rec;
}
function resultOf(mv) {
  for (const m of mv.moves) if (m.verdict === 'win') return m.player === 1 ? 'B' : 'W';
  if (mv.errors.some(e => e.error === ERR.E_RULE)) {
    const e = mv.errors.find(e => e.error === ERR.E_RULE);
    return e && mv.moves[e.no - 1] ? (mv.moves[e.no - 1].player === 1 ? 'W' : 'B') : '?';
  }
  return '?';
}
// §9.2 全局时间统计：totalMs / avgMsPerMove / 每手 clockMs（棋钟模式）
// 只对 build() 产物（对象带 timeMs/player）有完整语义；parse() 的元组产物无用时字段，
// 但结果仍是一组合法数字（0），不会写出 NaN。
function computeTimes(rec) {
  const mv = (rec && rec.moves) || [];
  let total = 0, n = 0;
  const clock = { 1: 0, 2: 0 };
  const totalMs = num(rec.meta.totalMs, 0);
  for (let k = 0; k < mv.length; k++) {
    const raw = mv[k];
    if (Array.isArray(raw)) continue;                 // 元组形态：无 per-move 用时
    const t = num(raw.timeMs, 0);
    if (t > 0) { total += t; n++; }
    const pl = (raw.player === 1 || raw.player === 2) ? raw.player : (k % 2 === 0 ? 1 : 2);
    if (totalMs > 0) { clock[pl] += t; raw.clockMs = Math.max(0, totalMs - clock[pl]); }
  }
  rec.meta.totalMs = totalMs > 0 ? totalMs : total;
  rec.meta.avgMsPerMove = mv.length ? Math.round(rec.meta.totalMs / mv.length) : 0;
  return rec;
}

/* ============================================================
 * 导出（§27.4）
 * ============================================================ */
function toJSON(rec) {
  return JSON.stringify(rec, function (k, v) {
    if (k === 'board' && v && v.length) return Array.from(v);   // Int8Array → 数组
    if (k === 'errors' && Array.isArray(v) && !v.length) return undefined;
    if (v === null || (typeof v === 'number' && !Number.isFinite(v))) return undefined;
    return v;
  }, 2);
}
// 把 rec.moves 规整成对象序列（统一 parse 元组 / build 对象两种形态）。
// ★ 所有导出函数都必须经此函数取手——直接用 m.x/m.player 会在 parse() 产物上得到
//   undefined（SGF 会写出 \u0000、Gomocup 会写出 "undefined,undefined"，见 §30 事故记录）。
function normMoves(rec) {
  const out = [];
  const n = (rec && rec.moves) ? rec.moves.length : 0;
  for (let k = 0; k < n; k++) { const m = moveAt(rec, k); if (m) out.push(m); }
  return out;
}
function toRenju(rec, opts) {
  const o = opts || {};
  return normMoves(rec).map(function (m) {
    return (o.numbered === false ? '' : (m.no + '.')) + coordText(m.x, m.y);
  }).join(o.sep === undefined ? ' ' : o.sep);
}
function toXY(rec, opts) {
  const o = opts || {};
  const one = o.oneBased !== false;                              // §27 默认 1 基
  return normMoves(rec).map(function (m) { return (m.x + (one ? 1 : 0)) + ',' + (m.y + (one ? 1 : 0)); }).join(' ');
}
function toSGF(rec, opts) {
  const o = opts || {};
  const meta = rec.meta || {};
  let s = '(;GM[1]FF[4]CA[UTF-8]SZ[15]';
  if (meta.date) s += 'DT[' + meta.date + ']';
  if (meta.players && meta.players.black) s += 'PB[' + meta.players.black + ']';
  if (meta.players && meta.players.white) s += 'PW[' + meta.players.white + ']';
  if (meta.opening) s += 'GN[' + meta.opening + ']';
  s += 'RE[' + (rec.result === 'B' ? 'B+' : rec.result === 'W' ? 'W+' : '0') + ']';
  s += 'RU[' + (rec.ruleMode === 'renju' ? 'Renju' : 'Freestyle') + ']';
  for (const m of normMoves(rec)) {
    s += ';' + (m.player === 1 ? 'B' : 'W') + '[' + String.fromCharCode(97 + m.x) + String.fromCharCode(97 + (14 - m.y)) + ']';
    if (m.timeMs > 0 && o.time !== false) s += (m.player === 1 ? 'BL' : 'WL') + '[' + (m.timeMs / 1000).toFixed(1) + ']';
  }
  return s + ')';
}
function toGomocup(rec) {
  return normMoves(rec).map(function (m) { return 'TURN ' + m.x + ',' + m.y; }).join('\n');
}
// 统一导出入口：fmt ∈ FMT.*
function exportRecord(rec, fmt, opts) {
  switch (fmt) {
    case FMT.RENJU: return toRenju(rec, opts);
    case FMT.XY: return toXY(rec, opts);
    case FMT.SGF: return toSGF(rec, opts);
    case FMT.GOMOCUP: return toGomocup(rec);
    default: return toJSON(rec);
  }
}

/* ============================================================
 * 回放视图（§9.3）：任意步重建棋盘 + 步数徽标数据
 * ============================================================ */
// 取第 k 手的 {x,y,player,no,timeMs}。
// ★ 两种输入形态都要支持（工程陷阱，实测踩到）：
//   · `build()` 的产物：moves[k] = { no, x, y, player, timeMs, verdict? }
//   · `parse()` 的产物：moves[k] = [x, y]  ← 纯坐标对，无 player/no；用时在**旁路** rec.times[k]
//   只认其中一种会让 viewAt 对另一种静默返回空盘、导出写出 `undefined` / `\u0000`
//   （曾据此误判为"回放坏了"）。player 缺省时按"黑先、双方交替"推；no 缺省时取 k+1。
function moveAt(rec, k) {
  const raw = rec.moves[k];
  if (raw == null) return null;
  const times = rec.times;                     // parse() 把用时放在**旁路数组** rec.times[k]
  const pt = times && Number.isFinite(times[k]) ? times[k] : 0;
  if (Array.isArray(raw)) {
    return { x: raw[0], y: raw[1], player: (k % 2 === 0 ? 1 : 2), no: k + 1, timeMs: pt };
  }
  const player = (raw.player === 1 || raw.player === 2)
    ? raw.player : (k % 2 === 0 ? 1 : 2);
  const t = Number.isFinite(raw.timeMs) && raw.timeMs > 0 ? raw.timeMs : pt;
  return { x: raw.x, y: raw.y, player: player, no: Number.isFinite(raw.no) ? raw.no : k + 1, timeMs: t };
}
// 返回 { board, ply, lastMove, order, over, winner, winLine, current }
function viewAt(rec, ply, opts) {
  const o = opts || {};
  const C = core_(), RULES = rules_();
  const n = Math.max(0, Math.min(ply === undefined ? rec.moves.length : (ply | 0), rec.moves.length));
  const board = new Int8Array(C.NN);
  const order = new Int16Array(C.NN);
  let over = false, winner = 0, winLine = null, lastMove = null;
  const rule = rec.ruleMode || o.rule || 'freestyle';
  const om = o.overlineMode || 'rif';
  for (let k = 0; k < n; k++) {
    const m = moveAt(rec, k);
    if (!m) break;
    // ★ 越界/NaN 防御：`idxOf(undefined,…)`=NaN 被静默忽略；越界 x 还会落到**相邻行**
    //   （x=20,y=0 ⇒ idx=20 = 下一行 A 列）⇒ 复盘盘面悄悄错位。buildMoves 已挡住，
    //   这里是读取端最后一道（外部传入 / 手工编辑的 record 也走这里）。
    if (!(m.x >= 0 && m.x < 15 && m.y >= 0 && m.y < 15)) break;
    board[C.idxOf(m.x, m.y)] = m.player;
    order[C.idxOf(m.x, m.y)] = m.no;
    lastMove = { x: m.x, y: m.y };
    const v = RULES.judge(board, m.x, m.y, m.player, rule, om);
    if (v === LOSE_SENTINEL) { over = true; winner = C.opp(m.player); winLine = null; }
    else if (v === 'win') { over = true; winner = m.player; winLine = RULES.winningLine(board, m.x, m.y, m.player, rule); }
  }
  return { board: board, ply: n, lastMove: lastMove, order: order,
           over: over, winner: winner, winLine: winLine, current: rec.moves[n] || null };
}
// 回放顺序：首/末/上/下（供 UI 直接读；不在此处持有状态）
function stepPly(rec, ply, delta) {
  const n = rec.moves.length;
  const p = ply === undefined ? 0 : ply;
  return Math.max(0, Math.min(n, p + delta));
}

/* ============================================================
 * 从当前对局导出（供主线程交互层调用的便捷包装）
 * history：[{x,y,player,no,timeMs?}] → GameRecord
 * ============================================================ */
function fromHistory(history, info) {
  const i = info || {};
  const flat = history.map(function (m) { return [m.x, m.y]; });
  const times = history.map(function (m) { return Number.isFinite(m.timeMs) ? m.timeMs : NaN; });
  const rec = build(flat, times, {
    ruleMode: i.ruleMode || 'freestyle',
    result: i.result || resultFromHistory(history, i),
    meta: { date: i.date || '', players: i.players || { black: '', white: '' } },
    opening: i.opening || '',
  }, { rule: i.ruleMode || 'freestyle', overlineMode: i.overlineMode });
  for (let k = 0; k < rec.moves.length && k < history.length; k++) {
    if (history[k].comment) rec.moves[k].comment = history[k].comment;
  }
  return rec;
}
function resultFromHistory(history, info) {
  const rule = (info && info.ruleMode) || 'freestyle';
  const C = core_(), RULES = rules_();
  const board = new Int8Array(C.NN);
  const om = (info && info.overlineMode) || 'rif';
  for (const m of history) {
    board[C.idxOf(m.x, m.y)] = m.player;
    const v = RULES.judge(board, m.x, m.y, m.player, rule, om);
    if (v === 'win') return m.player === 1 ? 'B' : 'W';
    if (v === LOSE_SENTINEL) return m.player === 1 ? 'W' : 'B';
  }
  return '?';
}

/* ========== 导出 ========== */
const API = {
  FMT: FMT, ERR: ERR,
  sniff: sniff, resolveFormat: resolveFormat, coordText: coordText, coordFromText: coordFromText,
  parse: parse, buildMoves: buildMoves, build: build, computeTimes: computeTimes,
  toJSON: toJSON, toRenju: toRenju, toXY: toXY, toSGF: toSGF, toGomocup: toGomocup, exportRecord: exportRecord,
  viewAt: viewAt, stepPly: stepPly, moveAt: moveAt,
  fromHistory: fromHistory, resultOf: resultOf,
  setBook: setBook, setCore: setCore,
};
if (typeof module !== 'undefined' && module.exports) module.exports = API;
else { (globalThis.G = globalThis.G || {}).record = API; }
