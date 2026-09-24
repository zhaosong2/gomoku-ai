# 五子棋引擎技术设计（DESIGN）

> 本文件是引擎的**结构化技术规格**，与 `engine/` 代码逐模块对应。过程记录、基准日志、里程碑叙事不在此文档内。

---

## 1. 概览

零依赖、浏览器优先的 **Gomoku（五子棋）/ Renju** 引擎，包含完整 AI 对战、提示、形势判断、棋谱库与回放。

- **规则**：`freestyle`（无禁手，长连算胜）、`renju`（RIF 有禁手：黑棋长连 / 四四 / 三三判负，恰好五连优先）。
- **运行环境**：浏览器（经典 `<script>` + Blob Worker）与 Node（CommonJS 单测 / 工具）双目标。
- **产物**：单文件 `gomoku.html` 可 `file://` 直开；`engine/` 源码经 `tools/build-worker-src.js` 打包成 Worker 源码。
- **规模**：`engine/` 21 文件、`ui/` 9 文件、`tools/` 31 文件、`test/` 27 文件；309 项 Node 单测全绿。

### 1.1 顶层模块图

```
engine/                纯算法层（无 DOM，UMD 双环境）
  core.js              棋盘状态 / 落子 / Zobrist
  rules.js             胜负裁决 / 禁手
  patterns.js          棋型识别 / 评分表 / 增量缓存
  eval.js              候选点 / 着法评分 / 静态评估
  search.js            Negamax+PVS+迭代加深 / 置换表 / 威胁 / 开局库调度
  threat.js            VCF/VCT 威胁空间搜索（sound）
  operators.js         威胁枚举算子化（与 threat.js 等价）
  book.js              开局库格式/索引/前缀树查询/棋谱解析
  record.js            棋谱数据层（解析/校验/导出/重建）
  coach.js             提示/形势/热力图（人读层）
  worker-entry.js      Worker 消息路由
  data/                开局库树、棋谱库、杀题库、对称表
ui/                    浏览器交互层（依赖 window.G.*）
  ai.js                Worker 客户端 + 请求调度
  main.js              状态机 / 偏好持久化 / 锁定
  render.js            Canvas 渲染 + 叠加层 + 动画
  panels/menu/prefs/touch/booklib/record.js
tools/                 构建、基准、生成器、验证脚本
test/                  node:test 单测 + positions40.json 等数据
```

---

## 2. 运行环境与模块系统

所有 `engine/` 与 `ui/` 模块统一为 UMD 包裹：

```js
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./core.js'), ...);
  else { root.G = root.G || {}; root.G.xxx = factory(root.G.core, ...); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core /* deps */) { ... });
```

- 浏览器：挂到全局 `window.G`（命名空间 `G.core` / `G.rules` / `G.search` …）。
- Node：走 `require`，供单测与工具直接调用。
- 依赖顺序由加载顺序保证（见 `index.html` 与 `build-worker-src.js` 的 `FILES`）。

### 2.1 构建

| 命令 | 输入 | 输出 | 说明 |
|------|------|------|------|
| `node build.mjs` | `index.html` | `gomoku.html` | 把每个 `<script src>` 内联为经典 `<script>`，结果单文件、零网络依赖 |
| `node tools/build-worker-src.js` | `engine/*.js` | `engine/worker-src.js` | 拼成一段源码字符串挂 `G.WORKER_SRC` + `G.WORKER_SRC_HASH`（SHA1 前 16 位） |

- 产物纪律：构建脚本**只做文本合并**，不改语义；`gomoku.html` 改写后须重跑浏览器实跑（沙箱外 CDP）。
- `engine/worker-src.js` 体积上限 **208 KB**（实测 ~202 KB）。`book-lines.js` 已退出产物，由 `book-tree.js`（前缀树，~29 KB）覆盖。

### 2.2 脚本加载顺序（`index.html`）

```
engine/core → patterns → rules → eval → threat → operators → data/openings →
  data/book-tree → data/book-lines → data/book-games → book → search → record →
  coach → worker-src
ui/menu → render → touch → ai → prefs → booklib → record → panels → main
```

