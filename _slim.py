import re

p = r"C:/Users/zhaosong/WorkBuddy/gomoku-ai/docs/design.md"
s = open(p, encoding="utf-8").read()

parts = re.split(r'(?m)^(## .*)$', s)
out = [parts[0]]

SEC12 = """## 12. 开局库（Opening Book）

### 12.1 26 种指定开局
Renju 记谱 A–O 列（x=0..14）、1–15 行自下而上（y=15−row）；黑1 恒为天元 H8=(7,7)。前 3 手构成一种开局：白2 与黑1 连横/竖为**直指**，连斜线为**斜指**；共 13 直指 + 13 斜指。定义见 `engine/data/openings.js`（`OPENINGS` / `identify` / `variants` / `canonKey`），附 6 项自检（`test/openings.test.js`）。

### 12.2 结构与键
- `Opening = { name, type, b2, b3, moves, idx }`；`BookLine = { key, side, move, weight, ruleSet, note }`。
- **对称归一**：8 种 dihedral 变换，`canonKey(前3手)` 取最小字典序规范键 → 同名开局镜像/旋转自动归一。

### 12.3 数据来源
- 前缀树（`engine/data/book-tree.js`，`G.bookTree`）：由 RenjuNet **11 522 局 Classic 对局**聚合成边，每条边带 `(n 出现次数, r 该方最终胜率)`；紧凑 base36 串打包 **31.6 KB**。生成工具 `tools/gen-book-tree.js`。
- 线库（`book-lines.js`，v3.21 扩为前 10 手、588 条）：`weight`=实战局数，已退出前端产物（Node 侧留档）。
- 棋谱库（`engine/data/book-games.js`，927 局完整对局，含棋手与结果，仅 UI 用，不进 Worker）。

### 12.4 使用策略（前缀匹配树 + 按实战胜率选点）
- **模型**：从已下 2 手往树匹配，命中 26 个第 3 手候选；逐层下探直到匹配不上。选点用经验贝叶斯 `score=(w+K·prior)/(n+K)`（`w=r·n`），**收缩系数 K=120**（留出集标定：logloss 0.688 < 常数 0.5 的 0.693）；`TIE=0.02` 为赢家诅咒保守修正（未标定）。优先选收缩胜率最高、统计上分不开时取样本最多者。
- **三启用前提**（缺一退回搜索）：`useBook` 且 `hist.length < bookPly`（默认 10）；`hist.length === stones`（挡住复盘/题库构造局面）；落点为空（Renju 轮黑额外排除禁手点）。
- 在 `think()` 短路链 `tacticalMove → openingMove → threatSolve → 迭代加深` 中位于战术之后、搜索之前；开局阶段不进静态评估。
- **实测**：查询 <1 ms/层；自走书招连到第 9 手（裸 argmax 仅第 5 手）；索引 15766 条 / 建 85 ms；打包 bundle 167.3 KB（上限 200）。`tree` vs `line` 同剂量自对弈 275 局 Elo −5.1（CI 含 0）→ **不构成棋力结论**，合入理由仅限「信息量 + 定式持续时间 + 不劣」。

### 12.5 开局规则族（§33.7 详表）

| 规则 | 核心机制 | 本期 |
|------|---------|------|
| RIF（传统） | 指定开局 + 三手可交换 + 五手两打 | 支持 |
| 山口 / 索索夫 / 塔拉尼科夫 / 连换（中国） | 指定打点数 + 交换 | 可选 |
| Swap2 | 前三手无限制 + 三种选择，之后无禁手 | 支持（无禁手模式） |

"""

