/* tools/import-mates.js — 从真实棋谱数据中**提取并机器验证**杀棋题
 *
 * 题源：连珠小站（爱五子棋网）VCF 习题帖 https://iwzq.renjucaffe.com/thread/7501.html
 *   帖内每题给出两组数据：
 *     ① 坐标串（形如 h8h9i10g8...）—— 注意这是**图面扫描顺序**，不是对局顺序；
 *     ② 每位棋子对应的手数编号 —— 用它排序才得到真正的落子顺序。
 *
 * 提取方法（不信任题源，只信任证明）：
 *   1) 按手数编号重排 → 重放对局；
 *   2) 从最早的位置起试：该位置轮到胜方、双方均无成五点（排除"一步杀"与"对方先胜"）；
 *   3) 求解器求 VCF，再用**独立复算器**验证路径；通过则收录（取最早位置 = 最长链）。
 */
const core = require('../engine/core.js');
const TH = require('../engine/threat.js');
const S = require('../engine/search.js');
const V = require('./verify-mate.js');
const fs = require('fs');
const path = require('path');
const { N, NN, EMPTY, BLACK, WHITE, idxOf } = core;

const URL = 'https://iwzq.renjucaffe.com/thread/7501.html';
const SOURCES = [
  { id: 'renjucaffe-p1', label: 'VCF 习题#1', url: URL,
    seq: 'h8h9h7h6i10g8f7g7f8g9g10f9e9g6g5i6j6i8j7j8k8f10f11e10e11d11c12f12c10c11b10d8c8d7e8e7d5',
    nums: [27, 28, 30, 26, 25, 23, 31, 29, 24, 22, 11, 5, 13, 12, 10, 2, 33, 32, 35, 9, 6, 1, 18, 20, 21, 34, 36, 7, 8, 3, 19, 14, 4, 16, 17, 37, 15] },
  { id: 'renjucaffe-p2', label: 'VCF 习题#2', url: URL,
    seq: 'h8h9i8h7i7g8f9i10f7i9j9j8k7j7h6i6j5j6l5k6h5i5g6e8f6e6g10e10f4i12',
    nums: [30, 28, 27, 8, 7, 2, 10, 11, 24, 6, 1, 3, 12, 9, 4, 5, 14, 13, 26, 25, 23, 15, 16, 18, 20, 21, 22, 17, 19, 29] },
  { id: 'renjucaffe-p3', label: 'VCF 习题#3（长）', url: URL,
    seq: 'h8h9h7h6i10g8f7g7f8g9g10f9e9g6g5i6j6i8j7j8k8f10f11e10e11d11c12f12c10c11b10d8c8d7e8e7d5i9j9i7i5l10k9h10g11l6',
    nums: [27, 28, 30, 26, 25, 23, 45, 31, 29, 24, 22, 11, 44, 5, 42, 13, 12, 10, 2, 38, 39, 43, 33, 32, 35, 9, 6, 1, 18, 20, 21, 34, 36, 7, 8, 3, 40, 19, 14, 4, 16, 17, 46, 37, 15, 41] },
  { id: 'renjucaffe-p4', label: 'VCF 习题#4（长）', url: URL,
    seq: 'h8h9i8h7i7g8f9i10f7i9j9j8k7j7h6i6j5j6l5k6h5i5g6e8f6e6g10e10f4i12f5f3g5e3e5d5g7d4g4g3i4',
    nums: [30, 28, 27, 8, 7, 2, 10, 11, 24, 6, 1, 3, 12, 9, 37, 4, 5, 14, 13, 26, 25, 23, 15, 16, 18, 20, 36, 35, 31, 33, 21, 22, 17, 19, 38, 29, 39, 41, 34, 32, 40] },
];

// 按手数编号重排 → 得到对局顺序
function orderByNumber(seq, nums) {
  const pts = V.parseSeq(seq);
  if (!pts || !nums || pts.length !== nums.length) return null;
  const seen = new Uint8Array(pts.length + 1);
  for (const n of nums) { if (n < 1 || n > pts.length || seen[n]) return null; seen[n] = 1; }
  const out = new Array(pts.length);
  for (let i = 0; i < pts.length; i++) out[nums[i] - 1] = pts[i];
  return out;
}

function replay(points, first) {
  const stones = [];
  let p = first;
  for (const q of points) { stones.push([q.x, q.y, p]); p = core.opp(p); }
  return stones;
}

const found = [];
const rejected = [];
for (const src of SOURCES) {
  const ordered = orderByNumber(src.seq, src.nums);
  if (!ordered) { console.log('!! 数据不合法: ' + src.id); continue; }
  // 定第一手颜色：末手必须成五
  let stones = null, winner = 0;
  for (const first of [BLACK, WHITE]) {
    const st = replay(ordered, first);
    const last = st[st.length - 1];
    const b = new Int8Array(NN);
    for (const s of st) b[idxOf(s[0], s[1])] = s[2];
    if (core.inBoard(last[0], last[1]) && require('../engine/rules.js').isWin(b, last[0], last[1], last[2])) {
      stones = st; winner = last[2]; break;
    }
  }
  if (!stones) { console.log('!! 无法确定首手颜色/末手不成五: ' + src.id); continue; }
  console.log('\n[' + src.id + '] ' + src.label + ' 手数=' + stones.length +
    ' 末手=' + (winner === BLACK ? '黑' : '白') + ' 胜');

  let picked = null;
  for (let M = 1; M < stones.length - 1; M++) {
    const st = stones.slice(0, M);
    if (stones[M][2] !== winner) continue;
    const b = new Int8Array(NN);
    let bad = false;
    for (const s of st) { const i = idxOf(s[0], s[1]); if (b[i]) { bad = true; break; } b[i] = s[2]; }
    if (bad) continue;
    if (TH.hasFivePoint(b, winner) >= 0) continue;            // 一步杀，跳过
    if (TH.hasFivePoint(b, core.opp(winner)) >= 0) continue;  // 对方先胜
    const r = TH.vcfWin(S.posFromBoard(b, winner), winner, { depth: 30, budget: 400000 });
    if (!r || r.plies < 2) continue;
    const verdict = V.verifyPath(st, winner, r.path, { allowOpenThree: false });
    if (verdict !== 'OK') continue;
    // 棋谱自身后续的攻方着手（用于确认题源自洽）
    const gameAtk = [];
    for (let k = M; k < stones.length; k += 2) gameAtk.push(idxOf(stones[k][0], stones[k][1]));
    const same = r.path.length === gameAtk.length && r.path.every((v, k) => v === gameAtk[k]);
    picked = { M, stones: st.map(s => s.slice()), atk: winner, path: r.path, plies: r.plies, same };
    break;
  }
  if (!picked) { console.log('  未提取（freestyle 下不成立，可能依赖禁手规则）'); rejected.push(src.id); continue; }
  console.log('  提取成功：起始手数=' + picked.M + '（棋盘 ' + picked.stones.length + ' 子）链长=' + picked.plies +
    ' 与棋谱解一致=' + picked.same);
  console.log('  path=' + JSON.stringify(picked.path.map(V.fmt)));
  found.push({ id: src.id, label: src.label, url: src.url, ...picked });
}

console.log('\n=== 汇总：提取 ' + found.length + ' 题，未提取 ' + rejected.length + ' 题 ===');
for (const f of found) console.log('  ' + f.id + ' plies=' + f.plies + ' 子数=' + f.stones.length + ' 源一致=' + f.same);
fs.writeFileSync(path.join(__dirname, '_extracted.json'), JSON.stringify(found, null, 1), 'utf8');
console.log('已写 tools/_extracted.json');