约束：`book.js` 必须在 `search.js` 之前（`think()` 查开局库）；`data/openings.js` 必须进产物（`book.js` 解析 Renju 记谱用 `OP.R`）。

---

## 3. 核心数据模型（`engine/core.js`）

- 棋盘：`Int8Array(225)`（15×15），`EMPTY=0 / BLACK=1 / WHITE=2`。
- 坐标：`idxOf(x,y)=y*15+x`；`xOf/yOf` 反解。方向 `DIRS=[[1,0],[0,1],[1,1],[1,-1]]`（→ ↓ ↘ ↙）。
- **坐标记号**（Renju 风格，仅供展示/棋谱）：`coordText(x,y)=String.fromCharCode(65+x)+(15-y)`。天元 `(7,7)` → `H8`。

**局面对象 `createPosition()`**：
```
{ board, stm, stones, zobHi, zobLo, hist[],
  lc: null,            // 增量线分缓存（§5.4）
  material: null,      // 增量材料表（§5.5）
  assertIncr: null }   // 自检钩子（默认关）
```

**落子 / 悔棋**：
- `makeMove(pos,x,y,player)`：`board[i]=player`、`stones++`、翻转 `ZOB.turn`、推入 `hist`、更新 Zobrist（`xorZob`）。落子前后触发 `notifyCell(pos,i,phase)`（`'pre'` / `'post'` 两相）。
- `unmakeMove(pos)`：对称撤销，先发 `'pre'` 再弹 `hist` 再发 `'post'`。
- 增量结构（线分 / 材料）靠 `pos.onCell` 钩子在两相各读一次取差；`core` 不持有具体缓存逻辑，只约定 `phase` 语义。

**Zobrist**：种子 `20260918`，种子化 PRNG（`mulberry32`）生成双 `uint32` 表（每格每方 2 个 + 手番 2 个）。用双 `uint32` 而非 `BigInt`（避免 64 位开销）。

---

## 4. 规则引擎（`engine/rules.js`）

两条铁律：**① AI 决策不调用本模块**（禁手由评分表的 `−1e9` 表达，见 §5）；**② 裁决与评分同一口径**（都基于 `patterns.forbiddenCore`）。因此不会出现"AI 以为合法、裁决判负"的不一致。

| 规则 | 胜条件 | 禁手 |
|------|--------|------|
| `freestyle` | 任一方 `maxRun>=5`（长连算胜） | 无 |
| `renju`（RIF） | 白 `>=5`；黑**恰好五连**（`countExactFives>0`） | 黑长连(≥6)/四四/三三 → 负 |
| `renju` + `overlineMode:'strict'` | 同 RIF | 长连一律负（含五长连） |

- **恰好五连优先**：黑棋同时成"恰好五连"与任一禁手时判黑胜（`judge()` 先查 `countExactFives`）。
- `isForbidden(board,idx,rule,overlineMode)`：返回禁手等级（`L.OVERLINE/DOUBLE_FOUR/DOUBLE_THREE`），供 UI 标红 / 复盘校验。
- `winningLine(board,x,y,player,rule)`：返回获胜连线坐标（高亮用）。

---

## 5. 棋型识别与评分表（`engine/patterns.js`）

### 5.1 类型

- 单棋型 `P`：`NONE / SLEEP_TWO / OPEN_TWO / SLEEP_THREE / OPEN_THREE / FOUR / OPEN_FOUR / FIVE / OVERLINE`。
- 组合等级 `L`（数值越大越强，便于比较）：`DEAD → SLEEP_TWO → OPEN_TWO → … → FOUR_THREE → DOUBLE_FOUR → OPEN_FOUR → WIN`。
- `decideOf(a,b,c,d,mode)`：四方向单棋型直接定级（freestyle/白棋一条路径；renju-黑 `mode>0` 一条路径，禁手语境下长连/四四/三三对应禁手等级）。

### 5.2 两套识别

- **点式窗口分类** `classifyWindow`/`classifyAt`：以落点为中心半径 4 的窗口串（`.`/o/x），含跳型（活三→两步成活四等）。结果 `MEMO` 化。用于着法级威胁判定。
- **整数编码热路径**（零分配）：`codeAt(board,idx,dir,player)` 把过 `idx` 的 9 格窗口三进制编码（中心恒为 1，空格 0 / 我方 1 / 阻挡 2），查 `WCLS` 表（19683 项，惰性填充）。`classifyIdx`/`dirsAt` 在搜索热路径调用。窗口模型每方向只报一个最强型。