SEC13 = """## 13. 难度分级（按模式分别标定）

| 难度 | 深度上限 | 时限 | VCF/VCT | 说明 |
|------|---------|------|---------|------|
| 简单 | 3 | 0.3 s | 否 | 娱乐 |
| 中等 | 5 | 1 s | 否 | 业余中 |
| 困难 | 7 | 2 s | VCT | 强业余 |
| 大师 | 12 | 3 s | VCF+VCT(+PN) | 程序级 |

默认：困难 / 无禁手。Renju 下 `maxDepth` 单独下调 2（禁手判定成本更高），禁手风险由评分惩罚统一承担（各档都不自杀）。配置见 `engine/difficulty.js`。

### 13.4 标定结论（measure-don't-claim）
`maxDepth` 只是安全上界，真实深度由时限决定（大师档实测均深约 6–8，未打满 12）。
- **freestyle**：档位累计 Elo 单调（简单 0 → 中等 +34.9 → 困难 +105.3 → 大师 +175.7），但相邻档 30 局自对弈 CI 均含 0，**不宣称每档显著强于下一档**。
- **题库**：各档通过率 37–40/40，差异在噪声内，不能用于档位区分。

### 13.5 Renju 档位非单调（含 ⑤⑥ 结论）
两次独立标定（v3.21 与 v3.22，各 6–20 局/对）一致发现：**简单与中等实测深度都是 2.00，实质是同一档**——禁手判定使每节点贵约 2×，中等档 1 s 只搜到与简单档 300 ms 相同的位置；中等档需额外放宽时限或降深度上限才能与简单档拉开。
- 自对弈中 `master` vs `hard` 点估计为负（v3.21 −70.4；v3.22 +0.0，均 CI 含 0）→ **未测出大师强于困难**，不得据此改 `DIFFICULTY` 表。
- (e) **禁手「廉价预检」缺陷**（#33，2026-09-20）：`moveScoreAt` 的 `atk` 改用严格判定 `forbiddenAt`，降幅常量 `FORBID_SORT = PAT.FORBIDDEN*1e-4` 替代 `−1e9`；修后双向一致（假阴/假阳均 0）、搜索耗时 +25%、全量 179/179 全绿。
- 要压实任一相邻差需每对 ≥300 局（Renju 约 3 小时/对）。

"""

SEC17 = """## 17. AI 棋力评估与基准

### 17.1 参考基线
迭代加深 αβ / PVS → TT+Zobrist → threat-aware move ordering → VCF/VCT → 手工棋型评估 → 开局库；进阶 aspiration / IID / LMR / 连续历史 / PN；再进阶 NNUE。

### 17.2 验证手段
1. **杀棋题库**：已知 VCF/VCT/四三/逼禁残局，要求给出正确必胜序列（100% 达标）。
2. **自对弈 Elo 基准**：新旧引擎双色交替 + 固定开局，以 95% 置信区间判定净提升（分辨 20 Elo 需约 1160 局）。
3. **人机测试**：业余棋手对局胜率与主观难度。
4. **跨引擎对弈（可选）**：接入 WASM 开源引擎作标尺。
5. **性能基准**：固定局面 NPS、单步耗时。

### 17.3 诚实结论（measure-don't-claim）
- **题库门槛**：`engine/data/mates.js` 含 30 道进攻 + 8 道防守题，全部经独立复算器逐手证明（`test/mates.test.js` 100% 通过）；链长多为 2 手，判别力有限。
- **Elo 纪律**：VCF/VCT 开 vs 关的 30/500/1200 局自对弈 95% CI 均含 0（1200 局 +14.2，CI [−5.5,+33.9]，分块异号）→ **无可证棋力增益**，不宣称 VCF/VCT 提升强度。
- **VCF/VCT 实测价值**：杀棋能力不再受搜索深度限制（深度 3 时纯搜索漏 7%、VCF/VCT 补至 100%），同局面给结论快 1.8–2.6×；属延迟/覆盖率收益，非强度收益。
- **权重调参**：`tools/bench-tune.js` 在 freestyle / renju 下均未跑出显著优于出厂权重的参数组（每步局数不足致无判定力），出厂权重保持不变。
- 实测速率约 0.1–0.3 局/秒，排计划勿按早期乐观估算。

### 17.4 权重调参
目标函数 `fitness(P)=S(P vs 基线)`；硬约束：题库不退化、长度序不变量保持、二项检验 p<0.05 才接受；7 个可调旋钮（活三/冲四/眠三/活二/双活三/四三分值 + λ），连五/长连/禁手惩罚永不开放。见 `tools/bench-tune.js`。

"""

SEC31 = """## 31. 测试用例清单
逐文件单元测试见 `test/*.test.js`（共 309 项，基于 `node:test`，零依赖），覆盖：规则/禁手、棋型评分、搜索（TT/LMR/时限降级）、VCF/VCT、开局库、棋谱解析、提示/形势判断、Worker 协议、杀棋题库、调参钩子。运行 `npm test`。

"""

REPLACE = {12: SEC12, 13: SEC13, 17: SEC17, 31: SEC31}
DELETE = {19}

i = 1
while i < len(parts):
    heading = parts[i]
    body = parts[i+1] if i+1 < len(parts) else ""
    m = re.match(r'##\s+(\d+)\.', heading)
    num = int(m.group(1)) if m else None
    if num in DELETE:
        pass
    elif num in REPLACE:
        out.append(REPLACE[num])
    else:
        out.append(heading + body)
    i += 2

open(p, "w", encoding="utf-8").write("".join(out))
print("done")