### 5.3 评分

- 组合等级分值 `LEVEL_M`（含 `WIN=1e8`）；对方分值用因子 `LEVEL_T`（取值 `V_opp=round(t*M)`）。
- `singleScore` / `levelScore`：按 `rule`×`role`×`relation` 取值。Renju 黑棋的 `DOUBLE_FOUR/DOUBLE_THREE/OVERLINE` 返回 `FORBIDDEN=-1e9`。
- **调参钩子 `TUNE`**（§15.3）：引擎内所有取值经 `Mof/Tof/Lof` 解析，先查 `TUNE` 覆盖。`tools/bench-tune.js` 可离线局部搜索，胜出值回写 `LEVEL_M` 后 `resetTune()`。不变量：`FIVE=OVERLINE=WIN`、四 > 活三、活四 > 双三——禁止把胜负分/长度排序调反。

### 5.4 严格禁手判定与缓存

- `forbiddenCore(board,idx,mode)`：过 `idx` 沿四方向算黑连续段，再 `isFourDir`/`isOpenThreeDir` 逐方向独立计数（与窗口模型语义不同）。返回禁手等级或 0。
- `forbiddenAt(board,idx,mode)`：**唯一对外入口**（搜索/threat/eval/coach 都经它）。默认直接算；`forbidMemoSet(true)` 时走 `forbidMemo*` 局部窗口双 32 位哈希缓存（key 含盘面局部 11×11 窗，R=5），容量超限整表清；收益集中在 renju（freestyle 调用为 0）。
- **关键纪律**：`levelAt(board,idx,player,mode)` 在 `mode>0` 时**无条件调用 `forbiddenCore` 严格算法**（窗口"廉价预检"实测双向不可靠：假阴会把禁手点给正分致引擎自败，假阳会拒绝合法好着）。

### 5.5 增量缓存（性能关键）

- **线分缓存 `lc`**（§5.5 同节）：72 条 5+ 格直线预建；`CELL_LINES` 记每格所属 4 条线。`cacheUpdate` 在着法前后重算这 4 条线、修正 `tot`。`staticEvalPos` 读 `lc.tot` 得 O(1) 静态分。
- **材料表 `material`**（A6，默认关）：只计双方 8 类单棋型计数，口径与 `lc.tot` 逐位一致；供 `wldCode` 做 O(1) 胜负判定。`pos.onCell` 钩子原地递增（`materialInc`）维护。
- **O(1) 胜负 `wldCode`**（A5）：基于 `material` 三步比较返回 `{±100,±1,0}`，与静态评估终局短路同一套口径；长连仅在 renju 黑为禁手负。

---

## 6. 评估（`engine/eval.js`）

- **候选点 `candidates(board,radius)`**：距已有子 ≤ `radius`（默认 2）的空点；空盘返回天元 `(7,7)`。复用代数戳 scratch 缓冲避免分配。A9 位图版 `candidatesBit`（8×32 bit，`candBit` 开关）跳过全零 word，快约 16% 且输出顺序逐位一致。
- **着法级评分 `moveScoreAt`**（仅排序用）：`atk + λ·defend + center`。`atk=levelScore(我方)`；`def=levelScore(对方)`（对方禁手点威胁归零 → 白方"逼禁"自然涌现）；`center=14-(|x-7|+|y-7|)`。禁手着法排序分缩到 `−1e5`（仍严格低于合法着法最小分，又不至于为躲远期禁手弃胜势）。
- **静态评估 `staticEval` / `staticEvalPos`**：手番双栏 `V_stm − V_opp`，按 8 类棋型点积。含终局短路（己方有"四"即胜、对方活四/双四即负）。`staticEvalPos` 有 `lc` 时读增量合计（O(1)）。

---

## 7. 搜索（`engine/search.js`）

**框架**：Negamax + PVS + 迭代加深 + 渴望窗（aspiration）+ 置换表（平铺 `Int32Array`）+ killer/history 排序 + 静态搜索（quiescence）。

### 7.1 置换表

- `ttInit(bits)`：键/深度/标志/值/着法/代龄 `age` 各一块 typed array。`ttNewGen()` 每轮 `think` 推进代龄（老代优先被覆盖）。
- `SALT = ruleSalt(cfg)`：freestyle/renju/strict 互不污染（规则盐）。
- `ttProbe` 基于**原始窗口**判 EXACT/LOWER/UPPER；`ttMoveAt` 须校验 key（防拿别局面的着法当首选）；`ttStore` 基于 `origAlpha,beta` 定 flag。

### 7.2 着法生成与排序 `genMoves`

1. `winningPoints(board,对方)` 收集对方一步成五点 → `mustBlock` 集合，排序分 `+1e13`（必挡 > 一切）。
2. 每个候选 `moveScoreAt` 得 `atk+λ·def`；禁手着法 `−1e13`（惩罚而非禁止，仍入列表）。
3. TT 着法 `+1e12`；killer（主/次槽）+ history 小幅加权。
4. 按 `s` 降序，取前 `width`；根层可选 `rootAllowed` 过滤（对方 VCF 规避）。

### 7.3 启发式按位开关 `H_*`

`H_LMRF/LMRR/KILL2/MALUS/IID/ROOT/VDP/RAZOR/FUTILE/MCUT/VERIFY/LEAFVCF`。TT 标志位修正 / key 校验 / 代龄 / 规则盐属于**正确性修复**，不受开关控制；其余可调。`think()` 用 `cfg.h` 解析（`H_ALL` 默认全开）。

- **LMR**：`lmrReduce` 用规格公式 `r=max(0,floor(log d·log i/2))` 查表，钳位到 `[lmrMin, depth-1]`（`lmrMin` 默认 2，浅层标定下限）。
- **IID**：TT 无着法或过浅时先浅搜取着；`iidMode=2` 当存储深度不足时也触发。
- **A4 取胜线复核**、**A3 叶节点 VCF**：受开关控制，验收用 `verifyStat`/`leafVcfStat` 读触发计数。

### 7.4 主入口 `think(pos,cfgIn)`

预算切分（战术独立份额 `tactBudget` + 主搜索份额 `budgetMax`），迭代加深 `d=2..maxDepth`（步长 2）：
1. **L0 立即战术** `tacticalMove`：己方成五点 / 对方唯一封点 / 活四处 → 直接返回（不进搜索）。
2. **开局库出招** `openingMove`（在 L0 之后、搜索之前）：命中则省整手耗时，且避开稀疏局面静态评估不可靠。
3. **威胁搜索** `threatSolve`（独立预算）：VCF 先、VCT 后，返回即胜。
4. **主搜索** `rootSearch` 迭代加深 + 渴望窗；`bestV>=MATE` 或超时即停。
5. 返回 `{move, score, depth, nodes, timeMs, fallbackLevel, via}`。`fallbackLevel`：0=时限内完成 / 1=一层未搜（L1 兜底）/ 2=被时限打断。

**降级语义**：`reached>0` 且主搜索段超 `budgetMax` 才记 `2`，避免把"深层必然超时"漂成"完成"。

---

## 8. 威胁空间搜索 VCF/VCT（`engine/threat.js`）

设计原则：**只声明可证真的必胜**（sound）。

- **VCF**（`solve(false,...)`）：每步都是"对方必须封"的强制手；每节点先排除"对方已有成五点"，故结论成立。
- **VCT**：在 VCF 之上纳入活三。`resolveOpenThree` 求"中和点集"并逐一验证——若防守方能造四/成五（反击）则保守判失败（宁漏不假）。
- **深度递增**：`for d=2..maxDepth step 2` 求得**最短杀**路径。
- **A7 反向验证 `refutePath`**：默认关；开启时把"疑似有杀"升级为"确认有杀"——重放攻方手序列（path 只含攻方手），在每手之前检查守方是否已有成五点，可反驳则撤回。
- 廉价判据 `fivePointsAfter`（基于整数编码窗口）：落点成五点 = `OPEN_FOUR→2`、`FOUR→1`、`FIVE/OVERLINE→9`。

---

## 9. 开局库（`engine/book.js` + `engine/data/*`）

### 9.1 格式与索引

- `BookLine`：`{ ruleSet, opening, moves:[[x,y]...], weight, source }`。校验 `validateLine`（≥3 手、无重复、坐标合法）。
- `build(entries)`：每条线做 **8 种对称展开**（`openings.SYM`），以落子 idx 序列为键建索引；查询时键为原始序列，天然覆盖镜像/旋转。连 `k=0` 也建键（空盘能命中黑 1）。

### 9.2 前缀匹配树（现役，胜率选点）

- 数据 `book-tree.js`：RenjuNet 真实对局（11522 局）规范前缀树，节点=规范化前缀，边=该前缀下实战下一手含 `(n, r)`。
- `treeMove(tree,hist,opts)`：沿整段 `hist` 下探（中途不匹配即放弃，交回搜索）；每层用经验贝叶斯收缩 `K=120` 估胜率 `score=(w·n+K·prior)/(n+K)`，取 `[M−TIE, M]` 带内**样本量最大**者（对抗赢家诅咒，`TIE=0.02`）；用 `SYM_INV` 映回原盘面。
- **回落**：树未命中时 `bookMove`（旧线库 `book-lines.js`，按频次抽样 topK）。

### 9.3 棋谱解析 `parseRecord`

嗅探 Renju 记谱（`1.H8 2.I9` / `H8 I9`）或坐标对（`7,7 7,6`），自动识别 0/1 基。供 UI 与 `record.js` 复用。

### 9.4 数据许可

开局库 / 棋谱库 / 杀题库数据源自 **RenjuNet**（非商业）。仓库已剔除真实数据集（`data-raw/`、`test/data/positions-renjunet.json`），保留 `tools/gen-*.js` 生成器可重跑；运行时数据以打包紧凑串内联进产物。

---

## 10. 教练层（`engine/coach.js`）

不自行搜索：组合 `search`/`threat`/`eval` 为人读结构。一律 0 基 `(x,y)`，对外记号由 `record.coordText` 转换。

- **`hint(board,stm,opts)`** → Top-N `{rank,x,y,coord,score,norm,type,win,mate,mateLen}`：
  1. 立即成五点全部置顶；
  2. `bestMoves` 根候选降序（禁手着法不入榜）；
  3. 必杀标注：根局面 `solveOne`（"轮到我"前提正确且 dfs 排除对方成五点，sound）；败着不上榜；**必胜按杀距重排**（`WIN-1` 立即胜、攻方 L 手 `WIN-(2L-1)`、搜索证明 `WIN-ply`），分组归一令"必胜"旁不见 0%。
- **`judge(board,stm,opts)`** → `{blackRate,label,score,source,mate,forbiddenPoints}`：`fiveOnBoard` 终局优先；对方双成五点必负、唯一成五点记 `urgent(−2400)`；可选 VCF/VCT 标 mate；静态评估兜底，`evalToWinRate` 用 logistic（`S_SCALE=2400`，±2400≈0.73/0.27）映射黑方胜率；标签七档。
- **`heat(board,stm,opts)`** → 出点热力图 `[{x,y,v∈0..1}]`，禁手点 `v=0`。
- **终局优先 `fiveOnBoard`**：hint/judge 先查盘上是否已有五连（R11），否则白已五连仍会误报"黑已胜 100%"。

---

## 11. 棋谱（`engine/record.js`）

- **格式嗅探** `sniff`/解析：JSON（自有 GameRecord）/ SGF / Gomocup(`TURN x,y`) / Renju 记谱 / 坐标对，失败返回 `{ok:false,error,token?,line?,col?}`（错误码 `E_PARSE/E_RANGE/E_OCCUPIED/E_RULE`）。
- **GameRecord**：每手属性（no / timeMs / comment / player），回放复用同一渲染通道。
- **`coordText(x,y)`**：Renju 坐标（`H8` 风格），导出与提示共用。

---

## 12. 算子化威胁枚举（`engine/operators.js`，A12）

把"成五点 / 活三 / 冲四"的枚举统一为**算子对象**（一次威胁 + 其强制防守）。`classify` 与 `threat.threatMoves` 的 kind 语义同一套；**等价性由 `test/operators.test.js` 对拍保证**（集合 + kind 映射 diff==0），`threat.js` 不动。

---

## 13. Worker 协议（`engine/worker-entry.js`）

Worker 端消息路由 `handle(req)` → 一条响应（不含 `id`，由主线程补）。指令：

| cmd | 请求 | 响应 |
|-----|------|------|
| `init` | `{cancelBuf?}` | `{ok, sab}`（SharedArrayBuffer 可用则接管取消） |
| `move` | `{board,stm,rule,difficulty,time?,hist?}` | `{move,score,nodes,depth,timeMs,fallbackLevel,via,book?}` |
| `hint` | `{board,stm,rule,n,difficulty,depth?,useThreat?}` | `{hints:[...]}` |
| `judge` | `{board,stm,rule,overlineMode,forbidden?,useThreat?}` | `{blackRate,label,score,source,mate,forbiddenPoints}` |
| `heat` | `{board,stm,rule,difficulty,depth?}` | `{heat:[...]}` |
| `analyze` | `{board,stm,rule,moves,topN?,...}` | `{items:[...],stopped?}`（逐手推进，非每手重算空盘） |
| `abort` | — | `{ok}`（置 `CANCEL[0]=1`） |

- **校验**：`board` 须 `Int8Array`/数组、225 格、取值仅 `{0,1,2}`；`stm∈{1,2}`。`n`/`topN` 取整夹下界。错误码 `E_NO_BOARD/E_BAD_BOARD/E_BAD_STM/E_NO_ENGINE/E_NO_MOVES/E_CMD/E_INTERNAL`。
- **取消**：Worker 单线程，搜索期间收不到 `abort`；即时中断靠 `init` 传入的 `SharedArrayBuffer` 置取消位。无 SAB 时 `abort` 只在两次请求间生效，正确性靠主线程按 `id` 丢弃过期结果。
- `req.hist`：真实落子序列，缺它则 `posFromBoard` 重建局面 `hist` 为空 → 开局库永不命中（须由调用方传入）。
- `postMessage` 包 `DataCloneError` 兜底，避免 Worker 静默死掉。

---

## 14. UI 层（`ui/*`）

### 14.1 架构

`index.html` 按 §2.2 顺序加载；各模块挂 `window.G.*`。UI 只做展示与触发，所有计算走 AI 后端（Worker 优先、主线程兜底）。

### 14.2 AI 客户端 `ui/ai.js`

- **后端优先级**：Blob Worker（源码来自 `G.WORKER_SRC`）→ 主线程引擎兜底（Worker `file://` 被拦 / 创建失败 / 握手超时）。
- **请求调度**（2026-09-22 修复的实测缺陷）：`move` 不被抢占——辅助请求（hint/judge/heat/analyze）排队等 move 结束，同种只留最新、被替换者立即 `E_ABORTED` 收尾。
- **看门狗**：Worker 超时不响应（45s）必降级主线程并放行排队辅助请求，避免永久"思考中"。
- **id 机制**：每请求自增 `id`，只认当前 `id` 响应，其余丢弃（悔棋/重开安全）。

### 14.3 状态机 `ui/main.js`

- `idle ↔ waitingAI`（§14.3）；落子统一走 `commitAt()` 单一入口。
- **偏好持久化**：规则/模式/执子/难度/时限/提示难度/叠加层开关等刷新后恢复（`prefs.js`，localStorage 降级安全）。
- **行棋中锁定**：规则/模式/执子中途改会使已下棋失义，故行棋中 `disabled`，重开后解锁；难度/时限可随时改。
- **动画**（M10）：落子淡入 / 五连闪烁 / 候选脉冲，只驱动重绘不改状态，`prefers-reduced-motion` 关闭。

### 14.4 其他模块

- `render.js`：Canvas 高 DPI 渲染 + 叠加层（候选圈 / 热力 / 禁手红叉）+ 动画。
- `panels.js`：提示列表 / 形势条 / 热力图 / 控制按钮（只展示 + 触发）。
- `menu.js`：侧栏分组折叠（只管开合，不碰业务数据）。
- `prefs.js`：偏好持久化（localStorage，全程 try/catch 降级）。
- `touch.js`：触屏落子判定（纯函数，可被单测钉死）。
- `booklib.js`：棋谱库浏览 + 开局库关联棋谱（`relatedGames` 用规范化前缀筛过本局的真实对局）。
- `record.js`：棋谱导入/回放/导出/用时曲线/逐手分析（只负责棋谱视图，不改对局状态）。

---

## 15. 配置与调参

### 15.1 难度预设（`DIFFICULTY`，按规则标定）

| 档 | maxDepth | hardLimit | width/radius | 威胁搜索 | 对方 VCF 规避 |
|----|----------|-----------|--------------|----------|--------------|
| easy | 3 | 300 | 10/1 | 关 | 关 |
| normal | 5 | 1000 | 14/2 | 关 | 关 |
| hard | 7 | 2000 | 18/2 | vcf8/vct6 | 开(k6) |
| master | 12 | 3000 | 22/2 | vcf16/vct12 | 开(k8) |

- `difficultyCfg(name,rule)`：renju 下 `maxDepth` 下调 1~2（禁手判定成本更高）。
- `resolveCfg(cfgIn)`：`DEFAULT ← 难度预设 ← 显式参数`（显式优先）。
- `setDifficultyOverride(name,patch)`：标定工具注入实测参数，标定完回写 `DIFFICULTY`。

### 15.2 `DEFAULT` 关键配置项

`rule/overlineMode`、`lambda/width/radius`、`maxDepth/hardLimit/ttBits/aspiration`、`qDepth/lmrStart`、`incrMaterial`(A6,默认关)、`forbidMemo`(A11,默认关)、`candBit`(A9,默认关)、`vcfDepth/vctDepth/vcfBudget/vctBudget/threatMs`、`avoidOpp/avoidK/avoidDepth/avoidBudget`、`useBook/bookPly/bookTopK/bookShrink/bookTie/bookModel`、`h`(启发式位开关)。

### 15.3 调参钩子

- `patterns.setTune({singleM,singleT,levelM})` / `resetTune()`：离线局部搜索（`tools/bench-tune.js`），线上默认全 null 即出厂表。
- `search.setDifficultyOverride`：难度档位标定覆盖。

---

## 16. 数据许可与第三方

- **RenjuNet 数据**（开局库 / 棋谱库 / 杀题库）非商业用途。仓库剔除原始数据集，保留 `tools/gen-*.js` 生成器（可重跑）；运行时数据以打包紧凑串内联进产物。
- **第三方引擎 fork**（Carbon-Gomoku / PentaZen / Stahlfaust）仅作研究参考，未纳入本仓库。

---

## 17. 构建、发布与 CI

- `npm run build`：`build.mjs` 生成 `gomoku.html`；`npm run build:worker`：`build-worker-src.js` 重生成 `worker-src.js`。
- `npm test`：`node --test test/*.test.js`（**逐文件跑**，逐文件传目录不可靠）。
- `worker-src.js` 体积硬上限 208 KB（CI 断言）；改写引擎源码须重跑 `build-worker-src.js`。
- GitHub Actions（`.github/workflows/ci.yml`）：Node 18/20/22 自动跑测试。
- **诚实纪律**：棋力相关改动须附自对弈 Elo 与 95% 置信区间；若 CI 含 0，不宣称棋力提升（实测 30 局自对弈 Elo +11.6，CI [−112.8,+136.0] → 不声称棋力提升）。

---

## 18. 测试与质量纪律

- **Node 单测**：`test/*.test.js`，`require('node:test')`；覆盖 core/rules/patterns/eval/search/threat/book/coach/record/operators/worker 与 UI 纯函数（cand-bit/touch/ui-features）。当前 309 项全绿。
- **对拍纪律**：增量结构（material/lc）与全量 `countBoth` 逐位一致；operators 与 threat.threatMoves 集合等价；worker-src 改写后 hash 不变。
- **浏览器实跑不可省**：落子/绘制/动画/触屏/Worker 须沙箱外 CDP 实跑（含截图与异常监听），本地全绿 ≠ 线上可用（发布是 https 跨源快照，改完须重发布并跑线上核对）。
- **守卫双向验证**：新增正确性守卫须人为注入缺陷确认变红、再还原。
