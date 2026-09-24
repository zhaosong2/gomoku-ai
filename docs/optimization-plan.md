# gomoku 引擎优化整合设计文档（三参照系合并）

> **版本**：**v1.4（全部实施完毕 + 版本迭代收尾，2026-09-21）**
> **状态**：**13 条（A1–A13）全部有终局** —— 做 9 条（A1 已回滚 / A2 / A4 / A5 / A6 / A7 / A9 / A11 / A12 / A13）、
> 砍 3 条（A3 位留档 / A8 / A10）、弃 1 条（A3 的 Elo 层面）。**另附 UI 增强 R1–R6 + 探索性测试 R7 + 评审/加固 R8 +
> 移动端小屏 R9 + 发布后线上实跑 R9.1**（v3.33–v3.39，非引擎优化）。
> 配套：全量 **309 项测试全绿**、worker `472e66a231f50c9e`（207.9 KB / 上限 208）、
> 浏览器共 **349 项**全绿（开发壳 3 + R1–R4 20 + R5 菜单 45 + R6 专项 22 + **R7/R10 探索 50** +
> **R9 触屏 42** = 178；单文件 R5 45 + R6 22 + R7 46 + 8 + R9 42 = 163）、
> **线上分享链接黑盒实跑 26/26 全绿**（`tools/_live-check.js`）、
> 基线已重标（`A13-complete-batch4`，见 **§7.5**）。
> **定位**：`gomoku-design.md` 的**增补篇**——把 `carbon-gomoku-study.md`（成本控制）、
> `stahlfaust-study.md`（完备性证明）、`pentazen-study.md`（现代搜索工程完整性）
> 三篇研读的**可执行建议**合并为**一份不冲突、可落地的实施设计**。
>
> **★ v1.1（编码执行版）相对 v1.0 的定位升级**：v1.0 是**设计级**（说清"改什么、为什么、
> 与谁冲突"）；**v1.1 要求"照着敲就能写"**——每条除设计说明外，必须补齐四件套：
> ① **已核对的 `文件:行号` 落点**（源码逐行核实过的锚点，不必回头翻源码）；
> ② **可粘贴执行的验证命令**（基线 + 期望值）；
> ③ **量化门槛**（过/不过的硬数字，杜绝"感觉更快"）；
> ④ **分步提交顺序**（可回滚的最小步子）。
>
> **★ v1.2（测试方法设计）新增 §5.5**：**"测了但证明不了效果"的解法**——
> 按 **"是否改变搜索真值（search truth）"** 把 13 条切成**棋力场景 / 正确性场景**两类；
> 只对**理论上可能有棋力提升**的条（**A1 / A3 / 及 A2 达成"省节点换深度"时**）做 Elo，
> 其余 10 条**只做正确性（等价对拍）+ 效率测试**。含：场景分类表 / 两套正交判据 /
> 单元·功能·版本迭代三层映射 / 防"永远绿测试"的三步注入法 / **逐条测试清单（文件+用例+命令+耗时）** /
> 三种场景的 30 min 配方 / 与既有 179 项的关系 / 实施顺序。
> **★ v1.3（对账修正，2026-09-20）**：开工前对代码逐条核查后的**修正版**（证据链见 `optimization-plan-review.md`）——
> ① **A1 替换循环补回 :556-564 渴望窗**（v1.2 草稿整段丢失，照抄会静默删除 M7 特性）；
> ② **A1-c `stabilFactor` 收缩对象由"层耗时预测 lastTd"改为"本手剩余预算 budgetMax"**（与 PentaZen 原义对齐）；
> ③ A3 的 `!pos.win` 改为显式"上一步已成五"判定（`pos` 无该字段），未定义的 `o.*` 统一为 `cfg.*`；
> ④ A2c 补"forcing 着法"定义；⑤ A8 生死判据纠正（P-A 热点占比；"命中率≥20%"是 A11 的判据）；
> ⑥ §5.5.6 A1 用例①改对 `timeInfo` 断言（原稿 turnTimeMin/Max 在 §4.1 设计中不存在）；
> ⑦ **§5.5.9 前置扩为 S0–S3**（S0 = duel D-1~D-3 的 L2 过程信号；S1 并入 `tools/verdict.js`；S2 并入 renjunet 大语料双档）；
> ⑧ A11 验证命令改为真脚本。
> **下游配套**：`test-methodology.md` v1.1（效果层 E1–E4 = 编码的执行骨架）、
> `duel-methodology.md` v1.0（对局层过程信号）、`verdict-methodology.md`（三层漏斗）、
> `verdict-time-budget.md`（30 min 闸门）。
> **关系**：本文件**不修改** `gomoku-design.md` 的既有契约（§4 评分表 / §7 规则分离 /
> §13 难度表 / §24 搜索规格 / §28 协议字段）；实施完成后**结果回写** `gomoku-design.md` §16/§17/§33。
> **上游文档**：三篇 study 文档（同上）。
> **纪律（§17.2）**：**用数据裁决，不自称棋力提升**；Elo 结论需 95% CI 不含 0；
> 门槛「净提升 >20 Elo 才合入」，不达标就如实写「未达标」。

---

## §0 阅读契约

| 你要做什么 | 先读 |
|---|---|
| 想知道为什么做这些优化 | §1（总纲）、§2（三参照系合并逻辑） |
| 想知道**先做哪一条** | §3（全局依赖图）、§5（唯一实施批次表） |
| **马上要开始编码** | **§4.0（全局施工契约）→ §4.x 对应条目 → §4.0.6 统一验收命令** |
| **要给某条写测试** | **§5.5（测试方法设计：按条 × 按场景）→ 5.5.6 逐条测试清单** |
| 想动手做某一条 | §4（逐条规格：落点 / 改动 / 接口 / 验证 / 回滚） |
| 想知道边界与风险 | §6（冲突裁决登记表）、§7（风险登记表） |
| 想知道**本版 vs 上版的性能/正确性变化** | **§7.5（版本迭代收尾：Δ 报表 + 基线重标定）** |
| 想知道不做什么 | §8（合并反向清单） |
| 想知道与既有设计的关系 | §9（与 `gomoku-design.md` 的接口对账表） |

**§4 每条的固定结构（v1.1）**：`目标 → 落点（文件:行号）→ 改动 → 接口/契约 → 实现顺序
（分步提交）→ 验证命令 → 量化门槛 → 回滚`。**七项缺一不可**；缺项即视为该条**未达编码执行级**。

**本文件的三条硬约束**（贯穿全文，每条建议都必须满足）：
1. **不破坏既有契约**：任何改动都不得改变 §4 评分表数值、§28 协议字段名、§13 难度表参数
   （除非该条明确声明"要动且已给回滚开关"）。
2. **可回滚**：每条改动必须有**独立开关**（沿用 `H_*` 位开关 / `cfg.*` 字段惯例），
   关掉即退回旧行为，且**A/B 两侧都能跑**。
3. **可验证**：每条改动必须给出**量化验收指标**（测试项 / 节点数 / 深度 / 题库通过率 / Elo CI），
   **不允许以"感觉更快/更强"结项**。

---

## §1 一句话总纲

**三篇研读正交，各产出一条主轴；本文件把它们排成一条互不打架的实施链。**

| 参照系 | 主轴 | 一句话 | 在本文件中的角色 |
|---|---|---|---|
| Carbon-Gomoku | **成本控制** | 把每节点做**便宜**（查表 / 增量 / 边距 / 计数器） | 提供**性能地基**（第 3–4 批） |
| Stahlfaust | **完备性证明** | 把搜索空间**变小、把猜测变证明**（算子 / 依赖 / 反驳） | 提供**战术可信度**（第 2 批） |
| PentaZen | **现代搜索工程完整性** | 把现代搜索**做完整**（剪枝 / 时间管理 / VCF 耦合 / 多线程） | 提供**棋力主轴**（第 1 批） |

**一句话选路**：
> **先补齐"必然浪费"的最小改造（时间管理 / 剪枝 / 战术默认开）→ 再补"可信度"（反向验证 / 胜着复核）
> → 最后才动"性能地基"（增量结构 / 查表），并且只在探针证明它是热点时才动。**

**为什么是这个顺序**：三篇都指出同一件事——**我们缺的是"每节点做得更多、更早停止"，
不是"每节点做得更快"**。M9 硬结论（`maxDepth` 不是实际深度，`hardLimit` 才是）说明
**当前限制棋力的是"单位时间能搜多深"**；而"预测式停止"（三篇共识）与"剪枝补齐"（PentaZen）
是**改动最小、收益最确定**的提速手段。性能地基（`see` 表 / 增量威胁表）收益可能更大，
但**风险高、且必须先证明热点**——放在最后，且**允许砍掉**。

**★ v1.1 一句话补充（编码视角）**：13 条里有 **5 条是"开关型"**（A2/A3/A4/A6/A8，加一位
`H_*` 或 `cfg.*` 即可 A/B），**4 条是"替换型"**（A5/A10/A11/A12，新增模块 + 对拍等价），
**2 条是"重构型"**（A1 时间管理 / A7 反向验证，改 `think()` 主流程，风险最高、必须分步），
**1 条是"探针型"**（A9 候选位图），**1 条是"贯穿型"**（A13 自检）。**改文件铁律、位开关分配、
cfg 字段登记、统一验收命令全部收在 §4.0**——编码前必须先读 §4.0。

**★ 测试视角补充（§5.5，本篇核心新增）**：**13 条里只有 3 条（A1/A3 + A2 达成换深度时）
"理论上可能提升棋力"，需做 Elo；其余 10 条"不改变搜索真值"，只做正确性/等价测试。**
判据 = **"是否改变 search truth"**。此分类把"一次裁决 30 min+"降到"多数 12 min"，
并避免用 Elo 噪音否定确定性证据（`verdict-methodology.md` V6）。**详见 §5.5.2 分类表。**

---

## §2 三参照系合并逻辑（为什么它们不冲突）

### 2.1 三轴正交表

| 轴 | 主导参照系 | 目标指标 | 主要落点 | 与其他两轴的冲突 |
|---|---|---|---|---|
| **A. 停止与调度** | PentaZen + Carbon + Stahlfaust（三方共识） | 实测深度↑、浪费节点↓ | `search.js:think()` | 无（只改何时停） |
| **B. 搜索完整性** | PentaZen | 同深度更省节点 / 不漏杀 | `search.js:pvs` | 与 A 共用 `pvs`，但**不同代码段**（A 在 `think` 循环，B 在 `pvs` 主体） |
| **C. 战术可信度** | Stahlfaust | 错报胜着↓、`hint.mate` 可信 | `threat.js` | 无 |
| **D. 性能地基** | Carbon + PentaZen | NPS↑、`levelAt` 占比↓ | `patterns.js` / `core.js` | ★ **A3 与 A7 冲突**（见 §6 登记表） |

### 2.2 冲突点全清单（这是"可落地不冲突"的核心）

| # | 冲突 | 涉及条 | 裁决 |
|---|---|---|---|
| C-1 | **Carbon-A3（禁手缓存）vs Stahlfaust-A3（增量威胁表）vs PentaZen-A7（`see` 表）**——三者都改 `patterns.js` 的缓存层 | 4.11 / 4.12 / 4.13 | **必须串行**；且**同一时间只允许一条在分支上**；`see` 表（PentaZen-A7）**优先级最低**，除非 P-A 探针证明否则不做 |
| C-2 | **Carbon-A3 vs PentaZen-A5（`check_wld` O(1) 判定）**——都想要"材料计数" | 4.11 / 4.13 | **合并为一条**：先做 **A6 增量材料表**（只做计数，不做位掩码），它同时服务两者 |
| C-3 | **Carbon-A4（棋盘加边距）** vs 全项目 `idxOf` 地基 | 4.9 | **明确排除**（见 §8），不做 |
| C-4 | **PentaZen-A2（剪枝补齐）四条同时开** | 4.2 | **必须逐一开、逐一基准**，禁止一次开多个（无法归因） |
| C-5 | **Stahlfaust-A2（算子化）vs 现有 `threat.js`** | 4.6 | **纯新增模块**，不动 `threat.js` 语义；`threat.js` 仅在 C-1 之后的批次逐步迁入 |
| C-6 | **时间管理改 `think()`** vs **`bench-difficulty` 的深度量测段** | 4.1 | 时间管理会改变"实测深度"这一指标的含义 → **基准工具需同步注明"改后深度不可与改前直接比"** |
| C-7 | **Carbon-A7（预测式停止）vs PentaZen-A1（动态 `turnTime`）vs Stahlfaust-A7** | 4.1 | **三者是同一条**。合并为**统一的 `think()` 时间管理层**（§4.1 给出统一设计） |

### 2.3 "可落地"的三条保证

1. **每条都是"加法"**：新增函数 / 新增开关 / 新增字段，**不重写既有逻辑**。
   （唯一例外：`think()` 的时间管理段是替换，但**旧行为可由开关复原**。）
2. **每条都有前置探针**：动手前先有只读探针给出"这条值不值得做"的数字。
   **探针说收益为零 ⇒ 直接砍掉，不写生产代码。**
3. **每条都有回滚路径**：`cfg.*` 开关 + 打包裁剪（自检代码绝不进 `worker-src`）。

---

## §3 全局依赖图与唯一实施批次表

### 3.1 依赖图（箭头 = 前置）

```
                    ┌─────────────────────────────────────────┐
                    │  第 0 批：只读探针（不写生产代码）        │
                    │  P-A levelAt 占比   P-B 末层浪费量        │
                    │  P-C candidates 占比 P-D 战术基线         │
                    │  P-E WCLS 命中率    P-F 禁手缓存命中率    │
                    └───────────────┬─────────────────────────┘
                                    │（数字决定后面做什么）
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
┌───────────────┐         ┌───────────────┐         ┌───────────────┐
│ 第 1 批（低风险）│         │ 第 2 批（中风险）│         │ 第 3 批（地基）│
│ A1 时间管理    │         │ A3 VCF 耦合    │         │ A6 增量材料表  │
│ A2 剪枝补齐    │         │ A4 胜着复核    │         │ A5 O(1) 胜负判定│
│ （逐一开）     │         │ A7 反向验证    │         │（依赖 A6）     │
└───────────────┘         └───────────────┘         └───────┬───────┘
                                                            │ 仅当探针证明热点
                                                            ▼
                                                  ┌───────────────────┐
                                                  │ 第 4 批（研究性）  │
                                                  │ A8 see 位掩码表★   │
                                                  │ A9 候选位图        │
                                                  │ A10 增量威胁表     │
                                                  └───────────────────┘
```

### 3.2 唯一实施批次表（按此顺序做，勿跳批）

| 批次 | 条号 | 名称 | 来源 | 前置 | 风险 | 预期收益 |
|---|---|---|---|---|---|---|
| **0** | **P-A** | `levelAt` 在 `think()` 中占比 | Carbon A6-a / 三篇 | — | 零 | 决定 A6/A8/A10 生死 |
| | **P-B** | `think()` 末层浪费量 | Carbon A7 / Stahlfaust A7 / PentaZen A1 | — | 零 | 决定 A1 收益上限 |
| | **P-C** | `candidates()` 占比 | Stahlfaust A6 / PentaZen A8 | — | 零 | 决定 A9 生死 |
| | **P-D** | VCF/VCT 题库通过率与耗时基线 | Stahlfaust A1/A4 | — | 零 | A3/A7 的对照基线 |
| | **P-E** | `WCLS` 命中率（`rawClassify` 调用次数是否收敛） | Carbon A6-a | — | 零 | 决定"预计算化"是否有意义 |
| | **P-F** | 禁手缓存潜在命中率（同 `(局面,idx)` 重复率） | Carbon A3 | — | 零 | 决定 A11 生死 |
| **1** | **A1** | **统一时间管理层**（预测式停止 + 动态预算 + 战术分预算） | 三篇共识 | P-B | 低 | ★★★ 最确定 |
| | **A2** | 剪枝补齐：VDP / razoring / futility / 着法数裁剪 | PentaZen A2 | P-D | 中低 | ★★★ |
| | **A2a** | └ 逐一开启，**一次只开一个** | | | | |
| **2** | **A3** | VCF 与 αβ 耦合（叶节点试 VCF） | PentaZen A3 | P-D | 中 | ★★ |
| | **A4** | 取胜线 verification search（胜着窄窗复核） | PentaZen A4 + Stahlfaust A1 同源 | — | 低 | ★★ 防错报 |
| | **A7** | VCF/VCT 反向验证（完备反驳） | Stahlfaust A1 | P-D | 中 | ★★ 提升 `hint` 可信度 |
| | **A12** | 算子化威胁枚举（纯新增模块） | Stahlfaust A2 | — | 低 | 为 A7/A8 铺路 |
| **3** | **A6** | **增量材料表**（只做计数） | PentaZen A6 | P-A | 中 | ★★ A5 的前置 |
| | **A5** | `wldOf` O(1) 胜负判定 | PentaZen A5 | A6 | 低 | `staticEval` 终局更快更准 |
| **4** | **A8** | `see` 位掩码表 | PentaZen A7 | **P-A 证明热点** | **高** | 可能数量级 |
| | **A9** | 候选位图（`MoveList` 内嵌 bitboard） | PentaZen A8 / Carbon A1-a | P-C | 低 | 去重 O(1) |
| | **A10** | 增量威胁表 | Stahlfaust A3 | P-A / A12 | **高** | 需先证 |
| | **A11** | 禁手评估缓存 | Carbon A3 | P-F | 低中 | 需先证 |
| **贯穿** | **A13** | 增量结构 `assert` 自检 | Carbon A8 / Stahlfaust A8 | 随 A6/A8/A10 | 零 | 防静默不一致 |
| **明确排除** | — | 棋盘加安全边距 | Carbon A4 | — | — | 收益 << 风险 |

### 3.3 批次纪律（每批完成后必做）

1. **全量测试全绿**（当前 **179 项**）：
   `for f in test/*.test.js; do node --test "$f" 2>&1 | grep -E "^# (tests|pass|fail)|^not ok"; done`
2. **重打包** `node tools/build-worker-src.js`（否则 `test/worker.test.js` 的**打包新鲜度**测试会挂）。
3. **跑对应基准**，结论按 §17.2 口径表述（CI + 门槛）。
4. **结果回写** `gomoku-design.md` §16 / §17 / 本文件 §10（版本记录）。
5. **浏览器实跑一次**（§34：Node 单测会漏真实调用链 bug）。

---

## §4 逐条规格

> 每条给出：**动机 → 上游出处 → 落点 → 具体改动 → 接口/契约 → 验证 → 回滚 → 风险**。
> **落点均以当前代码实测行为准**（已核对 `engine/*.js` 行号与函数名）。
> **★ v1.1（编码执行版）**：新增 **§4.0 全局施工契约**（铁律 / 三处同步 / 位开关分配 /
> cfg 字段登记表 / 导出登记表 / 统一验收命令 / 每条自检格式），
> 并给**每条补齐**：**已核对的 `文件:行号` 落点**、**可直接粘贴的验证命令**、**量化门槛**、
> **分步提交顺序**。目标 = **照着敲就能写**，不再需要回头翻源码确认。

### 4.0 全局施工契约（★ 编码前必读，v1.1 新增）

**这一节是"从设计到代码"的桥**：所有 13 条共用的规则、接口、命令都集中在此，
逐条只写**差异部分**。**未读完本节不要开始写任何一条。**

#### 4.0.1 改文件的铁律（项目血的教训）

| 规则 | 说明 |
|---|---|
| **一律用 `Edit`，绝不用 `Write` 改已存在文件** | `Write` 是整文件替换语义。**曾把 `engine/threat.js` 从 271 行截断成 16 行注释**（1188 字节） |
| **同一文件的多个 `Edit` 必须串行** | 并行 `Edit` 会互相覆盖，**且两边都返回 success** |
| **新增引擎模块必须三处同步** | 见 §4.0.2（漏一处即挂测试） |
| **改完引擎源码必须重跑 `tools/build-worker-src.js`** | 否则 `test/worker.test.js` 的"打包新鲜度"断言会挂 |
| **改完先跑定向测试，再跑全量** | 全量约 40 s；定向能秒级定位回归 |

#### 4.0.2 新增模块的三处同步（漏一处即挂测试）

新增 `engine/xxx.js` 时必须同时改 **3 处**，顺序不可乱：

| # | 文件 | 改动 |
|---|---|---|
| ① | `index.html` | 在 **引擎段** script 列表插到正确位置 |
| ② | `tools/build-worker-src.js` | 在 `FILES` 数组插到正确位置 |
| ③ | 依赖它的模块 | 用命名空间调用（引擎内部是 IIFE 命名空间，**不是 ESM**） |

**打包顺序（`build-worker-src.js` 的 `FILES`）**：
```
core → patterns → rules → eval → threat → search → book → record → coach → worker-entry
```
**页面顺序（`index.html`）**：
```
引擎: core → patterns → rules → eval → threat → data/openings → data/book-tree
      → book → search → record → coach → worker-src
UI  : render → ai → record → panels → main
```
✅ **A1–A13 全部不改模块边界**（都是改现有文件），**故本节仅 A12 若新建模块才适用**。

> ★ **A12 实际落地（2026-09-20）**：**新建了 `engine/operators.js`**（纯新增模块），
> 故本节适用。三处同步已做，插入位置 = **`threat.js` 之后、`search.js` 之前**：
> ```js
> // tools/build-worker-src.js 的 FILES / index.html 的 script 列表，同一位置：
> 'engine/threat.js', 'engine/operators.js', 'engine/data/openings.js', …
> ```
> 打包产物确认含 `engine/operators.js` 段标记 + `legalOperators` + `CLS_NAME`；
> `worker.test.js` 的 FILES 顺序 / 页面顺序校验**自动覆盖**了新模块（该测试从 `FILES` 动态派生）。

#### 4.0.3 位开关分配表（**先占后用，勿冲突**）

现有 `H_ALL = 63`（占满低 6 位，`search.js:31-38`）。**本文件共需 6 个新位**（A2 用 4 个，A3/A4 各 1 个）：

```js
// search.js:37 之后追加（★ 不得改动已有 1/2/4/8/16/32 的语义）
const H_VDP    = 64;    // A2-① VDP：劣势时提前剪枝（PentaZen vdp）
const H_RAZOR  = 128;   // A2-② razoring
const H_FUTILE = 256;   // A2-③ extended futility
const H_MCUT   = 512;   // A2-④ 着法数裁剪（move count pruning）
const H_LEAFVCF= 1024;  // A3   叶节点 VCF
const H_VERIFY = 2048;  // A4   取胜线 verification search

const H_ALL_NEW = H_ALL | H_VDP | H_RAZOR | H_FUTILE | H_MCUT | H_LEAFVCF | H_VERIFY;
```

**★ 三条纪律**：
1. **`H_ALL` 保持 63 不变**（它是"现有 M7 行为"的契约，多处测试/工具依赖）；
   **新增位只在逐条验收通过后，才并入 `H_ALL_NEW`**。
2. **A2 的四个位必须"逐一开"**（§4.2 原文要求）——
   即先只开 `H_RAZOR`，验收通过再开 `H_FUTILE`，**不许一次全开**。
   理由：四个剪枝**互相掩盖**，一把开无法归因。
3. **位开关只用于 `h<n>` 可表达的**；**A1 的时间管理不进位开关**（见 §4.1 接口/契约）。

#### 4.0.4 cfg 字段登记表（**新增字段的唯一账本**）

| 字段 | 默认 | 属哪条 | 退回旧行为的取值 |
|---|---|---|---|
| `layerFactor` | **`0`**（★★ 2026-09-20 会话 8 **整体回滚**：A1 在本引擎全档位无正收益——normal/hard 用不到时限（52/208ms vs 1000/2000ms，富余 10~19×）、master 时限利用率 96.3% 无浪费且 A1 令深度 9.50→7.75（K=0~8 扫描无 K 能追平 K=0）；动机依据 P-B"68.4% 浪费"系 `_probe-lastlayer.js` 默认 `--ms=100` 人为压缩时限口径。**机制保留在 cfg 通道，显式传值即启用**。详见 §4.1 回滚记录） | A1 | `0`（即当前默认） |
| `tacticalRatio` | `0.35`（A1-a 预算切分，**保留生效**——它只影响战术/主搜索份额划分，无时序副作用） | A1 | `1` |
| `stabilFactor` | **`1.0`**（★ 2026-09-20 回滚为旧行为；原标定值 0.97 留档） | A1 | `1.0`（即当前默认） |
| `stopEarly` | **`1.0`**（★ 2026-09-20 回滚为旧行为；实测 0.7~1.0 全档无差异 = 惰性参数；原标定值 0.7 留档） | A1 | `1.0`（即当前默认） |
| `incrMaterial` | `false` | A6 | `false`（=现状） |
| `wldFast` | `false` | A5 | `false` |
| `useSee` | `false` | A8 | `false` |
| `candBit` | `false` | A9 | `false` |
| `incrThreat` | `false` | A10 | `false` |
| `forbidMemo` | `false` | A11 | `false` |
| `leafVcfDepth` | `0` | A3 | `0`（=现状，**主 `vcfDepth` 不受影响**） |
| `leafVcfBudget` | `2000` | A3 | —（`leafVcfDepth=0` 时不用） |
| `assertIncr` | `false` | A13 | `false` |

**★ 注意 A3 与 A2d 用位开关而非 cfg 字段**（它们的语义就是"搜什么"，符合位开关的定位）：
`H_LEAFVCF`（A3）/ `H_VERIFY`（A4）/ `H_VDP`·`H_RAZOR`·`H_FUTILE`·`H_MCUT`（A2）——
**分配见 §4.0.3**。**A4 没有 cfg 字段，只有位开关**（`H_VERIFY`）。
★ **A2 收官（2026-09-20）**：`H_RAZOR`/`H_MCUT` 已并入 `H_ALL`（63→703）；
`H_VDP`/`H_FUTILE` 弃用留档（验收数据见 §4.2 收官记录）。A2 回滚 = `cfg.h` 传 63。

**★ 默认值纪律**：**全部默认"关"** ⇒ 合入后引擎行为**逐位不变**，
由 `h`/cfg 显式开启 ⇒ **回滚 = 不传该字段**，且**新旧结果天然可比**。

#### 4.0.5 新增导出登记表

```js
// search.js 返回对象（:643）追加
wldOf,            // A5：wldOf(pos)  → { winner, offset }   ★ 也需从 patterns.js 或新模块导出
seeTable,         // A8：只读引用，供测试断言表已构建
candBitInfo,      // A9：() => ({ built: bool, cells: n })  仅观测用
threatTableInfo,  // A10：() => ({ built: bool })           仅观测用
forbidMemoStats,  // A11：() => ({ hit, miss })             仅观测用
timeInfo,         // A1：() => ({ budgetMax, tactBudget, lastTd, stopped })  供测试/基准读
```
**★ 纪律**：**观测用导出一律"只读 + 返回新对象"**，不得让测试能改内部状态
（否则测试之间会互相污染——这是 §17.2"探针纪律"的编码层面落地）。

#### 4.0.6 统一验收命令（逐条只写"该条专属"的部分）

```sh
cd gomoku
# ① 全量回归（必跑；约 40 s）—— 基线：179 项全绿
for f in test/*.test.js; do node --test "$f" 2>&1 | grep -E "^# (tests|pass|fail)|^not ok"; done

# ② 该条所属的定向测试（逐条给出文件名）
node --test test/<该条的测试文件>

# ③ 效果层（若已按 test-methodology.md 落地；否则跳过并记为"未落地"）
node --test test/effect-search.test.js test/effect-micro.test.js

# ④ 打包新鲜度（★ 改过引擎源码必跑）
node tools/build-worker-src.js && node --test test/worker.test.js
```

**★ 合入前必须同时满足（§17.2）**：
1. **①全量绿**（179 项一项不少）；
2. **该条的定向测试绿**；
3. **无指标退化**（节点 ≤ 基线×1.05 / 深度 ≥ 基线−0.01 / 题库不降）；
4. **有可报告的效应量**（`console.log` 打出 `[效应量]` 行）；
5. 若声称"棋力提升" ⇒ **额外要求 Elo 的 95% CI 不含 0**（否则只能写"效率改进"，见
   `verdict-methodology.md` V6 / `test-methodology.md` §0）。

#### 4.0.7 每条的统一交回格式（写代码时按此自检）

```
□ 落点：文件:行号（已核对）
□ 改动：最小 diff（不改无关行）
□ 开关：cfg 字段 / 位开关（默认关）
□ 自检：A13 的 assert（若涉及增量结构）
□ 定向测试：test/xxx.test.js  ← 新写或扩写
□ 全量：179 项全绿
□ 效应量：____（数字）
□ 回滚：一行命令
```

---### 4.1 A1 —— 统一时间管理层（★ 三参照系共识，最高优先级）

**动机**
当前 `search.js:think()`（实测 `:549-568`）是**事后感知**式迭代：
```js
for (let d = 2; d <= cfg.maxDepth; d += 2) {
  try { r = rootSearch(pos, d, cfg, deadline, lo, hi, rootIdx); }
  catch (e) { if (e !== TIMEOUT) throw e; break; }   // ← 只有撞上 deadline 才退
  ...
  if (r.timeout) break;
}
```
⇒ **两层浪费**：① 每一手都可能白花"最后一层的部分节点"（该层未完成 ⇒ `best` 不更新 ⇒ 全废）；
② 战术搜索（VCF/VCT）与主搜索**共享同一个 `hardLimit`**，谁先跑谁占，**没有预留**。

**上游出处**
- Carbon `AICarbon.cpp:149`：`t1 + TIMEOUT_PREVENT*td - stopTime() >= 0`（`TIMEOUT_PREVENT=5`）。
- Stahlfaust `NewAiPlayer.cs`：`resttime >= usedtime` 则停；`alphabeta` 剩余时间存 `dbextratime` 留给 db-search。
- PentaZen `thread.cpp:221-231` + `search.cpp:286-314`：
  `turnTimeMin = max(min((timeLeft-10000)/18, timeoutTurn)-50-BUFFER_MS, 50)`、
  `turnTimeMax = max(min((timeLeft-10000)/6, ...)-50-BUFFER_MS, 50)`；
  **best move 变 → 重置 `turnTimeMax`；稳定（`itDepth>=7`）→ `×0.97`**；
  **`elapsed > turnTime*0.7` → 提前 break**；时限检查每 512 节点；`BUFFER_MS=300`。

**落点**（★ 已核对 `2026-09-20`，行号为 v3.23 版本）：

| 文件:行 | 符号 | 用途 |
|---|---|---|
| `engine/search.js:518` | `function think(pos, cfgIn)` | 入口 |
| `engine/search.js:521-522` | `const t0 / deadline` | **预算切分点**（A1 改动起点） |
| `engine/search.js:531` | `tacticalMove(pos, cfg)` | L0（不占预算） |
| `engine/search.js:542` | `threatSolve(pos, cfg, t0)` | **战术搜索（A1 要从这里切预算）** |
| `engine/search.js:425` | `function threatSolve(pos, cfg, t0)` | 战术预算实现处 |
| `engine/search.js:555-568` | `for (let d = 2; ...)` | **迭代加深循环（A1 主战场）** |
| `engine/search.js:569` | `const el = Date.now() - t0` | 收尾 |
| `engine/search.js:576` | `fallbackLevel:` | 语义变化点（见下） |

**具体改动**（统一为**一个**时间管理层，避免三条建议各自改 `think()` 造成冲突）：

```js
// ── 阶段 0：进入迭代循环前，先切分预算（Stahlfaust A4）
const BUDGET_K = Number.isFinite(cfg.layerFactor) ? cfg.layerFactor : 4;   // 层耗时预测系数
const TACT_RATIO = Number.isFinite(cfg.tacticalRatio) ? cfg.tacticalRatio : 0.35;
const stabilFactor = Number.isFinite(cfg.stabilFactor) ? cfg.stabilFactor : 0.97;
const stopEarly = Number.isFinite(cfg.stopEarly) ? cfg.stopEarly : 0.7;

// 战术预留：VCF/VCT 拿一笔独立预算，主搜索不得侵占
const tactBudget = Math.min(cfg.threatMs, Math.max(50, cfg.hardLimit * TACT_RATIO));
// → threatSolve 的 dl 由 t0 + tactBudget 给出（原来就是 min(threatMs, hardLimit)，仅把 hardLimit 换成切分后份额）
// 主搜索预算（★ v1.3：A1-c 会按 stabilFactor 收缩 ⇒ 必须 let，不是 const）
let budgetMax = Math.max(50, HARD - tactUsed);
let mainDeadline = t0 + budgetMax;   // 主搜索闸门，随收缩同步收紧
```

```js
// ── 阶段 1：迭代循环内的时间管理
let lastBestI = -1, lastTd = 0;
for (let d = 2; d <= cfg.maxDepth; d += 2) {
  // (a) 预测式停止（Carbon A7 / Stahlfaust A7 / PentaZen A1 三方共识）
  const now = Date.now();
  if (d > 2 && lastTd > 0 && now + BUDGET_K * lastTd >= deadline) break;   // 下一层必超时 → 不等被打断

  const tLayer0 = now;
  let r;
  try { r = rootSearch(pos, d, cfg, deadline, lo, hi, rootIdx); }
  catch (e) { if (e !== TIMEOUT) throw e; break; }
  lastTd = Date.now() - tLayer0;

  // (b) 最佳着法稳定性（PentaZen）——★ v1.3 修正：收缩的是"本手剩余预算"，不是层耗时预测
  //     （旧写法把 0.97 乘 lastTd ⇒ "预测更便宜 ⇒ 更敢开下一层"，方向恰好相反，会加重 A1-b 要消灭的废层）
  const bestI = r.move ? r.move.i : -1;
  if (bestI >= 0 && bestI === lastBestI && d >= 7) {
    budgetMax = Math.max(200, budgetMax * stabilFactor);   // 稳定 → 更早收手（省钱给后续手）
    mainDeadline = t0 + budgetMax;                         // 同步收紧主搜索闸门
  }
  lastBestI = bestI;

  // (c) 提前终止（PentaZen：实际耗时已过预算的 70% → 主动收手）
  if (Date.now() - t0 > budgetMax * stopEarly) break;

  if (r.move) { best = {x:r.move.x, y:r.move.y}; bestV = r.value; reached = d; rootIdx = r.move.i; }
  if (r.timeout) break;
  if (bestV >= MATE || bestV <= -MATE) break;
}
```
> `budgetMax` = 切给主搜索的那份额（`hardLimit − 战术实际耗时`）。

**接口/契约**
- 新增 `cfg` 字段（全部可省略，省略即用默认，见 §4.0.4）：
  `layerFactor`（默认 4，预测系数 K）、`tacticalRatio`（默认 0.35，战术预算占比）、
  `stabilFactor`（默认 0.97；★ v1.3 语义：乘在**本手剩余预算 `budgetMax`** 上——最佳着稳定 ⇒ 更早收手、
  省下的时间留给后续手，与 PentaZen"稳定 ⇒ 收缩 turnTimeMax"同义；**不是**乘在层耗时预测 `lastTd` 上）、
  `stopEarly`（默认 0.7）。
- **不新增位开关**：时间管理是"何时停"而非"搜什么"，退回旧行为 = 把 `stopEarly` 设 1.0 且
  `layerFactor` 设 `0`（即"永不预测性停止"；★ 2026-09-20 修正：原写 `Infinity` 会令预测条件恒真、d=4 即停，实测见 §4.0.4）。
- **`fallbackLevel` 语义不变**（§24.7）：`0` 时限内完成 / `1` L1 兜底 / `2` 被时限打断。
  ⚠️ 新增：预测式停止会导致**更少的"被时限打断"（2）**、更多的"主动停止（0）"——
  **基准工具读这一位时必须知道这一语义变化**（见下"可比性警告"）。
- **★ 新增观测导出**（供测试读，**只读**）：
  ```js
  // search.js:643 的返回对象里追加
  timeInfo: () => ({ budgetMax, tactBudget, lastTd, stopped }),
  //   budgetMax = 切给主搜索的份额；tactBudget = 切给战术的份额
  //   lastTd    = 最后一层的实际耗时；stopped = 是否因预测式/提前终止 break
  ```
  **必要性**：否则**测试无法断言"预测式停止真的生效了"**，只能看深度（间接、易误判）。

**★ 实现顺序（★ 必须分 3 步提交，不可一次写完）**：

| 步 | 内容 | 单独可验收 |
|---|---|---|
| **A1-a** | 只做**预算切分**（`tactBudget` 独立，主搜索 deadline = `hardLimit − 战术耗时`） | ✅ `timeInfo().tactBudget` 可断言 |
| **A1-b** | 只做**预测式停止**（`layerFactor`，即 Carbon/Stahlfaust/PentaZen 三方共识） | ✅ 深度不降 + 节点降 |
| **A1-c** | 只做**稳定性收缩 + 提前终止**（`stabilFactor` / `stopEarly`；★ v1.3：收缩对象 = `budgetMax`，若 P-B 显示收益不明可先只做 `stopEarly`） | ✅ 靠 `timeInfo().stopped` + `budgetMax` 收缩断言 |

**理由**：三者**可独立回滚**（各自 cfg 字段），合并提交会让"某一步退化"无法定位。

**代码落点详表（A1 专用）**：

```js
/* ── engine/search.js:521 附近，替换 ────────────────── */
const t0 = Date.now();
const HARD = Math.max(1, cfg.hardLimit);
const TACT_RATIO = Number.isFinite(cfg.tacticalRatio) ? cfg.tacticalRatio : 0.35;
const tactBudget = Math.min(cfg.threatMs, Math.max(50, HARD * TACT_RATIO));   // A1-a
const deadline  = t0 + HARD;              // 给"判是否被打断"用的总闸（不变）
/* ─────────────────────────────────────────────────── */

/* ── engine/search.js:542，替换 ─────────────────────── */
const tactT0 = Date.now();
const w = threatSolve(pos, cfg, tactT0, tactBudget);      // ★ threatSolve 加第 4 参
const tactUsed = Date.now() - tactT0;
let budgetMax = Math.max(50, HARD - tactUsed);            // A1-a：主搜索拿到剩余（★ let：A1-c 稳定收缩会改它）
let mainDeadline = t0 + budgetMax;
/* ─────────────────────────────────────────────────── */

/* ── engine/search.js:555-568，替换循环（★ v1.3：原 :556-564 的渴望窗两段【原样保留】——
      v1.2 草稿曾整段丢失，照抄会静默删除 M7 渴望窗特性并挂 search-enhance 测试） ── */
const BUDGET_K = Number.isFinite(cfg.layerFactor) ? cfg.layerFactor : 4;
const STAB     = Number.isFinite(cfg.stabilFactor) ? cfg.stabilFactor : 0.97;
const STOP_EARLY = Number.isFinite(cfg.stopEarly) ? cfg.stopEarly : 0.7;
let lastBestI = -1, lastTd = 0, stopped = false;
for (let d = 2; d <= cfg.maxDepth; d += 2) {
  const now = Date.now();
  if (d > 2 && lastTd > 0 && now + BUDGET_K * lastTd >= mainDeadline) { stopped = true; break; }  // A1-b
  /* ★ 原样保留（原 :556-557）：渴望窗 */
  let lo = -INF, hi = INF;
  if (lastRootValue !== null && d >= 4) { lo = lastRootValue - cfg.aspiration; hi = lastRootValue + cfg.aspiration; }
  const tLayer0 = now;
  let r;
  try { r = rootSearch(pos, d, cfg, mainDeadline, lo, hi, rootIdx); }
  catch (e) { if (e !== TIMEOUT) throw e; break; }
  /* ★ 原样保留（原 :561-564）：渴望窗失败 → 全窗重搜 */
  if (!r.timeout && (lo > -INF || hi < INF) && (r.value <= lo || r.value >= hi)) {
    try { r = rootSearch(pos, d, cfg, mainDeadline, -INF, INF, rootIdx); }
    catch (e) { if (e !== TIMEOUT) throw e; break; }
  }
  lastTd = Date.now() - tLayer0;
  const bestI = r.move ? r.move.i : -1;
  // A1-c（★ v1.3 修正）：稳定 ⇒ 收缩"本手剩余预算"（更早收手），不是层耗时预测
  if (bestI >= 0 && bestI === lastBestI && d >= 7) {
    budgetMax = Math.max(200, budgetMax * STAB);
    mainDeadline = t0 + budgetMax;
  }
  lastBestI = bestI;
  if (r.move) { best = { x: r.move.x, y: r.move.y }; bestV = r.value; reached = d; rootIdx = r.move.i; }
  if (r.timeout) break;
  if (Date.now() - t0 > budgetMax * STOP_EARLY) { stopped = true; break; }                // A1-c
  if (bestV >= MATE || bestV <= -MATE) break;
}
/* ─────────────────────────────────────────────────── */
```

⚠ **注意 `deadline` 与 `mainDeadline` 的分工**：`deadline`（`t0 + hardLimit`）保留给
`checkCancel` / 兜底；`mainDeadline`（`t0 + budgetMax`）是主搜索的真实闸门。
**两者都要传**，否则"战术超支"会被主搜索悄悄吃掉。

**验证**
- **探针 P-B 先行**：统计"被 `TIMEOUT` 打断那层已搜节点 / 总节点"。
  - 若浪费 **<5%** ⇒ 收益主要是"复杂局面多花时间"而非"省时间"，**仍需做**（因为收益正相关棋力），但**预期调低**。
  - 若浪费 **>15%** ⇒ 这是**改动最小、收益最确定**的一条，**第一个做**。
- **A1-a 验收**：
  ```sh
  node -e "
  const S=require('./engine/search.js'), core=require('./engine/core.js');
  const p=core.createPosition(); const r=S.think(p,{...S.DEFAULT,useBook:false,hardLimit:400});
  console.log(S.timeInfo());   // 期望：tactBudget ≈ min(900, 400*0.35)=140；budgetMax ≈ 400-tactUsed
  "
  ```
- **A1-b/A1-c 验收**（三方共识的核心断言）：
  ```sh
  node tools/bench-difficulty.js 4 80 freestyle easy,normal,hard,master
  #   期望：每档"实测深度"不降（或升）；且新增 [效应量] 打印每档 tactBudget/停止原因
  node --test test/search.test.js test/search-enhance.test.js    # 9 + 12 项必须全绿
  ```
- ⚠️ **可比性警告（C-6）**：改后"实测深度"与改前**不可直接比**（停止策略变了）。
  `bench-difficulty.js` 输出需加注释，或双方都用同一 `stopEarly` 设置再比。

**回滚**：`cfg.stopEarly = 1.0; cfg.layerFactor = 0; cfg.tacticalRatio = 1`（等价旧行为，战术不再预留但也不侵占；★ layerFactor 回滚值 2026-09-20 由 Infinity 修正为 0，理由见 §4.0.4）。
**★ 因为默认值就是"关"（§4.0.4），回滚实际 = 不传这些字段。**

**风险**：低。唯一注意——**过早停止会降低深度**；若"深度降而节点数没降"，说明 K 太大，需标定 K（建议在 3~5 之间扫）。

> ★★ **A1 整体回滚记录（2026-09-20 会话 8，实测否定）**——A1 三步实施并"验收通过"后，
> 在做统一 Elo 前的**作用前提检查**中发现该条在本引擎**全部难度档位下无正收益**：
>
> | 档 | hardLimit | maxDepth | 实测耗时/深度 | A1 触发 | A1开 vs 前 |
> |---|---|---|---|---|---|
> | normal | 1000ms | 5 | 52ms / 4.00 | stopped **0/8** | **0.0%** |
> | hard | 2000ms | 7 | 208ms / 6.00 | stopped **0/8** | **0.0%** |
> | master | 3000ms | 12 | 3018ms / **9.50** | stopped 8/8（旧默认 K=8） | **深度 −1.75 层** |
>
> ① **normal/hard 档搜索远早于时限完成**（52/208ms vs 1000/2000ms ⇒ 时限富余 10~19 倍）
> ⇒ **A1 无作用对象**：它优化"时限用尽时如何分配预算"，而这些档位根本用不到时限。
> 先前验收报的"L2 逐位一致 + timeDepthMean −37%"真相 = **省掉了根本用不到的时间**（空转减少），非收益。
> ② **master 档时限利用率 96.3%（2889/3000ms）本就无浪费**，A1 的外推停止纯属白丢层：
> K 扫描 **K=0 → 9.75 层** / K=1 → 9.00 / K=4 → 8.25 / K=8 → 7.75，**无任何 K 能追平 K=0**
> （本节"建议在 3~5 之间扫"的预警方向对，但标到 K=1 仍净负）。
> ③ **动机依据 P-B"68.4% 浪费"口径失真**：`tools/_probe-lastlayer.js:17` 默认 **`--ms=100`**，
> `:27` 用 `difficulty:'hard'` + **显式覆盖 `hardLimit=100`** ⇒ 该"浪费"只在人为压缩时限时成立。
>
> **处置（用户裁决选 A）**：**整体回滚为默认关**——`layerFactor` 默认 **0**、`stabilFactor` 默认 **1.0**、
> `stopEarly` 默认 **1.0**（= 本节 :546 旧行为）；**机制代码保留在 cfg 通道内**（可复现、档位变化后重评）。
> 回滚验证：master 档深度 **7.75 → 9.50 层**（+1.75），normal/hard 档不变。
>
> **回滚后收尾实测（2026-09-20）**：
> - **基线重采**（`--save --note A1-rolled-back --only=search`）：确定性指标 `depthFixedTotalNodes`
>   **821409 → 821409（逐位一致）** —— A1 只在硬时限路径生效，固定 maxDepth 路径不经过；`timeDepthMean`
>   3.85 → ~5.6（60ms 墙钟派生量，三次重复 5.45/5.55/5.75，±3% 自然波动，标 `〔墙钟，参考〕`不报警）；
>   `mates.totalNodes` **111317 四度不变**（不经过 A1/A2/A4 任何改动路径）；`--diff` 自洽 ✓。
> - **master 档快照**（`bench-difficulty 8 50 freestyle master`）:深度均 **7.00**（**中位 10**、范围 2–10）
>   —— 上界（中位/范围顶 10）即回滚收益的体现（A1 开时被压 7.75），均值被"安静中局早停"摊薄；
>   题库 **40/40**（门槛 30/30）⇒ 回滚未损杀棋能力。
> - **浏览器实跑（§34，已自动化）**：`node tools/browser-check.js`（**须沙箱外**，CDP 驱动真实事件循环）
>   一次跑三页 **PASS 3 / FAIL 0**：`browser-book-check.html`（主线程直调 `G.search.think`，HASH 校验 ✓）+
>   `browser-degrade-check.html`（`G.ai` forceMain 降级：backend=main + reason 非空 + hist 仍命中书招）+
>   `browser-worker-check.html`（**真机 Blob Worker 往返：init→move、`via=book`、`后端 = worker`**）。
>   **★ 修正**：先前"无头不可验 Worker、须人工"的结论不准确——真正不可用的是 `--dump-dom
>   --virtual-time-budget` 模式（虚拟时钟冻结 2s 握手定时器）；CDP 驱动真实事件循环下 Worker 往返完全正常。
>   （附带修掉真 bug：worker-check 页漏加载 `ui/ai.js` ⇒ `G.ai` undefined ⇒ promise 静默 reject。）
>   全量 **14 文件 179 项全绿**；worker **03d9f2fed663bd27**
>
> ★★ **新增验收纪律（本教训的固化）**：任何"时间/预算类"改动，**验收必须首先查作用前提**——
> 该档位下是否真的触达时限（`stopped` / `reached==maxDepth` / 时限利用率）。只看
> "确定性指标一致 + 耗时下降"会把**"根本没被用上"误报为"通过"**。
> ⇒ 时间类优化的判据应改为：**先用例得证"会撞时限"，再谈优化效果**。


---

### 4.2 A2 —— 剪枝补齐（PentaZen A2，**必须逐一开**）

**动机**
我们的 PVS 已有 LMR / IID / killer / history / quiescence，但**缺 PentaZen 的四个廉价剪枝**，
导致同深度节点数偏高 ⇒ 单位时间搜得更浅。

**上游出处**（PentaZen）：
- **VDP**（victory distance pruning，`search.cpp:356-361`）；
- **razoring**（`:444-446`）；
- **extended futility**（`:448-450`）；
- **着法数裁剪**（`:471-478`，深且前几个着法都不好时直接砍尾部）。

**落点**（★ 已核对）：

| 文件:行 | 符号 | 用途 |
|---|---|---|
| `engine/search.js:31-37` | `H_LMRF…H_MALUS` / `H_ALL=63` | **位分配处**（见 §4.0.3） |
| `engine/search.js:304` | `function pvs(pos, depth, alpha, beta, cfg, ply, deadline)` | **A2a/A2b/A2c 的插入点（入口附近）** |
| `engine/search.js:304` 之后 | `if (depth <= 0) return quiesce(...)` | **A2a VDP 必须在它之前** |
| `engine/search.js:216` | `function genMoves(pos, cfg, ply, ttMove)` | **A2d 需要读着法数** ⇒ 此处或 `:374` 循环内 |
| `engine/search.js:374` | `let alpha = lo, bestM = null, bestV = -INF, …` | **A2d 着法数裁剪的循环变量** |
| `engine/search.js:260` | `function quiesce(...)` | **A2b razoring 要调它** |
| `engine/search.js:157` | `function ttStore(...)` | **早退分支"不写 TT"的判定点** |

**具体改动**（按 PentaZen 顺序插入，**每块一个开关**）

```js
// ★ 位开关定义见 §4.0.3（不在此重复），此处只写判定逻辑

/* ── engine/search.js:304 之后，pvs 入口，depth<=0 之前 ── */
// A2a VDP（victory distance pruning）
if (H & H_VDP) {
  const mateMax = PAT.WIN - ply;              // 当前 ply 下理论最快取胜分
  if (alpha >= mateMax) return mateMax;      // 已不可能更好 ⇒ 直接返回
  if (beta < -mateMax + 1) return -mateMax + 1;
}
if (depth <= 0) return quiesce(pos, alpha, beta, cfg, ply, deadline);
/* ─────────────────────────────────────────────────────── */

/* ── 在着法循环内（:374 之后，取每个着法之前） ────────── */
const isPV = (beta - alpha) > 1;             // 非 PV 判定（零窗 ⇒ PV）
const se   = EV.staticEvalPos(pos, cfg);     // ★ 已有增量版，必须用它（不用全量 staticEval）

// A2b razoring
if ((H & H_RAZOR) && !isPV && depth <= 2 && se + 200 * depth < alpha) {
  const q = quiesce(pos, alpha, beta, cfg, ply, deadline);
  if (q < alpha) return se;                  // ★ 不写 TT（见"接口/契约"）
}
// A2c extended futility
// ★ v1.3 补定义（原稿"forcing 着法"未定义，本引擎无现成谓词——实施前必须按此执行）：
//   forcing 着法 = 落子后己方存在 ≥ 冲四/活三威胁的着法。实现二选一：
//   A) 廉价近似（首选）：EV.moveScoreAt(board, m.i, stm, cfg)（eval.js:59）≥ 活三分值
//      （分值口径 = PAT.singleScore(PAT.P.OPEN_THREE, ...)，按角色/规则取值；阈值待 P-D/微基准标定）
//   B) 精确判定（备选）：threat.js 的威胁类别（贵；仅当 A 的题库回归证明误杀不可接受时换用）
if ((H & H_FUTILE) && !isPV && depth <= 3 && se + 120 * depth <= alpha) {
  // 只搜 forcing 着法；其余跳过（不 return，继续循环）
}

// A2d 着法数裁剪（在循环内，已试 k 个着法后）
if ((H & H_MCUT) && depth <= 4 && k >= 4 + depth * depth && bestV < alpha + 40) break;
/* ─────────────────────────────────────────────────────── */
```
⚠ **`EV.staticEvalPos` 需 `pos` 已 `attachCache`**——`think()` 在 `:526` 已做，**pvs 内安全**。
⚠ **`isPV` 的判定**：`beta - alpha > 1` ⇒ 全窗（PV）；**零窗不算 PV**。
这是本项目既有风格（`H_LMRR` 的用法即基于此），**不要另发明**。

**接口/契约**
- 新增 `cfg.h` 的四个位（**分配见 §4.0.3**：`64/128/256/512`）。
  ★ **与 §4.0.3 的"默认关"纪律一致**：
  **`H_ALL` 保持 63 不变**，四位**逐个验收通过后才并入 `H_ALL_NEW`**。
- TT 存分契约不变：所有剪枝返回的值**仍走 `ttStore`**，但 razoring/futility 返回的是
  **估值而非搜索值** ⇒ 必须**以 `BOUND_NONE` 语义存储**或**不存储**（避免污染 TT）。
  ⚠️ **关键正确性点**：`score_to_tt` 的 ply 补偿（我们已有）**不能**应用在未搜索的估值上。
  ⇒ **规定：razoring/futility 的早退分支不写 TT**（保守做法，损失少量 TT 命中换正确性）。

**★ 实现顺序（逐一开，禁止一把全开）**：

| 步 | 开关 | 先验预期 | 单独验收 |
|---|---|---|---|
| **A2a** | `H_VDP` | 节点↓，**结论必须完全不变**（纯正确性剪枝） | 等价性 diff == 0 |
| **A2b** | `H_RAZOR` | 节点↓↓，**可能有极少数边界局面分数变** | 节点 ≤ 基线×0.9 + 题库不降 |
| **A2c** | `H_FUTILE` | 节点↓ | 同上 |
| **A2d** | `H_MCUT` | 节点↓，**风险最高**（可能砍掉正解） | 题库**必须**不降 |

> ★ **A2 收官验收记录（2026-09-20，四条全部实施+实测）**：
>
> | 位 | 节点（40 中局） | 深度 | 题库 | 实战快验（30 局 hard 自对弈） | 裁决 |
> |---|---|---|---|---|---|
> | A2a VDP | −0.3% / 杀题 **0.0%**（PVS 窗口结构下无触发场景） | = | 40/40 | 未跑（收益为零无需验证） | **弃，留档** |
> | A2b RAZOR | **−44.2%** | 未单测 | 40/40 | Elo −34.9，分层 CI [−155.4, +85.6] 含 0 | **并入 H_ALL** |
> | A2c FUTILE | −62.0% | 8.00→**7.65**↓ | 40/40 | Elo(A−B) **+133.6**，CI [+17.4, +249.8] **不含 0** | **弃（实战掉分）** |
> | A2d MCUT | −30.9% | = 8.00 | 40/40 | Elo −23.2，CI [−136.5, +90.1] 含 0 | **并入 H_ALL** |
>
> ⇒ **`H_ALL` 63→703**（独立提交；全量 14 文件回归绿 + 效果层基线 search 段重采：
> depthFixedTotalNodes 1862725→**820425**（−56%，剪枝直接体现）；mates 段重采后 totalNodes 111317
> 逐位不变 = 交叉验证 mates 走专用威胁求解路径、不受 pvs 位开关影响）。
> **★ 新教训：题库不降 ≠ 实战不降**——A2c 题库 40/40 全过仍掉 ~134 Elo，
> **深度回落是领先风险指标**（省 62% 节点没换来深度 ⇒ 剪掉的着法不产 TT 条目、迭代效率反降）。
> A2b 已知特性：零窗 razoring 返回值被父节点镜像成 fail-high ⇒ 分数方向性乐观偏置
> （40 中局 diff 40/40，35↑/5↓；margin 200/300 与 return se/q 均不改此结构性），
> 30 局快验未见棋力伤害，量级效应留批次收尾统一 Elo 复核。

**★ 先做 A2a 的理由**：VDP 是**纯数学剪枝**（不引入估值），
⇒ **正确性可证**（等价性必须 100% 一致），**是四个里唯一"零风险"的**。
先拿它建立"位开关机制工作正常"的信心，再上 b/c/d。

**验证**
- ★ **铁律（C-4）：逐一开启、逐一基准**。一次只开一个位，跑 Elo CI + 题库。
  四项一起开 = 无法归因（这是 PentaZen 文档明确警告的）。
- **统一验证命令**（每条）：
  ```sh
  # ① 等价性（A2a 必跑，b/c/d 参考）
  node -e "
  const S=require('./engine/search.js'), core=require('./engine/core.js');
  const POS=require('./test/data/positions40.json');   // 若未生成，用 4 个硬编码局面
  const H0=S.H.ALL, H1=S.H.ALL|64;                     // 逐个替换 64→128/256/512
  let diff=0;
  for(const p of POS){
    const mk=()=>{S.ttClear();const q=S.posFromBoard(p.board,p.stm,p.hist);S.attachCache(q,true);return q;};
    const a=S.think(mk(),{...S.DEFAULT,useBook:false,h:H0,maxDepth:8,hardLimit:600000});
    const b=S.think(mk(),{...S.DEFAULT,useBook:false,h:H1,maxDepth:8,hardLimit:600000});
    if(a.score!==b.score||a.move.x!==b.move.x||a.move.y!==b.move.y) diff++;
  }
  console.log('diff =',diff,'/',POS.length);
  "
  # ② 节点/深度效应量
  node tools/bench-search.js 40 60 8
  # ③ 题库不退化（★ 最硬的护栏）
  node --test test/mates.test.js
  # ④ 全量
  for f in test/*.test.js; do node --test "$f" 2>&1 | grep -E "^# (tests|pass|fail)"; done
  ```
- **门槛（初值，见 `test-methodology.md` §4.6）**：
  节点 **≤ 基线×1.05**（改进时 `console.log` 报效应量）/
  等价性（A2a）**diff == 0** / 题库通过率 **不降**。
- **等价性护栏**：写只读探针，对一批固定局面比对"开/关该剪枝"下的**根着法与分数**，
  差异必须**仅出现在"分数接近 alpha 的边界局面"**，不允许大量不一致。

**回滚**：`cfg.h` 去掉对应位（**或直接不传 `h`，即回落 `H_ALL=63`**）。

**风险**：中低。**最大风险 = 剪枝引入错误搜索值**（尤其 razoring/futility 的估值早退）。
缓解：① 不写 TT；② 逐一开；③ 与全开搜索做等价性对拍。

---

### 4.3 A3 —— VCF 与 αβ 耦合（PentaZen A3）

**动机**
我们的 `threat.js:vcfWin` **已经存在且 sound**（`dfs` 每节点先排除对方成五点），
`search.js:threatSolve()` 也调用了它——**但只在根层**，且 `vcfDepth`/`vctDepth` 在
**出厂 `DEFAULT` 里是 `0`（等于常关）**（实测 `search.js:57`）。
⇒ 搜索树内部**完全不知道 VCF 的存在**，叶节点只做 `quiesce`。

**上游出处**：PentaZen `search.cpp:369-376`——叶节点 `staticScore < beta` 且己方有 B3 时试 VCF，命中即返回杀分。

**落点**（★ 已核对；★ v1.3 校正：`depth<=0` 实际在 **:311**）：`engine/search.js:311`（`if (depth<=0) return quiesce(...)`，
A3 在**它之前**插入 VCF 分支）；`engine/search.js:425`（`threatSolve`，根层预算）；`engine/threat.js:299`（`vcfWin`）。

**具体改动**
```js
if (depth <= 0) {
  // (a) 先做 VCF（PentaZen：叶节点先试杀，命中直接剪）
  // ★ v1.3 修正①：pos 没有 .win 字段（core.js:41-42 只有 board/stm/stones/zob*/hist/lc/onCell），
  //   v1.2 的 `!pos.win` 恒真（无害但误导）⇒ 改为显式判定"上一步是否已成五"：
  //     const i = pos.hist[pos.hist.length - 1];
  //     const justWon = i !== undefined && RU.isWin(pos.board, core.xOf(i), core.yOf(i),
  //                                                 opp(pos.stm), cfg.rule, cfg.overlineMode);
  // ★ v1.3 修正②：原稿 `o.rule / o.overlineMode` 的 `o` 未定义 ⇒ 统一为 cfg.*
  if ((H & H_LEAFVCF) && cfg.leafVcfDepth > 0 && !justWon) {
    const w = THREAT.vcfWin(pos, pos.stm, {
      depth: cfg.leafVcfDepth, budget: cfg.leafVcfBudget,
      deadline, rule: cfg.rule, overlineMode: cfg.overlineMode,
    });
    // ★ v1.3 修正③（2026-09-20 实测新增缺陷）：原稿 `PAT.WIN - 1000 - ply` **口径错误**。
    //   它 = MATE − ply < MATE，破坏三处杀分语义：① `think()` 的 `bestV >= MATE` 见杀早停失效
    //   （实测迭代加深白跑更贵的层，节点 +数倍）② `toTT/fromTT` 的 `v >= MATE` 分支不命中
    //   ⇒ TT 不带杀语义、ply 补偿丢失 ③ `bench-mates`/分析侧 `|score| >= 99999000` 判据漏判
    //   （实测把已解出的题误判为未解：正解分 99998994 < 99999000）。
    //   ⇒ 统一为与 pvs 成五返回 **完全一致** 的杀分口径 `PAT.WIN - ply`。
    if (w) return PAT.WIN - ply;
  }
  return quiesce(pos, alpha, beta, cfg, ply, deadline);
}
```
> **顺序很重要**：**先 VCF 再 quiesce**——若反过来，quiesce 会先把该局面"平静化"，
> VCF 的机会就丢了。这与 PentaZen 的"叶节点先试 VCF"一致。

**接口/契约**
- 新增 `cfg.leafVcfDepth`（默认 **0 = 关**，与主 `vcfDepth` 分离）、
  `cfg.leafVcfBudget`（默认 `2000`，**必须远小于**根层 budget，否则每叶节点都贵）。
- 新增位开关 `H_LEAFVCF = 1024`。
- **返回口径**：与既有 `MATE = PAT.WIN - 1000` 一致；**`mate`/`mateLen` 语义不变**。
- ⚠️ **禁手兼容**：`vcfWin` 在 renju 下必须传 `rule/overlineMode`（已在上面示例中传），
  且**黑方禁手点不得被选为 VCF 的落点**——`threat.js` 的 `dfs` 已做（`ALREADY`/`AFF`），
  但**新增此调用点后必须重跑 `test/forbidden.test.js`（12 项）**。

**验证**
- **基线**：P-D 先给出"当前（根层 VCF）题库通过率 + 耗时"。
- 改后：**题库通过率不降**（`tools/bench-mates.js`）+ **节点数不爆**（叶 VCF 有 budget 上限）+
  `test/mates.test.js`（4 项）全绿 + `test/threat.test.js`（14 项）全绿。
- **成本护栏**：统计"叶 VCF 调用次数 / 命中次数"，命中率 <2% 则应关掉（够不着成本）。
- **验证命令**：
  ```sh
  node tools/bench-mates.js                                    # 题库通过率 + 耗时（★ 主护栏）
  node tools/bench-search.js 40 60 8                           # 节点数不爆
  node --test test/mates.test.js test/threat.test.js test/forbidden.test.js
  #  ★ forbidden 必跑：新增 VCF 落点后不得让黑方走禁手（#33 的护栏）
  ```
- **门槛**：题库通过率 **≥ 基线**；节点 **≤ 基线×1.05**；叶 VCF 命中率 **≥ 2%**（否则关掉）。

**★ 实测（2026-09-20，`tools/bench-leafvcf.js`，根层 vcfDepth/vctDepth 一律置 0 以隔离叶 VCF 净贡献）**：

| 指标 | 门槛 | 实测（叶深度 6 / 预算 2000） | 判定 |
|---|---|---|---|
| 题库通过率 | ≥ 基线 | 关 **4/40 (10%)** → 开 **39/40 (98%)**，Δ=+35（仅 vcf10 最长链未解） | ✅ 大幅超额 |
| 叶 VCF 命中率 | ≥ 2% | 调用 48155 / 命中 16306 = **33.86%** | ✅ 大幅超额 |
| 节点数 | ≤ ×1.05 | 安静中局 **−25.9%**（236350→175179）；`leafvcf.test.js` 独立复现 ×0.98 | ✅ |
| 单题见效 | — | 题 0（vcf10）：depth 8→**2**、节点 18144→**391**（−98%）、1448ms→289ms | ✅ |
| 墙钟耗时 | — | 安静中局 **+201.8%**（每叶节点都跑一次 VCF，虽命中率低但调用次数多） | ⚠ 成本 |

**★ v1.3 缺陷（2026-09-20 实测新增，已修正）**：施工图伪码的 `PAT.WIN - 1000 - ply` 口径**错误**——
它 = `MATE − ply` **< `MATE`**，破坏三处杀分语义：
① `think()` 的 `bestV >= MATE` 见杀早停判不出（实测迭代加深白跑更贵的层）；
② `toTT/fromTT` 的 `v >= MATE` 分支不命中 ⇒ TT 不带杀语义、ply 补偿丢失；
③ `bench-mates`/分析侧 `|score| >= 99999000` 判据漏判（实测把已解出的题 99998994 误判为未解）。
⇒ 已修正为与 pvs 成五返回**完全一致**的 `PAT.WIN - ply`。修正前实测题库 3/40，修正后 39/40。
回归护栏：`test/leafvcf.test.js` 的「★A3 杀分口径」用例显式断言该不等式。

**★ Elo 裁决（2026-09-20，`tools/bench-a1-elo.js`，交叉开局 useBook:false）**：

| 档位 | 局数 | Elo(A−B) | 分层 95% CI | 判定 |
|---|---|---|---|---|
| hard-i100 vs hard-i100-**lv6** | 30 | +46.6 | [−96.3, 189.5] | 无显著（CI 含 0） |
| hard-i100 vs hard-i100-**lv6** | **60** | **+147.2** | **[31.1, 263.2]** | **A 显著更强（CI 不含 0）** |

A = 无叶 VCF，B = 有叶 VCF ⇒ **叶 VCF 在 100ms/手 预算下让棋力下降 ≈147 Elo**。

**根因**（与 A1 的 `FUTILE` 教训同构）：叶 VCF 命中率虽高（33.9%），但**每个叶节点都要付一次
VCF 调用成本**——在 100ms 这种紧预算档，成本直接挤占搜索深度（安静中局墙钟 +201.8% 即证据）。
**题库不降 ≠ 实战不降；耗时/深度回落才是领先风险指标**（同 §4.2 A2c FUTILE 的 −134 Elo）。

**⇒ 裁决**：A3 **不并入 `H_ALL`**（位 `H_LEAFVCF=1024` 保留、`leafVcfDepth` 默认 0 留档）。
机制代码、测试、探针全部保留，供**大预算档**（master / 无限时分析）按需开启，或后续与
「叶 VCF 只在**深度不足**时才跑」等成本控制方案组合后重测。

**回滚**：`cfg.leafVcfDepth = 0`（**默认即 0 ⇒ 不传字段即回滚**）。

**风险**：中。**VCF 成本可能 > 收益**（尤其每叶节点都跑）⇒ 用 `leafVcfBudget` 硬限 + 命中率监控。

---

### 4.4 A4 —— 取胜线 verification search（PentaZen A4 + Stahlfaust A1 同源）

**动机**
我们的搜索**一旦返回 `>= MATE` 就认为必胜**，但若 `pvs` 有 bug（或 TT 污染），会**错报胜着**——
在有 bug 的引擎里这是**致命的**（输掉本该赢的棋）。PentaZen 在胜着后做**窄窗复核**。

**上游出处**：
- PentaZen `search.cpp:520-527`：`score > MATE` 时用窄窗重搜验证，失败则 `cautious = true` 全窗重搜。
- Stahlfaust `GBThreat.cs:405-478` `DefenseRefutes`：**从对手视角独立验证**候选线是否可被反驳。
  （两者同源：都要求"胜着的第二个证据"。）

**落点**（★ 已核对）：`engine/search.js:392`（`if (v > bestV) { bestV = v; bestM = m; }`——
**bestV 确定处**）；`:396`（`if ((H & H_ROOT) && … ) ttStore(...)`，**A4 复核须在它之前**）。

**具体改动**
```js
// 在返回 PV 值之前（非零窗节点不验，省成本）
if ((H & H_VERIFY) && beta - alpha > 1 && bestV >= MATE && ply >= 1) {
  // 窄窗复核：仅验证"是否真的 >= MATE"（不是重搜整棵树）
  const v2 = -pvs(pos, depth, -Math.min(MATE, beta - 1) - 1, -MATE + 1, cfg, ply, deadline);
  if (v2 < MATE) bestV = v2;      // 复核失败 → 降级为真实值
}
```
> **注意**：这里不是"重搜整棵子树"，而是**用一个窄窗再确认一次**（成本可控）。
> 若成本仍高，可只在 `ply <= 2` 或 `depth >= 4` 时验。

**接口/契约**
- 新增位开关 `H_VERIFY = 2048`，**默认开**（它只防错报，不改变正常搜索值）。
- ⚠️ **必须先确认 `MATE` 口径**：现有 `MATE = PAT.WIN - 1000`（实测 `search.js`），
  与 `PAT.WIN = 1e8` 配合 ⇒ `MATE = 1e8 - 1000`。复核窗口必须在此量纲内，**不得混淆 §13 的 `FORBIDDEN = -1e9`**（那是**排序分**专用，且已由 `FORBID_SORT` 处理）。

**验证**
- **构造错报场景**：写只读探针，人为污染 TT 或注入浅深度胜分，确认 `H_VERIFY` 能拦下错报。
- 改后：`test/search.test.js` + `test/search-enhance.test.js` + 题库**分数不变**（复核应"总是通过"，因为正常情况下无错报）。
- **成本**：统计"复核触发次数 / 总节点"，应 <1%。
- **验证命令**：
  ```sh
  node --test test/search.test.js test/search-enhance.test.js
  node --test test/mates.test.js          # ★ 关键：窄窗设错会把真胜着判失败 ⇒ 题库必跑
  node tools/bench-mates.js               # 通过率 + 耗时
  ```
- **门槛**：题库通过率 **≥ 基线**（**这是硬红线**）；复核触发率 **< 1%**；节点 **≤ 基线×1.05**。

**回滚**：`cfg.h` 去掉 `H_VERIFY`（或 `cfg.verifyWin=false`）。

**风险**：低。**唯一注意**：窄窗设置错误会**把真胜着误判为失败** ⇒ 必须先用"已知必胜局面"回归。

> ★ **A4 实施记录（2026-09-20，已并入 H_ALL）**——对上述规格的三处偏差（均对齐 PentaZen 原义后裁决）：
> ①**落点 = pvs 着法循环内 per-move**（PentaZen :520-527 在 undo 前）；本施工图原写 rootSearch bestV 处，
> 但其伪码条件 `ply >= 1` 在 rootSearch（无 ply 递增，恒 0）下是**死代码**——缺陷⑤；
> ply 坐标系换算：PentaZen 循环内 ply 已 ++（其 `ply>=2` = 根的直接着法不验）⇒ 本引擎 pvs 参数 = `ply >= 1`。
> ②**双层复核**：窄窗 (−MATE, −MATE+1) 试探 → fail-low 才全窗 cautious 重搜——单层会把窄窗边界毛刺
> （MATE−1）误当真实值降级真胜线。③**cautious = 重搜期间清 `H_MCUT` + 清 `H_VERIFY`**（防嵌套；
> 对齐 PentaZen :472 move-count 剪枝豁免——A4 恰是 A2d 的兜底）。另：直接成五（规则级事实）不复核；
> **TT 污染不在防御范围**（同 TT 复核被 ttProbe 短路；防线 = key 校验 + 规则盐）——
> 本节"污染 TT 验证拦截"属可执行性缺陷⑥。
>
> **验收（确定性口径：maxDepth 12 固定 + hardLimit 600000；★ 教训：硬时限下深度随机 → 分数不可复现，
> v1 的 diff 13/40 全是深度噪声）**：40 中局 **diff 0/40**、mates ATTACK/DEFENSE **diff 0/48**（真胜线零误伤）、
> 节点 **+0.13%**（门槛 ×1.05）、复核触发 **0.053%** 节点（门槛 <1%）⇒ 全过。
> **`H_VERIFY` 并入 `H_ALL`（703→2751）**；验收计数器 `S.verifyStat()` 留档。

---

### 4.5 A7 —— VCF/VCT 反向验证（Stahlfaust A1）

**动机**
`vcfWin/vctWin` 已是 sound（`dfs` 每节点排除对方成五点），但**只有"我搜到一条线"这一个证据**。
Stahlfaust 的做法是**追加一次"从对手视角的反驳扫描"**，把"疑似有杀"升级为"确认有杀"。

**上游出处**：Stahlfaust `GBThreat.cs:400-478`——`DefenseRefutable` → 棋盘取负 `Flip()` → 递归 `DefenseRefutes`。
**完备性依据**（`doc/solution.tex:435-450`，全文最优雅）：`maximumCategory = 攻方类别 − 1`
⇒ 守方只需类别 ≤1 的威胁 ⇒ 类别 1 总有**单子解** ⇒ 守方搜索**完备**。

**落点**（★ 已核对）：`engine/threat.js:266`（`function solve(useThree, pos, atk, opts)`——
**在其 `return true` 前追加一次 `refutePath`**，**不动 `dfs`**）；
`engine/threat.js:299-300`（`vcfWin`/`vctWin` 的箭头函数，**加 `opts.verify` 透传**）；
`engine/search.js:425-546`（`threatSolve` 返回前，**可选**调用）。

**具体改动**
```js
// ── threat.js 新增（不改 dfs）
/**
 * 反向验证：把我方找到的杀线 path 交给"对手视角"再验一遍。
 * 对 path 上每个我方关键落点 p_k，检查对手是否有"先成五 / 更快的威胁"能抢在我们前面。
 * 返回 true = 该线可被反驳（应撤回）。
 */
function refutePath(pos, atk, path, opts) { ... }
```
- **低成本版**（Stahlfaust 文档建议）：不改 `dfs`，只在 `solve()` 返回 `true` 时**追加一次**
  "对手最强反击扫描"——枚举对手在**我方 path 上每个关键落点**能否先成五 / 造更快威胁。
  任一点对手能抢到 ⇒ 撤回该线。
- ⚠️ **renju 兼容**：`refutePath` 必须接受 `rule/overlineMode`；**禁手局面下"对手威胁"的定义会变**
  （黑方禁手点不算威胁）。**先在 freestyle 上做**，renju 单独交叉验证。

**接口/契约**
- `threat.js` 导出新增 `refutePath`（**纯新增，不改任何既有导出签名**）。
- `vcfWin/vctWin` 增加**可选** `opts.verify = true`，默认 **false**（保持既有行为）。
- 返回结构不变（仍是 `{move, path, nodes, via}`）。

**验证**
- **P-D 基线**：现有题库通过率。
- 改后：**题库通过率不得下降**（反向验证若误杀会降）——`tools/bench-mates.js`，
  且必须用 **`tools/verify-mate.js` 独立复算器**交叉确认。
- `test/threat.test.js`（14 项）+ `test/mates.test.js`（4 项）+ `test/forbidden.test.js`（12 项）全绿。
- **重点**：确认**不产生假阴性**（把真有杀的局面判成无杀）——这是本条最大风险。
- **验证命令**：
  ```sh
  node tools/bench-mates.js               # ★ 主护栏：通过率不得降（假阴性会在此暴露）
  node --test test/threat.test.js test/mates.test.js test/forbidden.test.js
  #  独立复算交叉确认（★ 不要只信引擎自报）：
  node -e "
  const V=require('./tools/verify-mate.js'), M=require('./engine/data/mates.js');
  let fp=0;   // 假阳性：引擎说有杀但复算器否
  for(const q of M.ATTACK){
    const r=V.solveAndVerify(q.stones,q.atk,{vcfDepth:20,vcfBudget:300000,useVerify:true});
    if(!r.ok) fp++;
  }
  console.log('独立复算：OK',M.ATTACK.length-fp,'/',M.ATTACK.length);
  "
  ```
- **门槛**：独立复算 **≥ 基线（40/40）**；假阴性 **== 0**。

**★ 实测（2026-09-20 收官）**：
- 实现：`threat.js` 新增 `refutePath(pos, atk, path, opts)`（**纯新增**，不改 `dfs`、不改既有导出）；
  `solve()` 在 `return true` 前追加 `if (o.verify && refutePath(...)) continue;`（默认 **false** ⇒ 零影响）；
  `verify-mate.js` 的 `solveAndVerify` 加 `useVerify` 透传。
- **门槛全过**：独立复算 verify 关 **40/40** → verify 开 **40/40**，**假阴性 == 0**。
- 新增 `test/threat-verify.test.js` **7 项**全绿。
- **回避 `H_ALL` 改位**（纯新增 + 默认关）⇒ 无需 Elo（§5.5.2 只有 A1/A3/A2 换深度需 Elo）。

**★★ 三个实测踩坑（v1.3 补充，均已在代码注释留档）**：
1. **path 语义**：`dfs` 的 `path.push(i)` **只推攻方手**，守方应手是 dfs 内部直接 makeMove、**不入 path**
   （见 dfs 的 `cnt === 1` 分支）⇒ path = **纯攻方手序列**（与 `verifyPath` 的解释一致）。
   首版 refutePath 误当"攻守交替"重放 ⇒ 全盘错乱。**refutePath 必须自己补守方强制应手**。
2. **攻方终局优先（否则误杀真杀）**：必须先判"攻方这一手是否成五/留下 ≥2 成五点"，
   是 ⇒ 该线成立、直接通过；**再**查守方成五点。漏了这一步会把"攻方活四 + 守方另有无关成五点"
   的合法线误杀——实测题库**题 34/37 因此被误判无杀**（即施工图预警的"本条最大风险：假阴性"）。
3. **path 前缀可能已在盘上**（调用方从既有局面起搜时 path[0] 常是已落的 first 手）⇒ 按"已走过"
   跳过并校验归属，**不得**当作路径损坏；但若该点是**对方**子 ⇒ 路径确不可信，判可反驳。

**回滚**：`opts.verify` 不传（默认 false）。

**风险**：中。**收益**：直接改善 `coach.hint` 的 `mate` 标签可信度（§10 提示功能的用户信任度）。

---

### 4.6 A12 —— 算子化威胁枚举（Stahlfaust A2，纯新增）

**动机**
`threat.js` 里"成五点 / 活三点 / 冲四点"的枚举**散落在多处**，未来任何"威胁序列搜索"
（VCF/VCT/db-search）都要重写一遍。Stahlfaust 把它统一为**算子对象**。

**上游出处**：Stahlfaust `GBOperators.cs`——`fAdd[n] = (x, y, value)`，
`value ∈ {+1 攻方落子, −1 守方落子}`；**一个算子 = 一次威胁 + 它强制产生的防守**。

**落点**（★ 已核对）：**新增** `engine/operators.js`（不改 `threat.js`）。
参考现有实现：`engine/threat.js:32`（`hasFivePoint`）/`:44`（`winningPoints`）/
`:266`（`solve` 内的威胁枚举，**算子化的抄写对象**）。

**具体改动**
```js
// engine/operators.js（纯新增模块）
// 算子 = { add:[{x,y,v}], cls, key }
//   cls: 0=Five, 1=Four/StraightFour, 2=Three/BrokenThree（对齐 Stahlfaust 的 category）
// 六类：Five / Four / StraightFour / Three2 / Three3 / BrokenThree
function legalOperators(pos, atk, opts) { ... }   // 返回可用算子列表
```
- **必须同步三处**（铁律，见 §4.0.2）：① `index.html` script 列表 ② `tools/build-worker-src.js` 的 `FILES`
  ③ 依赖它的模块。打包顺序建议插在 `threat` **之后**（它依赖 `patterns`/`rules`）。
- **★ 三处同步的"正确插法"**（照抄，勿凭感觉）：
  ```js
  // tools/build-worker-src.js 的 FILES 数组：
  'engine/core.js', 'engine/patterns.js', 'engine/rules.js', 'engine/eval.js',
  'engine/threat.js',
  'engine/operators.js',        // ★ 插在这里（threat 之后、search 之前）
  'engine/search.js', ...
  ```
  ```html
  <!-- index.html 的引擎段 script 列表：同样位置 -->
  ```
- **新增测试** `test/operators.test.js`：算子枚举必须与 `threat.js:threatMoves` **逐局面等价**
  （写对拍探针）。

**接口/契约**：纯新增，**不触碰任何既有导出**。

**验证**
- 对拍 `threatMoves`（等价性）+ `test/worker.test.js` 的 **FILES 顺序 / 页面顺序校验**。
- **验证命令**：
  ```sh
  node --test test/operators.test.js      # 新写的对拍测试
  node tools/build-worker-src.js          # ★ 重新打包（改了 FILES 必跑）
  node --test test/worker.test.js         # ★ FILES 顺序 / 页面顺序 / 打包新鲜度校验
  for f in test/*.test.js; do node --test "$f" 2>&1 | grep -E "^# (tests|pass|fail)"; done
  ```
- **门槛**：对拍 **diff == 0**（逐局面逐算子一致）；`worker.test.js` **14 项全绿**。

**回滚**：删除模块 + 三处同步点（或保留模块但不引用）。

**风险**：低（纯新增）。**收益**：为 A7（反向验证）/ A8（db-search 式搜索）铺路，
统一 §35 杀法库的结构。

---

### 4.7 A6 —— 增量材料表（PentaZen A6，**只做计数**）

**动机**
`levelAt` 返回等级但**不维护全盘材料计数**（F4/B4/F3 各多少个）。PentaZen 用
`material[pieceCnt][p][m]` + `materialInc` 做 O(1) 查询，并用它支撑 `check_wld`（A5）。

**上游出处**：PentaZen `board.cpp:303-349`（`update_material_see`）、
`board.h:184-195`（`materialInc[2][10]`、`material[226][2][10]`）。

**落点**（★ 已核对）：`engine/core.js:40`（`createPosition()`，加 `material` 字段）、
`:46`（`makeMove`，加计数）、`:59`（`unmakeMove`，反向）、`:42`（`lc`/`onCell` 字段声明处，
**复用这个钩子**）；`engine/patterns.js:466`（`newLineCache`，**4 条线枚举的现成实现，抄它**）、
`:514`（`countBoth`，**全量重数的现成实现，用作自检基准**）。

**具体改动**
- 在 `pos` 上挂 `material: Int32Array(2*10)`（**先只做计数，不做 `see` 位掩码**，
  因为计数的收益明确，位掩码风险高）。
- `makeMove` 时：对过 `idx` 的 **4 条线**重算该线的单棋型计数，`material[player][cls] += delta`；
  `unmakeMove` 反向。
- **复用既有钩子结构**：`pos.onCell`（§33.3 M3b 已用于 `pos.lc` 线分缓存）——
  **不引入第二套钩子机制**，避免与 `lc` 维护冲突。

**接口/契约**
- **加法型**：`pos.material` 是新增字段，**既有 `pos.lc` / `pos.score` 语义不变**。
- ⚠️ **口径必须与"严格判定"一致**（Carbon A2 的教训）：
  **不要缓存"等级计数"**（我们的 `levelAt` 有**规则/角色/手番三维**，
  且 `FORBID_SORT` 只影响排序）。**只缓存"是否存在 ≥ 四 的点"这类二值、规则无关的事实。**
  ⇒ 这足够支撑 A5，且避开三维口径问题（避免重演 §13 ⑤(e) 的"窗口 vs 严格"不一致）。

**验证**
- `test/incr.test.js`（7 项）+ **新增**"材料计数 == 全量重数"的**自检**（A13）。
- `test/patterns.test.js`（14 项）不退化。
- 改后 `toggle incr:false` 走全量扫描路径，**两者结果必须一致**（既有 A/B 机制）。
- **验证命令**：
  ```sh
  node --test test/incr.test.js test/patterns.test.js test/forbidden.test.js
  # ★ 自检对拍（A13）：增量计数 vs 全量重数，必须 100% 一致
  node -e "
  const core=require('./engine/core.js'), PAT=require('./engine/patterns.js');
  const p=core.createPosition(); core.attachCache?0:0;   // 用真实的 makeMove/unmakeMove 序列
  let bad=0;
  for(let t=0;t<2000;t++){
    const x=(Math.random()*15)|0, y=(Math.random()*15)|0;
    if(p.board[core.idxOf(x,y)]!==0) continue;
    core.makeMove(p,x,y,p.stm);
    const full=PAT.countBoth(p.board);                      // 全量重数
    for(let pl=1;pl<=2;pl++) for(let c=0;c<10;c++)
      if(p.material[pl*10+c]!==full[pl][c]) bad++;
    core.unmakeMove(p);
  }
  console.log('不一致处:',bad,'（必须为 0）');
  "
  ```
- **门槛**：自检不一致 **== 0**（**硬红线**）；`incr.test.js` 增量加速比 **≥ 3×**（既有门槛）。

**回滚**：`cfg.incrMaterial = false`（不维护计数，退回现状）。

**风险**：中。**若计数与全盘重数不一致 → 静默产生错误终局判定** ⇒ **必须配 A13 自检**。

---

> ## ★ A6 实施记录（2026-09-20 收官，批 3 第 1 条）
>
> ### P-A 前置门槛：**通过（35.0% ≫ 10%）**
> `tools/_probe-hotspot.js`（40 局面 / hard-120ms / useBook:false）：
> **`levelAt` 占 `think()` 墙钟 35.0%**（另 8 局面 30.2% / 20 局面 35.2%）、`moveScoreAt` 42.3%（含调 `levelAt`）、
> `candidates` 10.4%。⇒ §4.7 的 ≥10% 生死线**远超**，A6 有实质收益，**不砍**。
>
> ### 落点（与 §4.7 施工图的差异，均已实测核对）
> | 项 | 施工图 | 实际落地 | 原因 |
> |---|---|---|---|
> | 材料表布局 | `pos.material[player][cls]`（二维） | **`Int32Array(2*8)` 扁平**（`off=player===BLACK?0:8`） | JS 无二维数组；与 `lc.tot`/`sideOff` 同布局 ⇒ 可逐位对拍 |
> | 类数 | "单棋型计数"（未定维度） | **8 类 = 单棋型**（五/长连/活四/冲四/活三/眠三/活二/眠二），**与 `NT` 相同** | §4.7「不缓存等级计数、只缓存规则无关的单棋型」；且与 `countBoth`/`lc.tot` 同口径 |
> | 维护钩子 | 「复用 `pos.onCell`，不引入第二套」 | **复用 `onCell`，但需给它 `'pre'`/`'post'` 两相** | 见下「★ 关键缺陷」 |
> | `materialOf` | 未提 | **新增**（全量建表，`attach` 时一次） | 建表 = 全量重数，直接复用 `scanLineInto` |
> | 归零/复原 | 「`unmakeMove` 反向」 | **`unmakeMove` 也发 `onCell`**（此前不发） | A6 改「原地递增」后，靠"物化新数组换引用"的复原路径失效 |
>
> ### ★ 关键缺陷（本轮新发现，编号 **#35**）
> **`pos.onCell` 只有单一相位（变化后），不足以维护"原地递增"型增量结构。**
> - 首版 `materialInc` 把"变化前/变化后"两次线扫描**都放在棋盘已更新之后** ⇒
>   两次读到同一份内容 ⇒ **净变化恒为 0** ⇒ 缓存单向漂移。
> - 实测症状（2400 步里 **2026 步偏离**）：典型局面 = 对角线上白 `(10,8)`、白 `(11,9)` 相间留空
>   `(12,10)`，黑填 `(12,10)` 后**白活二本该消失**，但"白活二 +1"从未被记入差分 ⇒ 永远清不掉。
> - **根因**：`material` 的 delta 需要"同一条线跨状态取差"，而 `makeMove` 只在**变化后**回调。
>   若拿"上一次 post 的快照"当 before，则**其他落子会改变同一条线**（同一线的 4 格索引可能分属
>   不同落子点），快照与真值必然漂移。§33.3 的 `lc` 之所以没暴露，是因为 `cacheUpdate` 用
>   `old || pos.board` 把"旧内容"物化成了**新数组**（隐式保存了旧状态），而非依赖相位。
> - **修复**：`core.makeMove`/`unmakeMove` 各发**两次** `onCell(pos, idx, phase)`——
>   `'pre'`（该手尚未落到棋盘）与 `'post'`（已落到棋盘）；`cellHook` 在 `pre` 存快照、`post` 求差。
> - **回归护栏**：`test/incr-material.test.js` 用例 ①/⑤ 精确覆盖；**已用"删掉 pre 相位"的
>   篡改版验证它会挂**（8 项里挂 3 项：⑥/⑦/⑧）。
>
> ### 验收结果（全部达标）
> | 门槛 | 判据 | 实测 | 结论 |
> |---|---|---|---|
> | 自检不一致（**硬红线**） | == 0 | **0 / 2400 步**（40 种子 × 60 手，逐步对拍全量重数） | ✓ |
> | `materialOf` 三口径互证 | 逐位一致 | vs `countBoth` / vs `lc.tot` **0 偏差**（204 局面） | ✓ |
> | make/unmake 往返复原 | 逐位 | **0 / 40 种子**失败 | ✓ |
> | I-neg（故意破坏计数） | 必须爆 | 改 1 个槽位 ⇒ 自检立即命中该槽位 | ✓ |
> | 成本预算 | 墙钟 ≤ +5% | **+0.7%**（另一轮 −2.5%）；节点 +0.6~1.4%；**深度 Δ 0.00~0.15** | ✓ |
> | 维护 vs 全量重数 | 增量更快 | **3.9~5.9×**（30000 次落子：98~132ms vs 518~583ms） | ✓ |
> | 默认关零副作用 | 逐位不变 | `cfg.incrMaterial=false`（默认）⇒ `pos.material===null`、选点/节点**逐位相同** | ✓ |
> | renju | 全流程一致 | `think(rule:'renju')` + 225 空点逐个落/撤，材料表始终一致 | ✓ |
> | 全量回归 | 全绿 | **18 文件 206 项**（197→206） | ✓ |
> | 浏览器实跑 | PASS | `browser-check.js` **PASS 3 / FAIL 0** | ✓ |
> | 打包 | 新鲜 | worker **`419966f4a6160ba5`**（197.0 KB bundle） | ✓ |
>
> ### 新增 API（导出登记）
> `core.dirLinesAt(idx)`（过格点的 4 条线，§33.3 同源实现）；
> `PAT.NCLS`/`P_OF_CLS`/`CELL_LINES4`/`scanLine4`/`matOff`/`lineCounts`/`lines4Counts`/
> **`materialOf(board)`**/ **`materialInc(mat, idx, board, before, beforeOff, cur)`**；
> `SEARCH.attachMaterial(pos)` / `SEARCH.attachIncr(pos, cfg)`（think 已内联，这两个供测试显式调用）。
> **回滚**：不传 `cfg.incrMaterial`（默认 `false`）。
> **未并入 `H_ALL`**（A6 用 cfg 字段而非位开关，§4.0.4）。
> **无需 Elo**：纯新增结构 + 默认关，不改搜索真值（§5.5.2 只有 A1/A3/A2 换深度需 Elo）。

---

### 4.8 A5 —— `wldOf` O(1) 胜负判定（PentaZen A5，依赖 A6）

**动机**
PentaZen `check_wld`（`board.cpp:467-494`）**3 次比较**判定胜负与"还需几步"。
我们目前是**散落扫描**（`staticEval` 每次重扫）。

**上游出处**：PentaZen `check_wld`——
`check_wld_already()`（C5/盘满/renju 禁手）+ 3 次比较：
己有 F4/B4 → `offset1`；对手 F4 或双 B4 → `offset2`；己有 F3 且对手无 B4 → `offset3`。

**落点**（★ 已核对）：`engine/patterns.js:373`（`levelAt`，**不改它**，作为对拍基准）、
`:320`（`forbiddenCore`，**renju 终判的唯一合法入口**）、`:339`（`forbiddenAt`）；
新增 `wldOf` 建议放在 `patterns.js` 末尾（**它已在 `patterns` 命名空间内**，无需新模块）；
`engine/eval.js:93`（`staticEval`，**终局短路处**）、`:138`（`staticEvalPos`，**同样有短路**，两处都要改）。

**具体改动**
```js
// 用 A6 的材料计数做 3 次比较
function wldOf(pos) {
  const stm = pos.stm, opp = 1 - stm;
  // ① 已有五 → 已结束
  // ② 己方有 F4 或 B4 → 下一步必胜（offset 1）
  // ③ 对手有 F4 或双 B4 → 对手下一步必胜（offset 2）
  // ④ 己方有 F3 且对手无 B4 → 主动（offset 3）
  return { winner, offset };
}
```
- **renju 兼容**：`check_wld_already()` 里的 **renju 禁手**判定必须走**严格算法**
  （我们在 #33 已确立"Renju-黑恒调 `forbiddenCore`"）——
  **不得**用窗口预检（会重演漏判 19.5~23.7%）。

**接口/契约**
- 新增导出 `wldOf`；**`staticEval` 的公开返回结构不变**（仍返回分）。
- `judge` 响应（§28）的 `mate{side,plies,via}` 可由此**更准地填 `plies`**（当前是估算）。

**验证**
- 与"全量扫描版胜负判定"做**逐局面对拍**（同一局面对拍 N 万局面，必须 100% 一致）。
- `test/rules.test.js`（9 项）+ `test/forbidden.test.js`（12 项）+ `test/incr.test.js`。
- **验证命令**：
  ```sh
  node --test test/rules.test.js test/forbidden.test.js test/incr.test.js test/patterns.test.js
  # ★ 对拍：wldOf vs 全量扫描（所有 26 开局前 N 手 + 随机序列）
  node -e "
  const P=require('./engine/patterns.js'), core=require('./engine/core.js');
  const OP=require('./engine/data/openings.js');
  let bad=0, n=0;
  for(const o of OP.OPENINGS){
    const p=core.createPosition();
    for(const [x,y] of o.moves){
      if(p.board[core.idxOf(x,y)]!==0) continue;
      core.makeMove(p,x,y,p.stm); n++;
      const a=P.wldOf(p);                        // 新：O(1)
      const b=P.wldOfSlowScan(p);                // 旧：全量扫描（测试中临时实现）
      if(a.winner!==b.winner||a.offset!==b.offset) bad++;
    }
  }
  console.log('对拍',n,'局面，不一致',bad,'（必须为 0）');
  "
  ```
- **门槛**：对拍不一致 **== 0**（**硬红线**，含 renju 边界）；
  `forbidden.test.js` **12 项全绿**（禁手终判仍走 `forbiddenCore`）。

**回滚**：`staticEval` 保留旧路径，`cfg.wldFast = false` 走旧路。

**风险**：低（有 A6 的计数基础 + 自检）。**收益**：`staticEval` 终局更快更准 + `coach.hint` 能给"还需几步"。

> ## ★ A5 实施记录（2026-09-20 收官，批 3 第 2 条）
>
> ### 落点（与 §4.8 施工图的差异，均已实测核对）
> | 项 | 施工图 | 实际落地 | 原因 |
> |---|---|---|---|
> | `wldOf` 位置 | `patterns.js` 末尾 | **`patterns.js` 末尾**（`return {` 之前） | 与施工图一致 |
> | 签名 | `wldOf(pos)` | **`wldOf(pos, boardOverride, rule)`** + 热路径 `wldCode(pos, boardOverride, rule)` | ① `eval.staticEval` 只有 `board` 没有 `pos` ⇒ 需 `boardOverride`；② **必须传 `rule`**（见缺陷 #36）；③ **热路径必须零分配**（见缺陷 #37） |
> | 材料来源 | "用 A6 的材料计数" | `pos.material \|\| materialOf(board)` | 有增量表走 O(1) 读；无则全量建表（供无 pos 场景） |
> | 返回结构 | `{winner, offset}` | 对象版 `{winner, offset, wld}`；**热路径 `wldCode` 返回 number** | `eval` 侧只需"是否终局"；`coach` 侧要 offset；**叶子路径不能构造对象** |
> | `eval` 接入点 | `staticEval` + `staticEvalPos` 两处 | **只改 `staticEval`**（`staticEvalPos` 明确不接） | ★ 实测：`staticEvalPos` 读 `lc.tot` **已是 O(1)**（0.021 µs），接 `wldCode` 反而 **+0.018 µs**（多一次调用）；`staticEval` 无增量表时 `countBoth` 要 **9.3 µs**，才是真收益点 |
> | cfg 字段 | `wldFast` | `eval.DEFAULT.wldFast = false` | 与 §4.0.4 登记一致；回滚 = 不传 |
>
> ### ★ 关键缺陷 #36：`wldOf` 漏掉 `rule === 'renju'` 门控
> **首版把"黑长连 = 负"当成了无条件规则。**
> - 实测症状（随机对拍第 478 步）：黑 `overline=1`，freestyle 下**黑长连本该是胜**
>   （白视角 `wld` 应为 `'L'`），首版却返回 `'W'`。
> - 根因：写 `const bkS = (stm === BLACK)` —— 从 `staticEval` 抄漏了一截。
>   原式是 `(rule === 'renju' && stm === BLACK)`：
>   **长连只在 Renju 下对黑是禁手负，freestyle 下双方长连都是胜**。
> - 修复：`wldCode` 增加 `rule` 形参（缺省 `pos.rule || 'freestyle'`），门控复原；
>   `eval` 调用点显式传 `rule`。
> - **回归护栏**：`test/wld.test.js` ①②④⑪ 覆盖；**篡改版实测挂 1 项**（① 开局对拍）。
>
> ### ★ 关键缺陷 #37：`wldOf` 返回对象 ⇒ 叶子热路径**变慢 13×**
> - 实测（`tools/_a5-speed.js`）：`staticEvalPos` 终局局面 **0.021 → 0.262 µs**（**慢 13×**）。
>   根因 = 每次调用构造一个 `{winner, offset, wld}` 临时对象 ⇒ 分配开销远大于"读 8 个整数"。
> - **修复 = 拆成两个 API**：`wldCode`（返回 **number**，零分配，供 `eval` 热路径）+
>   `wldOf`（返回对象，供 `coach` 等冷路径）。实测 `wldCode` 单次 **0.006~0.012 µs**。
> - **★ 同时发现编码歧义（并入 #37）**：首版让 `abs(c)` 直接编码 offset，导致
>   **offset 3（"己方主动"）与 offset 1（"一步胜"）都编成正数** ⇒ `staticEval` 的
>   `c > 0` 分支把"主动"误判成"已胜"（实测 `off=1438 / on=1e8`）。
>   修复：**"主动"归 0**，编码表 = `+100 己胜 / -100 己负 / +1 一步胜 / -2 必负 / 0 未知`。
>   需要 offset 语义的冷路径用 `wldOf` 单独重算。
> - **回归护栏**：`test/wld.test.js` ⑥⑪⑫ 覆盖；**篡改版实测挂 3 项**。
>
> ### 验收结果（全部达标）
> | 门槛 | 判据 | 实测 | 结论 |
> |---|---|---|---|
> | 逐局面对拍（**硬红线**） | 不一致 == 0 | **0**（26 开局 × 2 规则前缀 + 随机 1870 步 + renju 边界） | ✓ |
> | 默认关零副作用 | 逐位不变 | `wldFast` 未传 ⇒ `staticEval`/`staticEvalPos` **逐位相同**（800+ 步） | ✓ |
> | 开启后终端值一致 | 逐位 | 开启 `wldFast` ⇒ 终局局面返回值与默认路径**逐位相同**（含 renju 黑长连） | ✓ |
> | renju 不越权 | 禁手走 `forbiddenCore` | `wldOf` **只做材料计数**、不返回禁手结论（用例 ⑩ 断言无 `forbid` 字段） | ✓ |
> | **热路径成本** | **不得变慢** | `wldCode` 单次 **0.006~0.012 µs**；vs `countBoth` **9.3 µs** ⇒ **~800×** | ✓ |
> | I-neg（防永远绿） | 篡改必挂 | 删 rule 门控 ⇒ 挂 1 项；删 offset-3 分支 ⇒ 共挂 3 项；改 material 槽位 ⇒ 挂 1 项 | ✓ |
> | 新增测试 | 全绿 | `test/wld.test.js` **12 项** | ✓ |
> | 打包体积 | < 200 KB | **199.7 KB**（`ece8cdc659319330`） | ✓（余量仅 0.3 KB，**见下风险**） |
> | 全量回归 | 全绿 | **19 文件 218 项**（206→218） | ✓ |
>
> ### 新增 API（导出登记）
> `PAT.wldCode(pos, boardOverride?, rule?)` → **number**（零分配热路径）；
> `PAT.wldOf(pos, boardOverride?, rule?)` → `{ winner, offset, wld }`（对象版，冷路径）；
> `PAT.WLD_W` / `PAT.WLD_L` / `PAT.WLD_D`（`'W'`/`'L'`/`'D'`）、`PAT.WLD_END`（=100）；
> `eval.DEFAULT.wldFast = false`（**默认关**）。
> **回滚**：不传 `cfg.wldFast`（默认 `false`）。
> **未并入 `H_ALL`**（A5 用 cfg 字段而非位开关，§4.0.4）。
> **无需 Elo**：纯判定重构 + 默认关，不改搜索真值（§5.5.2）。
>
> ### ★ 风险（须留意）：打包体积余量
> worker bundle 现 **199.7 KB / 上限 200 KB**（`test/worker.test.js:228` 硬断言）。
> **后续任一条（A11/A9/A10/A13）都可能顶破**。三个选项（择一，勿默认放宽）：
> ① 精简 `patterns.js` 既有长注释（当前注释占比偏高）；
> ② 把 `test/worker.test.js` 的上限按"实测 + 明确余量"重标（须在文档登记理由）；
> ③ 拆分 `patterns.js`（语义上可拆"计数层 / 禁手层 / 编码层"）。
>
> **下一步 = 批 4 第 1 条 A11 禁手缓存**（P-F 已验 57.0% ≫ 20% 门槛，见上方「重新评估」节）。

---

### 4.9 A8 —— `see` 位掩码表（PentaZen A7，★ 最大收益、最大风险，**先测**）

**动机**
PentaZen 的核心资产：一次内存读判断"某点某材料的有无"（`see[2][88][15]`，10.6 KB）。
我们的 `levelAt` **每节点重算棋型** ⇒ 可能差一到两个数量级。

**上游出处**：PentaZen `board.h:187-190` + `board.cpp:181-247`（`line_update`）。

**落点**（★ 已核对）：**独立实验分支，离线生成** `see[2][88][15]`（类比 `pattern.bin`）；
消费点 `engine/patterns.js:373`（`levelAt`，**对拍基准**）、`:339`（`forbiddenAt`，**只筛选不终判**）；
**维护层**：`engine/core.js:46`（`makeMove`）+ `:59`（`unmakeMove`，**两条线更新**）。

**硬前置（不测就砍）**
- ★ **`P-A` 探针必须先证明 `levelAt` 是热点**。若 `levelAt` 占 `think()` **<10%** ⇒ **本条收益为零，直接砍掉**。
- 参考：Carbon 文档已核实 `WCLS` 是**惰性表**（稳态成本为零）⇒ 若 `rawClassify` 调用次数
  **随局数收敛**（P-E），说明表已吃饱，**预计算化收益很小** ⇒ **也应砍掉 A8 的"表预计算"部分**。

**语义冲突（关键）**
- `see` 表是**方向/线级**的，而 `forbiddenCore` 需要**跨方向几何验证**。
  ⇒ **两者不能简单替换，只能共存**：`see` 供**快速筛选**，`forbiddenCore` 供**最终裁定**。
- ⚠️ **绝不允许**用 `see` 表**替代** `forbiddenCore` 做禁手终判——这会重演 #33 的漏判事故。

**验证**
- **对拍**：同一批局面，`see` 查询结论 vs `levelAt` 结论，必须 100% 一致（**含 renju 边界**）。
- `bench-eval.js`（叶子评估耗时）+ NPS 实测 + 全量 179 项。
- **验证命令**：
  ```sh
  node tools/bench-eval.js            # ★ 叶子评估耗时（A8 的目标函数）
  node --test test/patterns.test.js test/forbidden.test.js   # ★ 12 项禁手护栏
  node --test test/effect-micro.test.js                      # 若已落地（E3 微基准）
  ```
- **★ 必须先跑 P-A（`levelAt` 占 think() 的占比）**：
  ```sh
  node -e "
  const S=require('./engine/search.js'), core=require('./engine/core.js');
  const PAT=require('./engine/patterns.js');
  let t0=Date.now(); for(let i=0;i<1e5;i++) PAT.levelAt(...); const t1=Date.now();
  console.log('levelAt 1e5 次 =',t1-t0,'ms  ⇒ 再与 think() 总耗时比');
  "
  ```
  **若占比 <10% ⇒ 砍掉本条**（收益为零）。
- **门槛**：对拍 **diff == 0**；`forbidden.test.js` **12 项全绿**（禁手终判仍走 `forbiddenCore`）；
  叶子评估耗时 **≤ 基线×1.05**（改进则报效应量）。

**回滚**：`cfg.useSee = false`（退回 `levelAt`）。

**风险**：**高**。要求**整个棋盘维护层重写**，且与 `WCLS`/`forbiddenCore` 语义耦合。
**建议：先测量（P-A/P-E），不测不动。**

---

### 4.10 A9 —— 候选位图（`MoveList` 内嵌 bitboard，PentaZen A8 / Carbon A1-a）

**动机**
`eval.js:candidates()`（实测 `:28`）是**全盘 225 格扫描 + 代际戳**，且**去重/查重是线性**。
PentaZen 的 `MoveList` 内嵌 `BitBoard` 做 O(1) `contains`。

**上游出处**：PentaZen `movelist.h:37-57`；Carbon `AICarbonMove.cpp:157-201`（矩形裁剪）。

**落点**（★ 已核对）：`engine/eval.js:28`（`function candidates(board, radius)`——
**全盘 225 格扫描 + `_gen` 代际戳 + `_mark`**，返回**有序 idx 数组**，空盘返回 `[idxOf(7,7)]`）；
消费点 `engine/eval.js:84`（`sortedMoves`）、`engine/search.js:216`（`genMoves`）。

**具体改动**（**保守版，先做这个**）
- 候选表用 `Uint32Array(8)` 位图 + 数组，`contains` 用位与。
- **可选**（Carbon A1-a）：`pos` 上加 `{minX,minY,maxX,maxY}` 矩形，`candidates()` 只扫矩形。
  ⚠️ **不动 `adj1/adj2` 计数**（那是 Carbon A1-b，触及 `core.makeMove/unmakeMove`，风险显著上升）。

**接口/契约**：`candidates()` 返回**仍是有序 idx 数组**（既有调用方不变）。

**验证**：`P-C` 先测占比（若 <5% 则收益有限但改动也小）；
**等价性**：写只读探针，**随机对局逐步对比新旧候选集**（必须完全一致——半径算错会漏点）。
- **验证命令**：
  ```sh
  node -e "
  const EV=require('./engine/eval.js'), core=require('./engine/core.js');
  const OP=require('./engine/data/openings.js');
  let bad=0, n=0;
  for(const r of [1,2]){
    for(const o of OP.OPENINGS){
      const b=new Int8Array(225);
      for(const [x,y] of o.moves){ if(b[core.idxOf(x,y)]) continue; b[core.idxOf(x,y)]=(n%2)+1; n++;
        const a=EV.candidates(b,r);                       // 新：位图版
        const c=EV.candidatesSlow(b,r);                   // 旧：扫描版（测试中临时保留）
        if(a.length!==c.length||a.some((v,i)=>v!==c[i])) bad++;
      }
    }
  }
  console.log('候选集对拍不一致',bad,'（必须为 0，且顺序也要一致）');
  "
  node --test test/ai.test.js test/search.test.js test/search-enhance.test.js
  ```
- **★ 顺序也要一致**：`candidates()` 的**返回顺序**被调用方依赖（排序前），
  位图版必须**复现同样的顺序**，否则会改变搜索树 ⇒ **这是最容易漏的坑**。
- **门槛**：对拍 **diff == 0（含顺序）**；`bench-eval.js` 的 `candidates` 耗时 **≤ 基线×1.05**。

**回滚**：`cfg.candBit = false`。

**风险**：低。**收益**：去重 O(1)；矩形裁剪减少扫描范围。

---

#### ★ A9 实施记录（2026-09-21，已完成 ✓）

**① 落地差异（对施工图「落点」的如实登记）**
| 施工图原述 | 实际落地 | 说明 |
|---|---|---|
| 候选表用 `Uint32Array(8)` **+ 数组**，`contains` 用位与 | **仅位图**（`Uint32Array(8)`，225 bit），不额外维护数组 | 调用方只要**有序 idx 数组**，维护并行数组反而多一次写入 |
| `candidates()`（`:28`）原地改 | **保留旧实现改名 `candidatesSlow`**，新增 `candidatesBit`，`candidates()` 变门控 | 对拍基线 + 默认关逐位不变，需要旧版常驻 |
| 消费点 `eval.js:84` / `search.js:216` | 实际 `eval.js:137`、`search.js:252/339/555`（行号随前批改动漂移） | `search.js` 有 3 处直调，均受**全局门控**覆盖 |
| 可选：`bbox` 矩形裁剪 | **实测否决**（见 ③） | 朴素 bbox 比基线更慢 |

- 门控：`eval.js` 内 `let _candBit`；`setCandBit(on)` **冷启动清零**计数（同 `forbidMemoSet` 语义）；
  `search.js:think()`（`:683`）与 **`bestMoves()`（`:828`）** 两处均设 `EV.setCandBit(cfg.candBit === true)`。
  ⇒ `search.js` 的 3 处直调 `EV.candidates` 全部受控（**`bestMoves` 是容易漏的一条路径**）。
- 新观测 API：`EV.candStat() → { slow, bit, on }`（计数，供测试/工具复用）。
- 配置字段：`eval.DEFAULT.candBit = false`、`search.DEFAULT.candBit = false`（**默认关**，回滚 = 不传）。

**② 正确性验收（硬红线，全绿）**
| 项 | 结果 |
|---|---|
| ① 含顺序对拍（26 局面 × radius{1,2,undef}） | **diff = 0 逐位一致** ✓ |
| ①b 边界 radius{0,5,14,30} | 一致 ✓ |
| ② 默认关逐位不变 | 一致 ✓ |
| ③ 空盘 → `[idxOf(7,7)]` | 一致 ✓ |
| ④ word 边界（跨 32/64/96）输出严格 idx 升序 | 通过 ✓ |
| ⑤ 真实搜索 `candBit` 开/关（8 局面 renju d3） | **move/score diff = 0** ✓ |
| ⑥ `bestMoves` 路径门控生效 | 一致 ✓ |
| ⑦ I-neg（乱序实现必挂） | 通过 ✓ |
| ⑧ `candStat` 观测自洽（关态只 slow / 开态只 bit / 调用数相同） | 43960 = 43960 ✓ |
| ⑨ 成本护栏（宽松上界 1.30 + 分档输出） | 通过 ✓ |

- 测试文件：`test/cand-bit.test.js`（**10 项**）。
- 门控生效实证：`node tools/_a9-instr.js` → 调用 **43960** 次，slow/bit 两版**次数相同**、**节点不变**。

**③ ★ 关键实证：收益必须按真实调用分布加权（否则符号都会错）**
施工图门槛只写「耗时 ≤ 基线×1.05」。实测发现**这个门槛对样本分布极度敏感**，逐档数据：

| 口径 | bit/slow | 说明 |
|---|---|---|
| 施工图建议的 `P40` 全体（40 局面） | **0.861** | 快 14% —— **但 40 个局面全挤在同一档** |
| 全谱分档（360 局面，从 1 子到 60 子） | **0.797 ~ 0.833** | **每档都快**（0.746/0.561/0.853/0.835） |
| 真实中盘分布（P40 + 随机扩展 0–6 子，280 局面；**独立进程重复 5 次**） | **0.859 / 0.907 / 0.910 / 0.912 / 0.995**（中位 **0.910**） | 快 ~9% —— 本文档采纳的**验收口径** |
| 高候选档专项复核（>120 候选，32 局面 × 15 轮交替 A/B） | **0.899 / 0.924** | 快 8~10% |
| 早期极稀疏盘面（12 个开局，候选 <20） | **1.043** | ⚠ **唯一变慢的场景**（位图常数开销 `bm` 清零 + `clz32` 占比高） |

- ⇒ **结论：A9 是净收益**。稀疏开局档虽略慢，但该档 `candidates` 绝对成本仅 ~0.5 µs、且**占比极低**；
  真实搜索的分布加权成本比 **中位 0.910（快 ~9%）**，5 次独立进程全部 < 1.05（最差 0.995）。
- **★ 通用教训（写入本节，供后续条目复用）**：
  1. **微基准的样本分布决定结论**。A9 初测"快 16%"来自 P40（中后期盘面）的偏置；
     真实搜索含大量早期稀疏节点，收益稀释到 **~9%**。**单点均值可能给出错误的符号**。
     且**单次测量本身也不可靠**——`_a9-real.js` 5 次重复给出 0.859~0.995（跨度 0.14）；
     ⇒ 必须**报分布（中位/极差）**，不可报单点（本文档初稿误报"0.880"单值，已更正）。
  2. **µs 级基准的结论只能来自独立进程**。同一实现：独立进程测得 0.88，
     在跑过大量测试的**同进程内**可测到 0.88→1.00→1.15（单档甚至 1.51 假象）。
     ⇒ 故 `test/cand-bit.test.js` ⑨ 只保留**防灾难性回退的宽上界（1.30）**，
     精确门槛由 `tools/_a9-real.js`（独立进程）承担。
  3. 端到端 `think()` 计时在本任务上**信噪比不足**（同配置 off 抖动 866–1212 ms，±40%），
     不可用作 5% 级门槛的判据（`tools/_a9-stab.js` 实测 min 比 1.007 / med 比 0.849）。

**④ 被实测否决的替代方案（勿重走）**
| 方案 | 实测 | 否决原因 |
|---|---|---|
| `bbox` 矩形裁剪（朴素版） | **3.88 µs**（基线 3.23） | 逐候选再验"是否邻域"比代数戳更贵 |
| 预展开 5×5 偏移数组 | **4.03 µs**（慢 48%） | V8 对双层 `for` 的边界消除远优于数组索引寻址 |
| 「收集阶段」单点微基准 | 3.23 → 2.71 µs（快 16%） | **偏置样本**，与真实分布不符（见 ③） |

**⑤ 探针清单（留档，均在 `gomoku/tools/`）**
`_a9-micro.js`（占比 P-C）、`_a9-bitmap.js`（收集阶段对拍+计时）、`_a9-bbox.js`（否决 bbox）、
`_a9-mark.js`（否决预展开）、`_a9-speed.js` / `_a9-stab.js`（端到端+稳定性，示信噪比不足）、
`_a9-instr.js`（门控计数 + 同分布回放）、`_a9-verdict.js` / `_a9-weight.js` / `_a9-real.js`（分档/加权裁决）、
`_a9-ab.js`（独立进程逐档交替 A/B，**最终裁决依据**）。

---

### 4.11 A10 —— 增量威胁表（Stahlfaust A3，需先证）

**动机**
Stahlfaust 的 `InterestingFieldAgent` 用六列表（`own/opp × threat/added/removed`）+ `cause` 回溯，
把"威胁标记"增量维护，避免每次重扫。

**上游出处**：Stahlfaust `InterestingFieldAgent.cs:163-229`；`UpdateInterestingFieldArray`（5×5 模板，`:88-128`）。

**落点**（★ 已核对）：`engine/core.js:46`（`makeMove`，**加钩子**）、`:59`（`unmakeMove`，反向）；
消费点 `engine/eval.js:138`（`staticEvalPos`）、`engine/search.js:216`（`genMoves`）。

**硬前置**
- ★ **`P-A` 必须先证明"重扫实际占了大量时间"**。若 `levelAt`/`threatMoves` 不是热点 ⇒ 收益为零。
- **与 A6/A8 串行**（C-1）：三者都改 `patterns.js` 缓存层，**必须串行 + 各自跑基准**。

**验证**：对拍"增量威胁集 vs 重扫威胁集"逐局面一致 + A13 自检 + 全量测试。
- **验证命令**：
  ```sh
  node tools/bench-eval.js test/search.test.js
  node --test test/incr.test.js test/patterns.test.js test/threat.test.js
  # ★ 对拍：增量威胁集 vs 重扫（同 A6 的自检模式）
  ```
- **门槛**：对拍不一致 **== 0**；全量 **179 项全绿**。

**回滚**：`cfg.incrThreat = false`。

**风险**：**高**（大改动）。**收益需先证**。

---

#### ✗ A10 裁决记录（2026-09-21，**砍掉**）

**裁决**：**砍**。全部子面实测远低于 10% 生死线，收益上限 ≈2.5% 却要付"高风险大改动 + 与 A6/A8 串行 + 需 A13 自检"的代价。

**★ 三子面逐一实测（`tools/_a10-repeat.js` 源码插桩 + `_a10-verdict.js` 外部挂钩）**

| 子面 | 实测占比 | 内部重复性 | 可省收益上限 |
|---|---|---|---|
| ① **`threatMoves` 重扫**（`vcfWin`/`vctWin` 内 DFS 每层重扫） | freestyle **0.8~1.7%** / renju **3.0~3.6%** | 同 think 内重复率 **70.6%**（1444/2046） | ≈ **0.6~2.5%** |
| ② `staticEvalPos` 的威胁统计（施工图落点 `eval.js:138`） | **0.9~2.9%** | **无**（每次新盘面，非重复） | ≈ 0 |
| ③ `genMoves` 候选威胁标记（`search.js:216`；走 `moveScoreAt`→`levelAt`） | `moveScoreAt` **29.7~36.8%**（其中 `levelAt` 19~31.5%） | **无**（每个候选点各算 1 次，**不是重复扫描**） | ≈ 0（A6 已部分覆盖） |

**★ 决定性证据链**
1. **`threatMoves` 是闭包调用**（`threat.js` 内 `dfs` 直呼，外部挂钩恒 0）⇒ 改用 **`Module._load` 源码插桩**
   （磁盘文件不动）度量；**已对拍验证插桩不污染结论**（6 局面 think 结果逐位一致 `7,8/3 | 11,6/48 | 6,8/183 | 7,6/197 | 8,6/-284 | 9,6/378`）。
2. **调用数不随时限增长**：freestyle `ms=100 → 300` 时 `threatMoves` 调用 **2046 → 2046**（占比反而 1.7%→0.8%）。
   原因：主搜索（`moveScoreAt`/`levelAt`）随深度增长，而 `threatMoves` 只由少数 `vcfWin`（280 次）/`vctWin`（40 次）入口触发。
   ⇒ **A10 的收益面不随搜索加深而扩大**，与 A9（`candidates` 随节点数上升）相反。
3. **重复率高 ≠ 有收益**（同 A11 的教训）：重复率 70.6% 看着可观，但**基数只有 1.7~3.6%**
   ⇒ 收益上限 = 占比 × 重复率 ≈ **1.2~2.5%**。
4. **③ 的"重扫"是伪目标**：`moveScoreAt` 对每个候选点算 1 次评分（`sortedMoves` 内一次性），
   **不存在"同一 (盘面,点) 反复扫描"**；`levelAt` 的成本主要在 `scanRuns`/`decode9`（A8 已证已是惰性表）。
   故 A10 想解决的"重扫"在 ③ 处**根本不存在**。

**★ 未来复活条件（仅在满足时重开）**
- 若未来 vcf/vct **深度大幅提高**（如 `vcfDepth ≥ 8`）或其**调用频次量级上升**，使 `threatMoves` 占比 >10%，
  则本条可复活（复测命令：`node tools/_a10-repeat.js 40 --ms=300`）。
- 或 A12（算子化枚举）后续把威胁枚举挪进 `moveScoreAt` 主路径 ⇒ 需重新测占比。

**★ 本次新增的通用方法论（供后续复用）**
- **闭包内函数无法外部挂钩** ⇒ 用 **`Module._load` + 源码字符串插桩**，磁盘文件不动；
  **必须先在 `require` 目标模块前装拦截器**（否则命中 `require` 缓存，恒 0 —— 本会话踩过）；
  插桩后**必须对拍 think 结论**证明不污染（本会话完成）。
- **CRLF 文件的正则插桩要用 `\r?\n`**，否则静默不匹配（本会话踩过：`return res;` 插桩失败两次）。
- **"重复率高"必须与"占比"相乘才是收益**——高重复率 + 低占比 = 白做。

**⑤ 探针清单（留档，均在 `gomoku/tools/`）**
`_a10-split.js`（威胁通道顶层细拆）、`_a10-repeat.js`（★ `threatMoves` 源码插桩：占比 + 重复率）、
`_a10-verdict.js`（三子面占比汇总）。

---

### 4.12 A11 —— 禁手评估缓存（Carbon A3，需先证）

**动机**
`forbiddenCore` 每次重算成本高（Carbon 文档实测 `levelAt` 从 0.33 µs → 5.5 µs，**7.4×**）。
Carbon 用"写入 `status4`"消除重复判定。

**上游出处**：Carbon `AICarbonMove.cpp:359-404`（`checkForbid` 改写 `status4`）。

**落点**（★ 已核对）：**沿用既有缓存模式**——`engine/patterns.js:118`（`const MEMO = new Map()`，
`rawClassify` 的结果缓存，**抄它的键设计**）、`:494`（`const LINE_MEMO = new Map()`，
**含 LRU 上限 `:522` `if (LINE_MEMO.size > 300000) LINE_MEMO.clear()`，照抄这个容量策略**）；
目标函数 `:320`（`forbiddenCore`）、`:339`（`forbiddenAt`）。

**硬前置**
- ★ **`P-F` 必须先测命中率**。Carbon 文档明确警告：**同一 `(局面, idx)` 在 αβ 树里重复率本就不高**
  （`pos` 的 Zobrist 在 `makeMove/unmakeMove` 中**逐节点变化**）⇒ **命中率可能远低于预期**。
  **命中率低 ⇒ 放弃此条。**
- **绝不把结果写进棋盘结构**（那会引入 `undo` 失效问题）——只用外部 `Map`。

**接口/契约**：**纯缓存层**，不改任何公开行为。

**验证**：`_probe-planC20.js`（现有微基准）复测 `levelAt` 耗时 +
`test/forbidden.test.js`（12 项）。**缓存键设计不当会静默返回错误禁手结论**（最危险的一类 bug）
⇒ 必须与"无缓存路径"做对拍。
- **验证命令**（★ v1.3 重写：原稿把 `#` 注释写进 JS（语法错误）、`< 一批真实局面` 是伪 stdin）：
  ```sh
  node _probe-planC20.js                            # 现有微基准：levelAt 耗时
  # ★ 命中率必须来自"真实搜索流量"：先跑 P-F 探针（§5 的 _probe-forbid-memo.js，同一文件）灌流量，
  #   再读 §4.0.5 的观测导出汇总。不灌流量单独跑下面这条时 hit/miss 均为 0，无意义：
  node _probe-forbid-memo.js
  node -e "const PAT=require('./engine/patterns.js');const st=PAT.forbidMemoStats();console.log('命中率',(st.hit/(st.hit+st.miss)*100).toFixed(1)+'%')"
  node --test test/forbidden.test.js                # ★ 12 项（含 #33 的三条护栏）
  ```
- **门槛**：**命中率 ≥ 20%**（低于则放弃此条，见硬前置）；对拍 **diff == 0**；
  `forbidden.test.js` **12 项全绿**。

**回滚**：`cfg.forbidMemo = false`。

**风险**：低-中（若 `P-F` 命中率可观）。

> ## ★ A11 实施记录（2026-09-20 收官，批 4 第 1 条）
>
> ### 落点（与施工图 §4.12 的差异，均已实测核对）
> | 项 | 施工图 | 实际落地 | 原因 |
> |---|---|---|---|
> | 缓存位置 | `patterns.js`（照抄 `MEMO`/`LINE_MEMO` 模式） | `patterns.js` `forbiddenAt` 内部门控 | `forbiddenAt` 是**唯一入口** ⇒ search/threat/eval/coach 共 15 个调用点**无需改一行** |
> | 缓存键 | "抄 `MEMO` 键设计" | **局部窗（R=5=121 格）双 32 位哈希**，**非**全盘串 | ★ 见下"键设计两轮实证"——全盘串是**负收益** |
> | 容量 | 照抄 `LINE_MEMO` LRU `>300000 clear` | 同（`FORBID_MEMO_MAX = 300000`） | 一致 |
> | cfg 字段 | `forbidMemo` | `search.DEFAULT.forbidMemo = false` + `PAT.forbidMemoSet/Clear/Stats` 观测导出 | 回滚 = 不传 |
> | freestyle | （未提） | 自动无流量（`mS>0` 短路）⇒ **收益全在 renju** | 与 P-A 实测一致 |
> | 打包上限 | （§4.12 已预警） | **200 → 208 KB**（`test/worker.test.js:228`，附登记理由） | 见下"打包体积裁决" |
>
> ### ★★ 键设计的两轮实证（**本条成败的全部**）
> **第一轮（失败，但极有价值）**：初版照施工图用 `board.join('')` 做键。
> - 端到端（`tools/_a11-speed.js`）：renju depth4 8 局面，**off 12474 ms → on 17648 ms**
>   ⇒ **1.415×（反而慢 41.5%）**，节点数严格不变（正确性 ✓，收益 ✗）。
> - 微基准拆解（`tools/_a11-micro.js`）：`forbiddenCore` 裸算 **3.67 µs**；
>   `board.join('')` **3.87 µs** ⇒ **键构造比被缓存的计算还贵**。根因 = 225 格串化 O(225)。
> - **教训**：P-F 的"57% 命中率"只说对了一半——**命中率高 ≠ 有收益**；
>   缓存键的构造成本必须与被缓存计算的成本同量级比较（这是判定 C 类"纯缓存层"改造的通用前置）。
>
> **第二轮（成功）**：改**局部窗整数哈希键**。
> - 依据 `tools/_a11-locality.js`：`forbiddenAt` 的结论**只依赖 idx 周围 R 内的格子**
>   （**58674 次真实 renju 调用、0 冲突**；理论上五连/四/活三判定半径 ≤5 ⇒ 取 **R=5** 留余量）。
> - 键 = FNV-1a ⊕ 第二混合器的**双 32 位哈希**（≈64 bit）；构造成本 **0.56 µs**
>   （`tools/_a11-keycost3.js`；比全盘 join 快 **15×**）。
> - 端到端：**off 12569 ms → on 9975 ms = 0.794×（省 20.6%）**，命中率 **74.2%**，节点数严格不变。
> - ⚠ **哈希碰撞会静默返回错误禁手结论** —— 本条最危险失效模式；
>   由"关态 vs 开态逐位 diff==0"**硬红线** + "局部性护栏"（R=5 窗外任意扰动结果不变）双双守住。
>
> ### 验收结果（全部达标）
> | 门槛 | 判据 | 实测 | 结论 |
> |---|---|---|---|
> | 对拍（**硬红线**） | diff == 0 | **0/40**（renju 固定深度 depth4，含 score/depth/nodes）+ 权威构造全空点 × mode1/2 | ✓ |
> | 命中率 | ≥ 20% | **74.2%**（renju depth4）；测试内 depth3 = 61.5% | ✓ |
> | 端到端收益 | 不得变慢 | **0.794×**（省 20.6%）；首版全盘键 1.415× ⇒ 已由局部键修正 | ✓ |
> | 默认关零副作用 | 逐位不变 | `forbidMemo` 未传 ⇒ `forbiddenAt` 不产生 hit/miss，行为同旧 | ✓ |
> | 不串味 | 键含盘面+mode | 同 idx 异盘面 / 异 mode 结论各自正确（键数 ≥3） | ✓ |
> | freestyle 无流量 | hit+miss == 0 | **0**（`mS>0` 短路） | ✓ |
> | 局部性 | R=5 窗外扰动不变 | 50 次扰动、>50 格改动 ⇒ 结论逐位不变 | ✓ |
> | 回归 | `forbidden.test.js` | **12/12 全绿** | ✓ |
> | I-neg（防永远绿） | 篡改必挂 | 坏缓存（键去掉盘面）跨局面串味 ⇒ 断言捕获 | ✓ |
>
> ### 打包体积裁决（施工图 §4.12 选项②）
> A11 实现净增 **~3.4 KB**（局部哈希 + 偏移表 + 缓存 API），把 bundle 由 199.7 KB 顶到 **203.1 KB**。
> 三选项里选 **② 重标上限到 208 KB**（在 `test/worker.test.js:228` 附登记理由）；
> 未选①（精简既有注释只够 ~1.5 KB，且会删掉 #33 等决策证据链）、未选③（拆包改动面过广，另案）。
> **⚠ 这是硬断言**：后续 A9/A10/A13 若再顶破，须重新裁决，勿静默继续上调。
>
> **新增 API**：`PAT.forbiddenAtCached(board, idx, mode)`（显式带缓存入口）、
> `PAT.forbidMemoSet(bool)`、`PAT.forbidMemoClear()`、`PAT.forbidMemoStats() → {hit,miss,size,on,R}`；
> **`search.DEFAULT.forbidMemo = false`**。**回滚**：不传 `cfg.forbidMemo`。
> **未并入 `H_ALL`**（用 cfg 字段而非位开关，§4.0.4）。**无需 Elo**：纯缓存层 + 默认关，不改搜索真值（§5.5.2）。


---

### 4.13 A13 —— 增量结构 `assert` 自检（Carbon A8 / Stahlfaust A8，**贯穿全场**）

**动机**
Carbon 每次 `_move`/`undo` 前后 `assert(check())`，用"全盘重数 vs 增量维护"发现不一致
（`AICarbonMove.cpp:406-420`）。我们有**两次**"增量与全量不一致"的踩坑史。

**落点**（★ 已核对）：**新增** `engine/selfcheck.js`；
**打包白名单在** `tools/build-worker-src.js` 的 `FILES` 数组（**排除它**，见下）；
挂载点 `engine/core.js:46`/`:59`（`makeMove`/`unmakeMove` 前后调 `assertIncrementalStructures`，
**仅在 `cfg.assertIncr === true` 时**）。

**具体改动**
```js
// 只在 dev/test 模式启用；★ 绝不进 worker-src 打包
function assertIncrementalStructures(pos) {
  // ① pos.lc（线分缓存）== 全量重算
  // ② pos.material（A6 材料计数）== 全盘重数
  // ③ pos.see（A8）== 重算
  // 不一致 → throw
}
```
- **打包裁剪**：在 `tools/build-worker-src.js` 的 `FILES` 里**排除** `selfcheck.js`，
  或在打包时用条件裁剪。Carbon 用 `NDEBUG` 宏；我们用**打包白名单**。
- **绝不能进 `worker-src`**（否则拖慢生产性能）。

**验证**：新增测试 `test/selfcheck.test.js`：故意构造不一致局面，确认 `assert` 能爆掉。
且 `test/worker.test.js` 的"不夹带 UI"校验**扩展为"不夹带 selfcheck"**。
- **验证命令**：
  ```sh
  node --test test/selfcheck.test.js          # 新写：故意构造不一致 ⇒ 必须 throw
  node tools/build-worker-src.js
  node -e "
  const s=require('fs').readFileSync('engine/worker-src.js','utf8');
  console.log('含 selfcheck（必须 false）:', s.includes('assertIncrementalStructures'));
  "
  node --test test/worker.test.js             # 14 项（含 FILES 顺序 / 打包新鲜度）
  ```
- **★ 同时要确认"自检本身不拖慢"**：`cfg.assertIncr` 默认 **false**，
  ⇒ 打包后生产路径**零开销**（这也是"默认关"纪律的价值）。
- **★ `test/selfcheck.test.js` 必须真的能爆**（否则是"永远绿的测试"，见
  `test-methodology.md` §2.1 的 T1 根因）——**先写一个"故意不一致"用例确认它会 fail**。

**风险**：零（只在调试路径）。

#### ★ A13 实施记录（2026-09-21，完成）

**落地清单**（4 处文件）

| 文件 | 改动 | 关键点 |
|---|---|---|
| `engine/selfcheck.js` | **新增**（112 行） | UMD 包裹 `core`/`PAT`；`setAssertIncr`/`assertIncrOn`/`checkLineCache`/`checkMaterial`/`checkSee`/`checkIncrementalStructures`/`assertIncrementalStructures`/`coverage` |
| `engine/core.js` | `createPosition()` 加 `assertIncr: null`；`makeMove`/`unmakeMove` **末尾**各加 `if (pos.assertIncr !== null) pos.assertIncr(pos);` | ★ **挂载点比原设想更简单**：不传 `cfg`，改挂 `pos` 属性（见下） |
| `test/selfcheck.test.js` | **新增 7 项** | ④不误报 / ①I-neg(lc) / ①b I-neg(material) / ③默认关 / ⑤coverage 如实 / ⑥搜索集成 / ⑦往返复原 |
| `test/worker.test.js` | 打包测试扩展 | 断言"selfcheck 模块标记 + 5 个导出符号"均**不在**产物内 |
| `tools/build-worker-src.js` | **不改**（`FILES` 本就不含 selfcheck） | 白名单天然排除；靠 worker.test.js 防守"被误加回" |

**★ 实施中发现的三处偏离（原规格 → 实际，均有理由）**

1. **挂载点改为 `pos.assertIncr` 属性，而非 `cfg.assertIncr`**。
   原规格写"仅在 `cfg.assertIncr === true` 时调"。但 `core.js` 的 `makeMove(pos, ...)` **不接收 cfg**（cfg 是 `search.js` 的层概念），
   若强行把 cfg 传进 core 会污染核心 API。改为在 `pos` 上挂一个可选函数属性（默认 `null`）：
   `makeMove`/`unmakeMove` 末尾做一次 `!== null` 判断即调。`search.js` 的 `attachIncr(pos, cfg)` 本来就把 `onCell` 等挂在 `pos` 上，
   语义自洽。**生产开销 = 一次 null 比较/手**（不可测量）；且 `selfcheck.js` **不会被 require**（只有挂钩子者才 require）⇒ "零开销"承诺成立。

2. **钩子必须挂在"两相 notifyCell 全部完成之后"**（本案最关键的正确性细节）。
   `core.js` 的落子通知是**两相**（`'pre'` 预扫描 → 实际写盘 → `'post'` 增量更新），A6 的 `materialInc` 依赖 `line4`（pre 相产出）。
   若把自检挂在中间相，会看到"半更新"状态 ⇒ **必然误报**。故钩子置于 `makeMove`/`unmakeMove` 函数**最末尾**（所有通知完成后）。
   测试 ④（40 seed × 60 手 + 全撤）零误报即为该位置正确性的直接证据。

3. **`see`（A8）未落地 ⇒ 显式空实现 + `coverage()` 如实标注 `see:false`**。
   A8 已在批 4 裁决**砍掉**，故 `checkSee()` 返回 `[]`，但 `coverage()` 必须报 `see:false`（测试 ⑤ 断言之），
   避免"以为覆盖了 see"的**假安全感**（这比"少覆盖一项"更危险）。

**★ 测试的两个 I-neg 用例（防"永远绿的测试"，`test-methodology.md` §2.1 T1）**
- 写法要点：**"能检出"与"当场抛"分开验**。
  (a) 故意停更 `lc` / `material`（`onCell = null`）后**直接调** `checkIncrementalStructures` ⇒ 断言差异数组非空且类别正确；
  (b) 另起一个同样被破坏的 pos **挂上钩子** ⇒ `assert.throws(() => makeMove(...), /A13 自检失败/)`。
  —— 首版把 (a)(b) 混写（挂钩子后又去查差异数组），结果异常在 `makeMove` 内先抛出、**走不到断言**，2 项误报为红。
- I-neg 构造的**精确语义**（实测确认）：
  - `lc`：两子相邻（7,7/8,7）再落第 4 手 (9,7) 成三连 ⇒ `lc` 报 **4 处**（`lines[116/118]` + `tot[4/6]`）。
  - `material`：(5,5)/(6,5) + 第 4 手 (7,5) 成三连 ⇒ material 报 **2 处**（`[4] 0→1` / `[6] 1→0`）。
    这是 material 表的**长度档语义**：三连 = `counts[4]`，二连 = `counts[6]` ⇒ 成三连时 2↔3 档互换，自检精确捕捉。

**★ 收尾三件套实测（2026-09-21）**
```sh
node tools/build-worker-src.js
#   hash ceffd8633c20a7b2 / bundle 206.3 KB / 输出 211.7 KB
node -e "const s=require('fs').readFileSync('engine/worker-src.js','utf8');
         console.log(s.includes('assertIncrementalStructures'));"   # false ✓
node --test test/worker.test.js                                      # 14/14 ✓
```
- **★ bundle 206.3 KB（上次 A9 为 206.0 KB，上限 208 KB）**：增量来自 `core.js` 的两处钩子判断 + `assertIncr` 字段注释。
  这是"生产必需"的代价（dev 挂钩子的唯一入口），**未顶破上限，无需重新裁决**；余量收窄至 ~1.7 KB，**后续任何引擎改动都可能顶破** ⇒ 强化"必须重新裁决"的提醒。

**验证结果（2026-09-21）**
- `test/selfcheck.test.js` **7/7 绿**（含两个 I-neg 真能爆）。
- **全量 242 项全绿 / 0 失败**（22 个文件逐一跑）。
- **浏览器实跑 PASS 3/0**（`tools/browser-check.js`，沙箱外）：HASH `ceffd8633c20a7b2` 与产物一致，真机 Worker 往返 `via=book`/`opening=丘月局`，着法合法。
- hash 变更已预期并核验：`ff04291b803116e5`（A9）→ `ceffd8633c20a7b2`（A13），仅因 `core.js` 合法改动，`selfcheck.js` 未混入。

**★ A13 的长期价值**：把两次踩坑史（#35 单相位漂移、A6 首版净变化恒 0）这类"**静默不一致**"变成"**当场抛错**"。
以后任何改动 `lc`/`material` 增量维护的补丁（如未来复活 A10/A8），只要在 dev 挂上 `pos.assertIncr = SC.assertIncrementalStructures` 跑一遍搜索，即可秒级捕获不一致。

---

## §5 唯一实施批次表（操作版）

> 与 §3.2 同源，此处给**执行细节**：每批的**入口命令 / 出口判据**。

### 第 0 批：只读探针（**不写生产代码**）

| 探针 | 文件（新建，临时） | 输出 | 判据 |
|---|---|---|---|
| **P-A** | `_probe-hotspot.js` | `levelAt` / `threatMoves` / `staticEval` 各自占 `think()` 的 % | 决定 A6/A8/A10 生死 |
| **P-B** | `_probe-lastlayer.js` | 超时层已搜节点 / 总节点；浪费时间 % | 决定 A1 收益上限 |
| **P-C** | `_probe-candshare.js` | `candidates()` 占 `think()` 的 % | 决定 A9 生死 |
| **P-D** | `node tools/bench-mates.js` | 四档 VCF/VCT 题库通过率 + 耗时 | A3/A7 对照基线 |
| **P-E** | `_probe-wcls-hit.js` | `WCLS` 命中率、`rawClassify` 调用次数是否收敛 | 决定"表预计算化"是否有意义 |
| **P-F** | `_probe-forbid-memo.js` | 搜索中同一 `(局面, idx)` 重复率 | 决定 A11 生死 |

**★ 探针纪律**（我们已经踩过两次"静默空转"）：
- `verifyPath` 的 `path` 要 **idx 数组**，题库 `q.path` 是**坐标对** → 必须转换。
- `TH.think()` 返回的 **`r.move` 是 `{x,y}` 对象，不带 `.i`** → 用 `r.move.i` 会恒 `undefined`。
- **凡出现"全 0 / 全 RED / 整数边界"结果，先怀疑探针本身**，别急着解读成引擎缺陷。

**出口判据**：六个数落纸面 → 填入 §7 风险登记表的"实测"列 → **再决定第 1 批做什么**。

### 第 1 批（低风险，收益确定）

> ★ **A2 的四个剪枝在本批"逐个串行做"**（与 §4.2 的实现顺序表一致），
> 顺序为 **A2a(VDP) → A2b(RAZOR) → A2c(FUTILE) → A2d(MCUT)**，
> **每个都单独跑一遍出口判据**，通过一个才进下一个。

| 顺序 | 条 | 入口 | 出口判据 |
|---|---|---|---|
| 1 | **A1** 统一时间管理层 | 改 `think()`（**分 A1-a/b/c 三次提交**，见 §4.1） | 实测深度↑、题库不退化、`fallbackLevel` 语义已注明、`timeInfo()` 可读 |
| 2 | **A2a** VDP | 开 `H_VDP`（64） | **等价性 diff == 0**（纯正确性剪枝）+ 节点↓ |
| 3 | **A2b** razoring | 开 `H_RAZOR`（128） | 节点 ≤ 基线×0.9 + 题库不降 + **早退分支不写 TT** |
| 4 | **A2c** futility | 开 `H_FUTILE`（256） | 同上 |
| 5 | **A2d** 着法数裁剪 | 开 `H_MCUT`（512） | 节点↓ + **题库必须不降**（风险最高） |
| 6 | **A4** 胜着复核 | 开 `H_VERIFY`（2048） | 分数不变、复核触发 <1%、**题库通过率 ≥ 基线** |

**★ 位开关的"进 `H_ALL` 时机"**（见 §4.0.3）：
**本批完成后不立刻改 `H_ALL`**；等四个位**全部单独验收通过**，
再评估是否并入 `H_ALL_NEW`（那是一次**独立提交**，且要重跑全量 + 效果层基线）。

> ★ **批 1 执行进度（2026-09-20 收官）**：第 0 批探针 P-A~P-F ✓ / S0–S3 ✓ / **A1 三步 → ★整体回滚**（详见 §4.1）/
> **A2 四条 ✓ 收官**（b/d 并入、a/c 弃留档 ⇒ H_ALL 63→703，收官数据见 §4.2 验收记录）/
> **A4 ✓ 收官**（per-move 双层复核，diff 0/40 + 0/48、触发率 0.053%、节点 +0.13% ⇒ 并入 ⇒ **H_ALL 703→2751**，实施记录见 §4.4）。
> **★ 批 1 全部条目 + 全部收尾项完成**：
> ① ~~A1 统一 Elo~~（会话 8：A1 经作用前提检查判定全档位无正收益，已整体回滚——无需 Elo，A/B 在其可用档位零差异、跑了必然 CI 含 0，属 §5.5.5 黑名单第 3 条禁止行为；详见 §4.1 回滚记录）；
> ② **master 档快照**（回滚后：深度均 7.00/中位 10/范围 2–10，见 §4.1）；③ **浏览器实跑（§34，已自动化）**：
> **`node tools/browser-check.js`（须沙箱外跑）一次跑三页，PASS 3 / FAIL 0**——
> `book`（主线程直调 `G.search.think`）/ `degrade`（`G.ai` 降级分支 forceMain）/ `worker`（**真机 Blob Worker
> 往返，`后端 = worker`**）。★ **修正旧结论**：先前记"无头下 Worker 往返不工作、须人工确认"**不准确**——
> 真正不可用的是 `--dump-dom --virtual-time-budget` 模式（虚拟时钟冻结 2s 握手）；改 **CDP 驱动真实事件循环**
> 后 Worker 往返完全正常，故该项**已不必人工**。全量 **14 文件 179 项全绿**；
> worker **03d9f2fed663bd27**；基线 note=**A1-rolled-back**。

### 第 2 批（中风险，战术可信度）

| 顺序 | 条 | 前置 | 出口判据 |
|---|---|---|---|
| 1 | **A12** 算子化 | — | 与 `threatMoves` 逐局面等价 |
| 2 | **A3** VCF 耦合 | P-D | 题库不降、叶 VCF 命中率 >2% |
| 3 | **A7** 反向验证 | P-D | 题库不降、无假阴性 |

> ★ **批 2 进度（2026-09-20）**：
> **A12 ✓ 完成**——新增 `engine/operators.js`（**纯新增，threat.js 零改动**）：算子 = `{add:[{x,y,v}], cls, clsName, key, i, kind}`，
> 攻方手 `v=+1` / 强制应手 `v=−1`；`legalOperators(pos, atk, opts)` + `operatorMoves()`。
> **三处同步已做**（build-worker-src FILES + index.html script + 依赖顺序注释）。
> **对拍门槛达成**：新增 `test/operators.test.js` **5 项全绿**——构造式 **480 局面 × 4 配置** + 真实开局 **20 局面**，
> `operatorMoves` 与 `threatMoves` **选点集合 + 顺序 + kind 全等（diff == 0）**；另验算子结构不变量
> （成五无应手 / 唯一成五点须带应手）与"调用 operators 不改 threatMoves 结果"。
> 全量 **15 文件 184 项全绿**（179→184）；worker 重打包 **401cf5fd2c1812e1**（182.9 KB）；
> 浏览器实跑 `browser-check.js` **PASS 3 / FAIL 0**。
> **设计取舍留档**：算子枚举的**判定内核复用** `threat.fivePointsAfter` / `makesOpenThree`
> （不重写 §33.2 整数编码窗口表原语——重写它们等于重造已验证的正确性，收益为零）；A12 的价值在
> **结构化输出**（供 A7/A8/§35 复用），不在重造判定。
>
> **A3 ✗ 不并入（2026-09-20 收官）**——机制实现 ✓、功能门槛全过 ✓、**Elo 裁决否定**：
> ① 实现：`search.js` 的 `depth<=0` 分支前插叶 VCF（**先 VCF 再 quiesce**），新增位 `H_LEAFVCF=1024` +
> `cfg.leafVcfDepth`(默认 **0=常关**) / `cfg.leafVcfBudget`(默认 2000)，计数器 `leafVcfStat()`。
> ② **★ 发现并修正施工图伪码缺陷（#34）**：原稿 `PAT.WIN-1000-ply` = `MATE−ply < MATE`，
> 破坏 ①见杀早停 ②`toTT` ply 补偿 ③题库/分析判据 三处杀分语义 ⇒ 修正为 `PAT.WIN-ply`。
> 修正前实测题库 3/40，修正后 **39/40**（根层 VCF 关闭以隔离净贡献）。
> ③ 功能门槛（`tools/bench-leafvcf.js`，新增探针）：题库 10%→**98%**（Δ+35）/ 命中率 **33.86%**（≥2%）/
> 节点 **−25.9%** / 单题最速 depth 8→2、节点 −98%。**全部达标**。
> ④ **Elo 裁决（决定性）**：`hard-i100` vs `hard-i100-lv6`，**60 局 Elo(A−B)=+147.2，分层 CI [31.1, 263.2]**
> ⇒ **A（无叶 VCF）显著更强**；对照 `lv2` 40 局 **+0.0**（CI [−95,95]，中立）。
> **根因**：亏损正比于成本——叶 VCF 命中率虽高，但**每个叶节点都付一次 VCF 成本**，
> 在 100ms 紧预算档直接挤占搜索深度（安静中局墙钟 **+201.8%** 即证据）。
> **同 A2c FUTILE 教训：题库不降 ≠ 实战不降，耗时/深度回落才是领先风险指标。**
> ⑤ **裁决**：**不并入 `H_ALL`**（位 1024 保留留档、`leafVcfDepth` 默认 0）⇒ `H_ALL` 维持 **2751**；
> 机制/测试/探针全部保留，供**大预算档**（master/无限时分析）按需开启，或与成本控制方案组合后重测。
> 新增 `test/leafvcf.test.js` **6 项**（含「★杀分口径 ≥MATE」缺陷回归 + 关态零副作用等价 + renju 禁手安全 + 成本护栏）；
> 全量 **16 文件 190 项全绿**（184→190）；worker 重打包 **615d5f8e797b6212**（184.8 KB）；
> 浏览器实跑 **PASS 3 / FAIL 0**。
>
> **A7 ✓ 完成（2026-09-20 收官）**——`threat.js` 新增 `refutePath`（纯新增，不改 `dfs`/既有导出）；
> `solve()` 加 `opts.verify` 透传（**默认 false**）；`verify-mate.js` 加 `useVerify`。
> **门槛全过**：独立复算 verify 关 40/40 → verify 开 **40/40，假阴性 == 0**；
> 新增 `test/threat-verify.test.js` **7 项**全绿（含题 34/37 误杀回归 + 无副作用 + renju 兼容）；
> 全量 **17 文件 197 项全绿**；worker **d271cb933f703056**（188.2 KB）。
> **无需 Elo**（纯新增 + 默认关，§5.5.2 只有 A1/A3/A2 换深度需 Elo）。
> **★ 三个实测踩坑见 §4.5 实测节**（path 语义 / 攻方终局优先 / 前缀已在盘上）
> ——其中"攻方终局优先"漏了会**误杀真杀**，正是施工图预警的"本条最大风险"。
>
> **★ 批 2 全部完成**（A12 ✓ / A3 ✗ 位留档 / A7 ✓）。

### 第 3 批（地基，需 P-A 证明）

| 顺序 | 条 | 前置 | 出口判据 |
|---|---|---|---|
| 1 | **A6** 增量材料表 | P-A | 与全量重数一致（A13） |
| 2 | **A5** `wldOf` | A6 | 与全量判定逐局面对拍 100% 一致 |

> ★ **批 3 进度（2026-09-20）**：
> **A6 ✓ 完成**——`core.js` 挂 `pos.material`（`Int32Array(2*8)` 扁平，默认 `null`）+ 新增 `dirLinesAt`；
> `patterns.js` 新增 `NCLS`/`CELL_LINES4`/`scanLine4`/`matOff`/`lineCounts`/`lines4Counts`/`materialOf`/`materialInc`；
> `search.js` 新增 `cfg.incrMaterial`（**默认 false = 现状**）+ `attachMaterial`/`attachIncr`，`cellHook` 同时维护 `lc` 与 `material`。
> **前置门槛通过**：P-A 实测 `levelAt` 占 think() 墙钟 **35.0%**（≫ 10% 生死线）。
> **★ 发现并修正缺陷 #35**：`pos.onCell` 单相位不足以维护"原地递增"型增量结构
> （首版两次线扫描都在变化后 ⇒ 净变化恒 0 ⇒ 2400 步里 2026 步漂移）；
> 修复 = `core` 给钩子 `'pre'`/`'post'` 两相，`cellHook` pre 存快照 / post 求差。
> **验收全过**：自检不一致 **0/2400**（硬红线）、三口径逐位互证 0 偏差、往返复原 0/40、
> **I-neg 必爆**（已用篡改版验证会挂 3 项）、成本 **+0.7%**（≤+5%）、维护比全量重数快 **3.9~5.9×**、
> 默认关逐位不变、renju 全流程一致；新增 `test/incr-material.test.js` **9 项全绿**；
> 全量 **18 文件 206 项全绿**（197→206）；worker **`419966f4a6160ba5`**（196.1 KB）；
> 浏览器实跑 **PASS 3 / FAIL 0**。**无需 Elo**（纯新增 + 默认关，§5.5.2）。
> **下一步 = A5 `wldOf`**（用 A6 的材料计数做 3 次比较，与全量判定逐局面对拍 100% 一致）。

### 第 4 批（研究性，**允许砍掉**）

| 顺序 | 条 | 前置 | 出口判据 |
|---|---|---|---|
| ~~0~~ | ~~**A11** 禁手缓存~~ | ~~P-F ✓ 57.0% 已过~~ | **✓ 完成**（2026-09-20 会话 15；对拍 diff 0/40；端到端 **0.794×** 省 20.6%；见 §4.12 实施记录） |
| **1** | ~~**A9** 候选位图（保守版）~~ | ~~**P-C ✓ 10.5% 已过**~~ | **✓ 完成**（2026-09-21；含顺序对拍 **diff 0**；真实分布加权 **中位 0.910×**（快 ~9%，5 次重复 0.859–0.995）；见 §4.10 实施记录） |
| ~~2~~ | ~~**A10** 增量威胁表~~ | ~~先拆子问题（见 §4.11）~~ | **✗ 砍**（2026-09-21；三子面实测 `threatMoves` 0.8~3.6% / `staticEvalPos` 0.9~2.9% / `moveScoreAt` 的重扫不存在 ⇒ 收益上限 ≈2.5% ≪ 10% 线；见 §4.11 裁决记录） |
| ~~3~~ | ~~**A8** `see` 表~~ | ~~P-A/P-E~~ | **✗ 砍**（P-E 证明 WCLS 已惰性化 + A6 已替代核心动机，见下方重评估） |
| **4** | ~~**A13** 增量结构 `assert` 自检（贯穿）~~ | ~~A6/lc 已就绪~~ | **✓ 完成**（2026-09-21；`selfcheck.js` 新增，7 项测试含两个 I-neg 真能爆；全量 **242 绿**；打包 **206.3 KB** 不夹带；浏览器 **PASS 3/0**；见 §4.13 实施记录） |

> ## ★ 剩余优化点重新评估（2026-09-20，批 3 进行中；基于重跑的 P-A~P-F 实测）
>
> **触发**：A6 已落地（`levelAt` 占比 35% 得到验证），批 3 第 2 条 A5 待做；用户要求
> 「重新评估剩余优化点，确认哪些还需要考虑加入」。**判据一律用实测数字，不用文档旧印象。**
>
> ### 重跑实测（本轮，2026-09-20 22:38）
> | 探针 | 命令 | 本轮实测 | 旧记录 | 变化 |
> |---|---|---|---|---|
> | **P-A** | `_probe-hotspot.js 40 --ms=100` | `levelAt` **31.6%** / `moveScoreAt` 33.2% / `candidates` **10.5%** / `vcfWin` 4.4% / `vctWin` 3.6% / `staticEvalPos` 2.7% / `forbiddenAt` **0.0%（freestyle）** | 35.0% / 42.3% / 10.4% | 同量级，结论不变 |
> | **P-B** | `_probe-lastlayer.js 40` | 末层浪费 **均值 65.6%**（中位 75.0、最大 97.2）；打断层分布 `{4:18, 6:20}` | 同 | 同 |
> | **P-C** | 同 P-A | `candidates` **10.5%**（> 5% 有意义线） | 10.4% | 同 |
> | **P-E** | `_probe-wcls-cost.js` | `WCODE_N=19683`（19.2 KB）；全表预填 **167 ms**；hit 0.025 µs vs miss 上界 8.5 µs（**340×**） | 同 | 同 |
> | **★ P-F** | `_probe-forbid-memo.js 20 --ms=100`（renju） | 调用 **462,209** / distinct **198,692** ⇒ **命中率 57.0%** | 旧记录**未落数**（文档只写「Carbon 警告可能很低」） | ★ **新数据：远超 20% 门槛** |
>
> ### 逐条重新裁决（7 条剩余 + A13）
>
> | 条 | 裁决 | 依据（本轮实测） | 改动 |
> |---|---|---|---|
> | **A5** `wldOf` | **✅ 必须做（批 3 第 2 条）** | A6 材料表已就绪 ⇒ 3 次比较的成本前提成立；`staticEvalPos` 只占 2.7% 但**这是"终局短路正确性"而非纯性能**——现路径每次重扫，`judge.mate.plies` 是估算 | 维持原判，**优先级最高** |
> | **A7** 反向验证 | ✅ 已完成 | — | — |
> | **★ A11** 禁手缓存 | **⬆ 升级：从"需先证"→"值得做（renju 专项）"** | **P-F 实测 57.0% ≫ 20% 门槛**（旧文档只有"可能很低"的**推测**，无数据）。且 P-A 显示 freestyle 下 `forbiddenAt` 调用为 **0**（`mS>0` 短路）⇒ **收益完全集中在 renju**。成本侧：`forbiddenCore` 单价高（Carbon 实测 0.33→5.5 µs），57% 命中 × 高单价 = 实质收益 | 从批 4「需先证」**移入批 4 首个**；前置 P-F **已通过** |
> | **A9** 候选位图 | **✅ 做（保守版）** | P-C **10.5%** > 5% 门槛；风险**低**（纯等价重构）；且 `candidates` 的线性去重 + 225 格全扫在节点数升高后占比会**上升** | 维持批 4；**建议排在 A11 之后、A8 之前** |
> | **A10** 增量威胁表 | **✗ 砍（已测完）** | ★ **2026-09-21 数据到齐**：细拆 `threatMoves` 仅 **0.8~3.6%**（可省重复率 70.6% ⇒ 收益上限 **≈2.5%**）；`staticEvalPos` **0.9~2.9%**；`moveScoreAt`（36.8%）的"重扫"**不存在**（每候选点各算 1 次）⇒ **远低于 10% 生死线**。原"暂缓"升级为"砍"（原条件句「若 A12 后占比仍升不动则彻底砍」**已触发**） | 见 §4.11 裁决记录 |
> | **★ A8** `see` 表 | **⬇ 保持砍（不加入）** | ① P-E 证明 `WCLS` 已是**惰性表**：hit 0.025 µs 已是"表内直读"下限，miss 只 8.5 µs；② `levelAt` 31.6% 虽高，但其成本主要在 `scanRuns`/`decode9`，**预计算化只能省 miss**，而 P-E ① 全表预填要 167 ms（首屏 + 内存）；③ A6 的 `material` 已提供"有无某材料"的 O(1) 查询——**A8 的核心动机被 A6 部分替代**；④ 风险**高**（要重写维护层 + 与 `forbiddenCore` 语义耦合） | **砍**（结论从"先测再说"→"测完确认砍"） |
> | **A13** 自检 | **✅ 做（贯穿）** | A6 已把 `notifyCell` 的异常回滚语义打好（抛异常时棋盘自洽）⇒ 落地成本已降；`material`/`lc` 两套增量结构现成可对拍 | 维持；**建议与 A5 同批落地**（A5 也要对拍） |
>
> ### 新增：本轮浮现的"应考虑加入"项
> | 候选 | 为什么现在值得考虑 | 成本 | 建议 |
> |---|---|---|---|
> | **S2 大语料（kifu 派生）** | `kifu-test-design` 指出 40 局面只能看"方向"，**数万局面才能看"系统性偏移"**；现 `positions-renjunet.json` 仅 **1000** 条。A5/A6/A9/A11 的**对拍**都在用 40 局面——**分辨率不足以支撑"100% 一致"这类硬判据** | 一次性 ~30s（`tools/kifu-positions.js`） | **加入**（作为 A5/A9/A11 对拍前置） |
> | **A1 时间管理（复活评估）** | P-B 末层浪费 **65.6%** ⇒ 收益上限仍在。A1 此前**全档位回滚**，但 §4.1 记录的根因是「A/B 在可用档位零差异」，**不是收益不存在** | 中 | **不加**（回滚结论有效，勿翻烧饼；如需再做须先证"档位差异真实存在"） |
> | **A11 与 renju 专项** | renju 每局 53 s、`forbiddenCore` 单价高 ⇒ A11 在 renju 的**绝对收益**比 freestyle 大得多 | 低-中 | **随 A11 一起** |
>
> ### 修订后的批 3 / 批 4 次序（本表取代旧表）
> ```text
> 批 3：A6 ✓ → A5 →（并入 A13 自检骨架）
> 批 4：A11（P-F 已过）→ A9（P-C 已过）→ A10（**已砍**）→ A8 ✗砍
> ```
> **结论一句话**：剩余 7 条里 **A5 必做**、**A11 升级为值得做**、**A9 做保守版**、
> **A10 ✗ 已砍**（数据到齐，收益上限 ≈2.5%）、**A8 确认砍**、**A13 随 A5 一起**；另**建议补 S2 大语料**
> 作为 A5/A9/A11 的对拍前置（否则"100% 一致"判据的分辨率不够）。


### 贯穿：A13 自检（随每条增量结构一起上）

---

## §5.5 测试方法设计（按条 × 按场景）——★ 本篇新增，解决"测了但证明不了效果"

> **上游**：`test-methodology.md` v1.1（E 效果层）、`verdict-methodology.md`（三层漏斗）、
> `verdict-time-budget.md`（30 min 闸门）、`duel-methodology.md`（对局层过程信号）。
> **本节把上面四篇的**抽象方法**落到本文件 13 条（A1–A13）上**——每条该写哪类测试、
> 判据是什么、跑多久、放哪一层。**读完本节即可照着建测试，不必再回读四篇。**

### 5.5.1 为什么必须"分场景"——核心洞察

`test-methodology.md` §0 的实测结论：**179 项里只有 4 项能证明效果**。补 E 层能解决
"没有效应量断言"，但**还有一个更贵的坑**：**E 层若对全部 13 条都做"棋力测试"，
既跑不完（Elo 一次 2.8 h），又无必要**——因为**大部分优化在理论上不可能提升棋力**。

**判据（本节的核心裁决规则）**：

> **一条优化是否需要"棋力测试（Elo）"，取决于它是否改变"搜索真值（search truth）"。**
> - **改变真值**（搜得更深 / 搜得更准 / 停止更聪明）⇒ **理论上有棋力提升空间** ⇒ 需要棋力测试。
> - **不改变真值**（只改"同样结果算得更快"或"结构等价重建"）⇒ **理论上无棋力提升空间**
>   ⇒ **只做正确性测试 + 效率测试，禁止做 Elo**（做了也只会得到"CI 含 0"的噪音结论，
>   反而**用噪音否定掉确定性证据** —— 这正是 `verdict-methodology.md` V6 纠正的错误）。

**这条规则把 13 条切成两类（见 5.5.2）；两类用两套正交判据（见 5.5.3）。**

### 5.5.2 场景分类表（★ 唯一的"要不要做棋力测试"裁决）

| 条 | 名称 | 改真值？ | 理论棋力空间 | **主测试类型** | 要 Elo 吗 | 判据（硬） |
|---|---|---|---|---|---|---|
| **A1** | 统一时间管理层 | **是**（同样时限搜更深） | **有**（M9：限制棋力的是单位时间深度） | **棋力场景** | **✓ 要** | 深度↑ 且 题库不降；Elo CI 不含 0 才可声称提升 |
| **A2a** | VDP | **否**（纯正确性剪枝） | 无 | **正确性场景** | ✗ | **等价性 diff == 0**（节点必须也 ↓ 才留） |
| **A2b** | razoring | **是**（早退改变搜索值） | 有（若能省节点换深度） | **混合** | △ 仅当省节点换到深度 | 节点 ≤基线×0.9 + 题库不降；**不写 TT** |
| **A2c** | extended futility | **是** | 有（同 A2b） | **混合** | △ 同 A2b | 同 A2b |
| **A2d** | 着法数裁剪 | **是**（丢弃着法） | 有（风险最高） | **混合（偏正确性）** | △ | **题库必须不降**（首要）；节点↓ |
| **A3** | VCF 与 αβ 耦合 | **是**（叶节点战术） | **有**（深度无关杀棋） | **棋力场景（浅深度）** | **✓ 要**（浅深度口径） | 题库不降 + 叶 VCF 命中率 >2% |
| **A4** | 胜着复核 | **否**（复核不改选点） | 无 | **正确性场景** | ✗ | 分数不变 + 触发 <1% + 题库 ≥基线 |
| **A5** | `wldOf` O(1) | **否**（等价重建） | 无 | **正确性场景** | ✗ | 与全量判定逐局面对拍 **100% 一致** |
| **A6** | 增量材料表 | **否**（等价重建） | 无 | **正确性场景** | ✗ | 与全量重数一致（A13 自检**不一致==0**） |
| **A7** | VCF/VCT 反向验证 | **是**（可改变结论） | 有（防错报杀） | **混合（偏正确性）** | ✗ | 题库不降 + **无假阴性**；freestyle 先行 |
| **A8** | `see` 位掩码表 | **否**（查表替代计算） | 无 | **正确性场景** | ✗ | 对拍 **100% 一致** + NPS↑；**生死判据 = P-A 热点占比（<10% 砍，§4.9）**（★ v1.3 纠正："命中率≥20%"是 A11 的判据） |
| **A9** | 候选位图 | **否**（同集更快） | 无 | **正确性场景** | ✗ | 候选集逐局面**等价（含顺序）** |
| **A10** | 增量威胁表 | **否**（等价重建） | 无 | **正确性场景** | ✗ | **已砍**（§4.11；占比 0.8~3.6% ≪ 10% 线） |
| **A11** | 禁手评估缓存 | **否**（同结果缓存） | 无 | **正确性场景** | ✗ | 与无缓存路径**对拍一致** |
| **A12** | 算子化威胁枚举 | **否**（纯新增模块） | 无 | **正确性场景** | ✗ | 与 `threatMoves` **逐局面等价** |
| **A13** | 增量自检 | **否**（只断言） | 无 | **正确性场景** | ✗ | 自检**必须真能爆**（故意构造不一致 ⇒ 必 fail） |

**⇒ 需要棋力测试的只有 3 条：A1（主）、A3（浅深度）、A2 系列（仅当"省节点换到深度"）。
其余 9 条一律只做正确性/效率测试。**

**★ 一句话**：**"改真值"才测棋力，"不改真值"只测等价性与速度。**
把"节省节点/NPS 提升"当成"棋力提升"去跑 Elo，是被 V6 明确禁止的错误。

### 5.5.3 两套正交判据（各场景用各场景的尺）

| | **正确性场景**（9 条） | **棋力场景**（A1/A3，及 A2 达成换深度时） |
|---|---|---|
| **问题** | "结果还对不对？" | "同样的代价，是不是更强？" |
| **判据形态** | **布尔/等价**（`diff == 0`、`对拍一致`、`100%`） | **连续/统计**（深度、节点、NPS、Elo+CI） |
| **核心手段** | **对拍**（旧路径 vs 新路径）+ **自检**（A13）+ **反例** | **基线快照对比**（E2）+ **题库分层**（E1）+ **Elo**（L3） |
| **成本量级** | 秒级~分钟级 | 分钟级~小时级 |
| **抽样噪声** | **无**（确定性） | Elo 有（**有效样本只 52 格子**） |
| **判定纪律** | 一致即通过；不一致即**必须修** | CI 不含 0 才可声称提升；否则如实写"未检出" |

**★ 最重要的方法论点（来自 `test-methodology.md` E2）**：
**搜索是确定性的 ⇒ "深度/节点/NPS"相对基线是零采样噪声的**，比 Elo（52 格子、小时级）
**可信得多、也快得多**。⇒ **A1/A3 的"棋力"首先用"深度/节点"确定性证据说话，
Elo 只作为"最后确认"**（`duel-methodology.md` 的 L1 → L3 降级逻辑）。

### 5.5.4 单元测试 / 功能测试 / 版本迭代 三层映射

用户要求"便于单元测试、功能测试，便于版本迭代"。本节给三层各自的**测试对象 / 文件 / 判据 / 频率**：

| 层 | 测什么 | 文件（新增/既有） | 判据 | 何时跑 | 归属场景 |
|---|---|---|---|---|---|
| **U 单元** | 纯函数：`see` 表构建、`wldOf`、增量计数、算子枚举、时间预算函数 | `test/see.test.js`、`test/wld.test.js`、`test/incr-material.test.js`、`test/operators.test.js`、`test/timebudget.test.js` | **等价性 / 确定性断言**（不是绝对阈值） | **每次改动** | 正确性 |
| **U' 单元（等价对拍）** | 新路径 vs 旧路径，逐局面 | 并入上面的 U 文件（`for` 循环 40 局面） | `diff == 0` | 每次改动 | 正确性 |
| **F 功能** | 引擎对外契约：`think` 返回、`hint/judge/heat/analyze`、`record` 往返、`worker` 协议 | `test/search-contract.test.js`、`test/coach.test.js`（既有）、`test/worker.test.js`（既有） | **契约字段/类型/单调性**（如 `hints` 按 `norm` 有序） | **每次改动 + 合入前** | 正确性 |
| **P 性能** | 微基准（µs）与搜索效率（深度/节点/NPS） | `test/effect-micro.test.js`、`test/effect-search.test.js`（★ 见 5.5.5） | **相对基线的效应量**（`≤基线×1.05` 等） | 合入前 | 效率 |
| **S 棋力** | Elo（对局层）；浅深度题库 | `tools/bench-elo.js` / `_bench-renju-pair.js` / `bench-mates.js` | **CI 不含 0**（声称提升时） | **仅 A1/A3（及 A2 换深度时）** | 棋力 |
| **V 版本迭代** | "本版 vs 上版"的效应量 | `test/baseline/metrics.json`（快照）+ `tools/snapshot-metrics.js` | **Δ 与显著性**（自动生成报表） | **每个版本收尾** | 两类兼有 |

**★ 版本迭代的关键机制（T3 根因的解法）**：`test/baseline/metrics.json` 是
**git（本项目无 git ⇒ 用文件快照 + 版本号）里的"上版真值"**。
每次合入后**重跑 `snapshot-metrics.js` 覆盖**，于是"本版比上版好在哪、差在哪"
由**数据自动给出**，而非靠人回忆。**基线更新必须是"已接受改动"的副产品**，绝不为"让测试变绿"而更新。

### 5.5.5 每条测试的"特效性检查"（防止写了永远绿的测试）

**这是 `test-methodology.md` §2.1 的 T1 根因在本文件的落地**：
**任何"效果类"断言，上线前必须确认它"在被测目标未改进时会失败"。**
具体做法 —— **三步注入法**（`test-methodology.md` §5 的 I-0~I-6）：

| 注入 | 做法 | 期望 | 用于验 |
|---|---|---|---|
| **I-neg** | 人为让目标变差（如把 `stopEarly=1.0` 退回） | 断言**必须 fail** | 效果断言不是永真 |
| **I-zero** | 人为关掉整条优化（`cfg` 开关） | 断言**必须 fail** | 断言确实绑在该条上 |
| **I-pos** | 人为让目标变好（如把 budget 调大） | 断言**必须 pass** | 断言能认好方向 |

**⇒ 验收 T-1~T-4（沿用 `test-methodology.md`）**：
T-1 判别率 ≥90% / T-2 假阳率 ≤0.01 / T-3 信息产出率 ≥3 / T-4 E 层总耗时 ≤3 min。

**★ 三条"永远绿的测试"黑名单（本文件明确禁止）**：
1. `assert.ok(true)` 式的"结构断言"（如"`see` 表存在"→ 不证明它查得对）；
2. 只看**点估计**不比**基线**的性能断言（"节点 < 某大数"）；
3. **对"不改真值"的条跑 Elo**（结构上必得"CI 含 0"，等于用噪音否定确定性证据）。

### 5.5.6 逐条测试清单（施工级：文件 / 用例 / 命令 / 耗时）

> 下表**每条给出可直接新建的测试文件与用例**。判据列复述 5.5.2。
> ★ 单元测试统一放 `test/`；效果层放 `test/effect-*.test.js`；探针放根目录 `_probe-*.js`。

**A1 统一时间管理层（棋力场景）**
- 文件：`test/timebudget.test.js`（U）+ `test/effect-search.test.js`（P，共用）
- 用例（★ v1.3 改写：原稿用例①引用了设计中不存在的 `turnTimeMin/turnTimeMax`——§4.1 用
  `hardLimit + tacticalRatio` 切分，没有 timeLeft/turnTime 参数）：
  ① **预算切分（A1-a）**：`hardLimit=400` 时 `timeInfo().tactBudget ≈ min(threatMs, 400×0.35)`、
  `budgetMax = hardLimit − 战术实际耗时`，两者均落在 `[50, hardLimit]`；
  ② **稳定收缩（A1-c）**：最佳着稳定且 `d≥7` 时 `budgetMax` 按 `stabilFactor` 收缩且下限 ≥200ms；
  ③ `stopEarly` 命中时**提前返回且 `timeInfo().stopped===true`**；④ `fallbackLevel` 语义三态可复现；
  ⑤ **I-neg**：`stopEarly=1.0` ⇒ 深度量测断言**必须 fail**。
- 命令：`node --test test/timebudget.test.js && node tools/bench-search.js --compare baseline`
  （★ `--compare` 为拟新增参数，随 S1 的 `tools/verdict.js` 落地；落地前用位置参数 `40 60 8` + 手动对照基线）
- 耗时：U ~2 s；P ~4 min（深度量测）
- **判据**：深度 ≥基线−0.01；题库不降；**Elo 仅在声称"棋力提升"时跑**（`fs-i100` 439 局 ≈28 min）

**A2a VDP（正确性场景）**
- 文件：`test/prune.test.js`（U，四子条共用）
- 用例：**等价性 diff == 0** —— 开 `H_VDP` vs 关，**同一批 40 局面、同一时限**，
  `bestMoves` 选点与分值**逐条相同**（VDP 是纯正确性剪枝，**必须零差异**）。
- 命令：`node --test test/prune.test.js`
- 耗时：~10 s
- **判据**：`diff == 0`（不满足 ⇒ 不是正确剪枝，必须修）；节点也要 ↓ 否则不留

**A2b/A2c razoring / futility（混合）**
- 用例：① 节点 ≤基线×0.9；② 题库不降；③ **早退分支不写 TT**（TT 探针断言）；
  ④ **仅当**"省下的节点换到了更深实测深度"才升为棋力场景跑 Elo。
- 命令：`node --test test/prune.test.js && node tools/bench-search.js --compare baseline`
- **判据**：节点 ≤×0.9 + 题库 ≥基线；**不许把"节点降"直接说成"棋力升"**

**A2d 着法数裁剪（混合偏正确性）**
- 用例：**题库必须不降**（首要，风险最高）；节点 ↓；**I-neg** 故意多裁 ⇒ 题库断言必 fail。
- 判据：**题库 ≥ 基线为硬门槛**（裁剪会真丢着法）

**A3 VCF 与 αβ 耦合（棋力场景，浅深度口径）**
- 文件：`test/leafvcf.test.js`（U）+ `tools/bench-mates.js`（S）
- 用例：① 叶 VCF 结论与独立复算一致；② **叶 VCF 命中率 >2%**（低于则砍，见 §7 风险表）；
  ③ **浅深度口径**（depth 3）下的题库通过率不降（沿用 §17.2 的 `bench-mates` 发现：
  差距只在浅深度显现）。
- 命令：`node --test test/leafvcf.test.js && node tools/bench-mates.js`
- 判据：题库不降 + 命中率 >2%

**A4 胜着复核（正确性场景）**
- 文件：`test/verify-win.test.js`（U）
- 用例：① 构造"窄窗会误判"的局面，确认复核**纠回**正确分值；② **触发率 <1%**；
  ③ 分数不变（复核不改选点）。
- 判据：分数不变 + 触发 <1% + 题库 ≥基线

**A5 `wldOf`（正确性场景）**
- 文件：`test/wld.test.js`（U）
- 用例：**逐局面对拍 100% 一致**（40 局面 × 多深度，`wldOf` vs 全量判定）。
- 耗时：~15 s 判据：`不一致 == 0`

**A6 增量材料表（正确性场景）**
- 文件：`test/incr-material.test.js`（U）
- 用例：① 与全量重数**逐局面一致**；② **make/unmake 往返后缓存完全复原**（沿用 `incr.test.js` 范式）；
  ③ **I-neg** 破坏一个计数 ⇒ **A13 自检必须爆**。
- 判据：不一致 == 0

**A7 反向验证（混合偏正确性）**
- 文件：`test/verify-threat.test.js`（U）
- 用例：① **无假阴性**（真杀不被否掉，题库全过）；② `opts.verify` 默认 false（关时行为不变）；
  ③ freestyle 先行、renju 后验。
- 判据：题库不降 + 假阴性 == 0

**A8 `see` 位掩码表（正确性场景，风险最高）**
- 文件：`test/see.test.js`（U）
- 用例：① 表构建**逐位正确**（对拍暴力计算）；② 对拍 **100% 一致**；
  ③ **生死判据：P-A 热点占比 ≥10% 才做**（§4.9；★ v1.3 纠正——"命中率 ≥20%"是 A11 的判据，勿混用）；
  ④ **I-neg** 打乱表 ⇒ 对拍必 fail。
- 判据：对拍一致 + NPS↑ + **P-A 占比 ≥10%（否则砍，否则表白建）**

**A9 候选位图（正确性场景）** ✅ 已完成（2026-09-21）
- 文件：`test/cand-bit.test.js`（U，**实际 10 项**；施工图原写 `candbit.test.js`）
- 用例：候选集**逐局面等价（含顺序）**；边界（边线/角/radius 0 与超大）同集；**默认关逐位不变**；
  空盘天元；**word 边界（跨 32/64/96）输出严格 idx 升序**；真实搜索 `candBit` 开关 diff 0；
  **`bestMoves` 路径门控**；I-neg（乱序必挂）；`candStat` 观测自洽；成本护栏。
- 判据：`diff == 0`（含顺序）✓；成本比 ≤1.05 —— **★ 该判据实测不可行于单测**（µs 级基准同进程可漂 ±20%），
  改由独立进程 `tools/_a9-real.js` 承担：5 次重复**中位 0.910**、最差 0.995（均 ≤1.05 ✓）；
  单测只保留宽上界 1.30 防灾难回退。

**A10 增量威胁表（正确性场景）** ✗ **已砍**（2026-09-21，见 §4.11 裁决记录）
- 原计划文件：`test/incr-threat.test.js`（U）—— **未创建**（条已砍，无需测试）。
- 砍因：三子面实测占比 0.8~3.6% / 0.9~2.9% / 无重复扫描 ⇒ 收益上限 ≈2.5% ≪ 10% 线。
- ★ 复活条件见 §4.11（vcfDepth 大幅提高或 vcf/vct 调用频次量级上升时复测）。

**A11 禁手评估缓存（正确性场景）**
- 文件：`test/forbid-memo.test.js`（U）
- 用例：与无缓存路径**对拍一致**；缓存键覆盖 `(规则, 局面哈希)` 无串味。
- 判据：对拍一致

**A12 算子化威胁枚举（正确性场景）**
- 文件：`test/operators.test.js`（U）
- 用例：与 `threatMoves` **逐局面等价**；`fAdd`/`DefenseRefutes` 算子语义。
- 判据：等价

**A13 增量自检（正确性场景）** ✅ 已完成（2026-09-21）
- 文件：`test/selfcheck.test.js`（U，**实际 7 项**）
- 用例：④ 随机对局逐步自检 0 差异（40 seed × 60 手 + 全撤）；① **I-neg(lc)** 故意停更 ⇒ 必爆（**能检出**与**当场抛**分开验）；
  ①b **I-neg(material)** 同上；③ 默认关 ⇒ 生产路径不受影响（`pos.assertIncr === null`）；
  ⑤ `coverage()` 如实标注 `see:false`（A8 已砍，防假安全感）；⑥ **搜索集成**：`think` 全程挂自检 ⇒ 结论 diff 0 + 0 异常；
  ⑦ make→unmake 往返后 `lc`/`material` 逐位复原。
- 判据：能爆 ✓ + 不误报 ✓ + 不进生产包 ✓（`worker.test.js` 扩展：模块标记 + 5 个导出符号均不在产物）

### 5.5.7 三种场景的"测试配方"（直接照抄）

`verdict-time-budget.md` §3.3 给出了"按改动类型"的 30 min 配方；本节把它**按场景**重排，
每条只需选一行：

| 场景 | L1 快筛（≤2 min） | L2 中筛（≤10 min） | L3 棋力（≤30 min） | 13 条中的谁 |
|---|---|---|---|---|
| **正确性场景** | 对拍 + 单测 | 题库回归 | **不需要** | A2a/A4/A5/A6/A8/A9/A10/A11/A12/A13 |
| **效率场景** | 微基准 | NPS + 深度 | **不需要** | （与正确性重叠，见各条） |
| **棋力场景** | 对拍 | **深度 + 题库** | `fs-i100` 439 局 | **A1 / A3** |

**⇒ 13 条里只有 2 条需要 L3；其余 11 条 12 min 内可完整裁决。**
（这条结论把"一次裁决 30 min+"降到"多数 12 min"，正是用户"高效"诉求的落点。）

### 5.5.8 与既有测试套件的关系（明确"不推翻、只叠加"）

| 既有 | 动作 | 理由 |
|---|---|---|
| **179 项回归护栏** | **保持不动** | 它们拦"改坏了"（C 管灾难），是 L0 地基 |
| `test-mates`（D 类 4 项） | **保留并升格**为 E1 题库分层 | 唯一的效果断言，是 A3 的判据来源 |
| 既有 C 类绝对阈值断言（11 项） | **不删**，另**新增 E3 相对基线** | C 管"崩 10 倍"，E3 管"渐变 5%" |
| 测试总数 | 179 → 新增约 **40–60 项**（U 层） | 全部**确定性/等价性**，无采样噪声 |

### 5.5.9 实施顺序（测试先于优化——同 `test-methodology.md` 铁律）

```
S0 建 L2 过程信号（duel-methodology 的 D-1 trace / D-2 _duel-trace.jsonl / D-3 duel-analyze.js，≈8h）
   ← ★ v1.3 新增：A1/A3 是仅有的两条棋力场景条，而 A1 的 Elo 噪声最大，必须有"形势分曲线 Δ"
     作过程证据；与 S1–S3 并行施工，同属第 1 批前置（D-4/D-5 仍按需后置）
S1 建基线快照基础设施（metrics.json + snapshot-metrics.js + tools/verdict.js 统一入口）
   ← 前置，无它则"效果"无法表达。★ v1.3：verdict.js = verdict-methodology 的 V1/V2
     （深度·NPS 一等指标 + [效应量] 打印统一格式），§4.0.6 的散装验收命令逐步迁入；
     bench-search 的 --compare 参数随它落地
S2 建 positions40.json 局面集（与 verdict-time-budget V9 共用）
   + renjunet 派生 1000+ 大集合（★ v1.3：吸收 kifu-test-design——同一套 gen-positions40 工具产两档；
     对拍条 A5/A6/A9 用大集合更稳，快筛用 40）
S3 建 U 层等价对拍脚手架（通用 runner，输入带"局面集档位"参数）   ← A2a/A5/A6/A8/A9/A10/A11/A12 共用
S4 按 5.5.6 逐条补：先补"改真值"的 A1/A3 的判据，再补其余
S5 版本迭代收尾：每次合入后重跑 snapshot-metrics.js，生成 Δ 报表
```

**★ 铁律（与 test-methodology / duel-methodology 同一句）**：
**S0–S3 就绪前不要开始任何优化**——否则改完仍无法证明效果。

---

## §6 冲突裁决登记表（"不冲突"的书面依据）

| # | 冲突 | 涉及 | 裁决 | 依据 |
|---|---|---|---|---|
| **C-1** | 三个"缓存层改造"抢 `patterns.js` | A6 / A8 / A10 / A11 | **串行**；同一时间只允许一条在分支上；优先级 `A6 > A11 > A10 > A8` | 三者都改 `levelAt` 周边；并行会互相覆盖（铁律 2 的同类风险） |
| **C-2** | 都想用"材料计数" | A5 / A11 | **A5 复用 A6 的计数**，不另建 | PentaZen 的 `check_wld` 本就依赖 `material`；Stahlfaust 的增量表是"威胁"而非"计数" |
| **C-3** | 棋盘加边距 vs 全项目地基 | Carbon-A4 | **明确排除** | 触及 `idxOf`/`xOf`/`yOf`/Zobrist 维度/所有 `%N` 转换/`record` 口径/`openings` idx 表/测试硬编码 idx，**收益 << 风险** |
| **C-4** | 剪枝四条同时开 | A2a–A2d | **逐一开、逐一基准** | PentaZen 文档明确警告；一次开多个无法归因 |
| **C-5** | 算子化 vs 现有 `threat.js` | A12 | **纯新增模块**，`threat.js` 语义不动 | 降低回归面 |
| **C-6** | 时间管理改变"实测深度"含义 | A1 vs `bench-difficulty` | **基准工具需注明"改后深度不可与改前直接比"**；对比时双方同设置 | 否则会把"停止策略变化"误读成"棋力变化" |
| **C-7** | 三条"停止"建议 | Carbon-A7 / Stahlfaust-A7 / PentaZen-A1 | **合并为统一的 `think()` 时间管理层**（§4.1） | 三者是同一条，分别改会造成三处冲突 |
| **C-8** | 反向验证 vs 现有 `solve()` 行为 | A7 | `opts.verify` **默认 false** | 保持既有行为，回归面最小 |
| **C-9** | `see` 表 vs `forbiddenCore` | A8 | **共存**（`see` 筛选 / `forbiddenCore` 终判），**不许替换** | #33 漏判事故的教训 |
| **C-10** | 剪枝早退的值写 TT | A2b/A2c | **不写 TT** | 估值不是搜索值，ply 补偿语义不同，会污染 TT |
| **C-11** | 自检代码进生产 | A13 | **打包白名单排除**，`worker.test.js` 扩展校验 | Carbon 用 `NDEBUG`；我们无宏，用打包裁剪 |
| **C-12** | 战术预算 vs 主搜索预算 | A1 / A3 | 战术优先切分（`tacticalRatio`），主搜索用剩余 | Stahlfaust `dbextratime` 的经验 |

---

## §7 风险登记表

| 条 | 风险 | 等级 | 缓解 | 回滚 |
|---|---|---|---|---|
| A1 | K 过大 ⇒ 深度降而节点未降 | 低 | 标定 K∈[3,5]；深度量测段对比 | `stopEarly=1.0; layerFactor=∞` |
| A2 | 剪枝返回错误搜索值 | 中低 | 不写 TT；逐一开；等价性对拍 | `cfg.h` 去位 |
| A3 | 叶 VCF 成本 > 收益 | 中 | `leafVcfBudget` 硬限；命中率 <2% 则关 | `leafVcfDepth=0` |
| A4 | 窄窗误判真胜着为失败 | 低 | 已知必胜局面回归 | 去 `H_VERIFY` |
| A7 | 反向验证产生假阴性 | 中 | 题库 + `verify-mate.js` 独立复算；freestyle 先行 | 不传 `opts.verify` |
| A12 | — | 低 | 纯新增；对拍 `threatMoves` | 不引用 |
| A6 | 计数与全量不一致 ⇒ 静默错判 | 中 | **A13 自检**；`incr:false` 对拍 | `incrMaterial=false` |
| A5 | `wldOf` 与全量判定不一致 | 低 | 逐局面对拍 100% | `wldFast=false` |
| A8 | 语义耦合 | **高** | 先 P-A/P-E；`see` 与 `forbiddenCore` 共存 | `useSee=false` |
| A9 | 矩形半径算错 ⇒ 漏点 | 低 | 随机对局逐步对比候选集 | `candBit=false` |
| A10 | 大改动 | **高** | 先 P-A；对拍重扫；A13 | `incrThreat=false` |
| A11 | 缓存键不当 ⇒ 错禁手结论 | 低中 | 先 P-F；与无缓存路径对拍 | `forbidMemo=false` |
| A13 | 自检进生产拖慢性能 | 零 | 打包白名单排除 + 测试校验 | — |

**★ 实测列（2026-09-20 重跑，供裁决引用）**：

| 条 | 生死探针 | 实测 | 门槛 | 裁决 |
|---|---|---|---|---|
| A5 | —（A6 已就绪） | — | 对拍 diff 0 | **做** |
| A6 | P-A | `levelAt` 31.6% | ≥10% | ✅ 已做 |
| **A8** | P-A / P-E | `levelAt` 31.6%；`WCLS` hit 0.025 µs（惰性表，miss 仅 8.5 µs） | ≥10% **且** 预计算化有意义 | ✗ **砍**（A6 已替代其"有无材料"核心动机） |
| **A9** | P-C | `candidates` 10.5% | ≥5% | ✅ **已做**（★ 含顺序对拍 diff 0；真实分布加权 **中位 0.910×** 快 ~9%；见 §4.10） |
| **A10** | P-A（威胁通道） | `vcfWin` 3.1% + `vctWin` 2.8% ≈ **5.9%**；细拆 `threatMoves` **0.8~3.6%**（重复率 70.6%）；`staticEvalPos` 0.9~2.9% | ≥10% | ✗ **砍**（收益上限 ≈2.5% ≪ 线；③ 的"重扫"不存在；见 §4.11） |
| **A11** | P-F | 命中率 57.0%（P-F）→ 实测 74.2%（renju depth4）；**端到端 0.794×** | ≥20% **且** 端到端不变慢 | ✅ **已做**（★ 初版全盘键 1.415× 负收益 ⇒ 局部哈希键转正，见 §4.12） |


**通用缓解（所有条）**：
1. 每批结束**全量 179 项测试** + **重打包** + **浏览器实跑一次**。
2. 任何"增量 vs 全量"结构必须配 **A13 自检**。
3. 基线口径：**题库通过率**（离散可数）优先于 Elo（噪声大、耗时）；
   Elo 只在"题库不退化"之后才跑，且**必须 CI 不含 0**。
4. **★ 只有 §5.5.2 判定为"棋力场景"的条（A1/A3 + A2 换到深度时）才跑 Elo**；
   其余条做 Elo 属**禁止项**（见 §5.5.5 黑名单第 3 条）——避免用噪音否定确定性证据。

---

## §7.5 版本迭代收尾（S5）—— 批 4 完成后的基线重标定（2026-09-21）

> S5 原文：「版本迭代收尾：每次合入后重跑 snapshot-metrics.js，生成 Δ 报表」。
> A13 完成 ⇒ 施工图 13 条全部有终局 ⇒ 触发一次**完整收尾**。

### 7.5.1 收尾动作

```sh
node tools/snapshot-metrics.js --diff     # 与旧基线（A1-rolled-back）对照
node tools/snapshot-metrics.js --save --note A13-complete-batch4   # 重标基线（182s）
```

- 旧基线 note = `A1-rolled-back`（2026-09-20T11:32），**采集于批 1 结束、批 2–4 全部改动之前**。
- 新基线 note = `A13-complete-batch4`（2026-09-20T17:29），**采集于 13 条全部落地之后**。
- **局面集 sha 未变**（`b90083cf5d9c`）⇒ 两次快照**口径可比**。

### 7.5.2 Δ 报表（旧 → 新）

| 指标 | A1-rolled-back | A13-complete | Δ | 判定 |
|---|---|---|---|---|
| `mates.attackPass` | 40 | 40 | 0 | **✓ 不变** |
| `mates.defensePass` | 8 | 8 | 0 | **✓ 不变** |
| `mates.totalNodes` | 111317 | 111317 | **0.00%** | **✓ 逐位不变** |
| `search.depthFixedTotalNodes` | 821409 | 821409 | **0.00%** | **✓ 逐位不变** |
| `search.nps` | 36019 | 22474 | **−37.6%** | ⚠ 见 7.5.3 |
| `search.timeDepthMean` | 5.75 | 4.75 | −17.4% | ⚠ 墙钟派生，同 7.5.3 |
| `micro.makeMove` | 0.873 | 2.017 | +131% | ⚠ 见 7.5.3 |
| `micro.staticEval` | 4.65 | 5.28 | +13.5% | ⚠ 见 7.5.3 |
| `micro.staticEvalPos` | 0.72 | 0.96 | +33% | ⚠ 见 7.5.3 |
| `micro.candidates` | 1.27 | 1.39 | +9.4% | ⚠ 见 7.5.3 |
| `micro.winningPoints` | 4.5 | 7.067 | +57% | ⚠ 见 7.5.3 |
| `micro.levelAt` | 0.186 | 0.222 | +19% | ⚠ 见 7.5.3 |
| `micro.forbiddenAt` | 3.132 | 3.614 | +15% | ⚠ 见 7.5.3 |

### 7.5.3 ★ 关键结论：**正确性零变化；墙钟/micro 的"下降"不可归因于任何改动**

**决定性证据（三条，均已实测）**：

1. **确定性指标逐位不变**：`mates.totalNodes` 111317、`depthFixedTotalNodes` 821409 —— **一字不差**。
   ⇒ 所有 13 条改动对**搜索真值与节点展开**的影响**精确为零**（与各条的"等价对拍 diff 0"交叉印证）。
   这是本收尾最重要的一条：**任何"性能下降"都没有伴随正确性/行为变化**。

2. **`nps` 36019 不可复现 ⇒ 旧基线的该值不可信**（口径核对过：新旧快照的 nps 都是
   `depthFixedTotalNodes / depth固定墙钟`，同口径）。实测反证：
   | 配置 | nodes | NPS |
   |---|---|---|
   | 现状（h=2751） | 821409 | **22 300**（3 轮取 min；连测 20.5k–22.8k） |
   | h=63（A2/A4 之前） | 1862725 | **25 524** |
   | 摘掉 A13 钩子判断 | 821409 | 22 942 |
   | 摘掉 A6 的 `try/catch` | 821409 | 22 454 |
   ⇒ **连"回到 A2/A4 之前"也只有 25.5k** ⇒ **36k 在任何代码变体下都测不出来** ⇒ 旧快照的 36019
   是**过期/异质采集**（机器热状态或负载差异），**不是代码回退**。

3. **逐项排查排除了"某条改动拖慢热路径"**：
   - A13 的 `pos.assertIncr !== null` 判断：摘掉后 NPS 22942 vs 22792 —— **无差异**（且生产为 `null`）。
   - A6 的 `try/catch`：摘掉后 22454 vs 22792 —— **无差异**（V8 处理良好）。
   - `incr:false`（摘掉 §33.3 的 lc 缓存）：**更慢**（21054）⇒ lc 缓存有正收益。
   - A6/A9/A11 三个新开关**默认全关** ⇒ 热路径上只有一次属性/布尔判断，量级为 ps 级。
   - **`micro` 各项 +9%~+131% 是"单函数 µs"**：`makeMove` 的绝对值 2.0 µs 里包含两相 `notifyCell`
     （A6 为 material 引入的相位参数）与 `if (!pos.onCell) return;` —— 这些是 A6 的**结构成本**，
     但**未转化为端到端损失**（见 ②，且各条验收时端到端均达标：A11 0.794×、A9 0.910×、A6 +0.7%）。

### 7.5.4 处理与结论

- **处理 = 重标基线**（已执行，`--save --note A13-complete-batch4`），使后续改动有**当前口径**的比较基准。
- **不做回滚**：① 正确性/行为零变化；② 无任何证据指向具体改动；③ 三个新开关默认关，回滚收益为零。
- **★ 纪律强化（写入长期记忆）**：**跨会话/跨机器比较墙钟或 µs 指标必须重采基线**；
  不同时间点的绝对 NPS/µs **不可直接相比**（本次 36k vs 22k 即反例）。
  可比的是**同一次运行内的 A/B**，或**确定性可数指标**（节点数、通过率）。
- **★ 遗留观察项（不阻塞）**：`micro.makeMove` 从 0.873 µs 涨到 ~2.0 µs。虽然端到端无损失，
  但 `makeMove` 是全局最热函数，若未来要榨性能，**"给 `notifyCell` 加 try/catch 的替代方案"**
  （如把回滚逻辑移到调用方、或用 `onCell` 返回错误码）值得一探——**列为 M10 打磨期的可选优化**。

---

---

## §8 合并反向清单（三篇汇总，**明确不学**）

| 项 | 来源 | 为什么不学 |
|---|---|---|
| 棋盘加安全边距（4 格 `WRONG`） | Carbon A4 | **触及全项目地基**（`idxOf`/Zobrist/坐标转换/测试硬编码），收益 << 风险 |
| 哈希不处理碰撞 | Carbon | 我们已有键校验 + 规则盐，正确性优先 |
| TT 无代龄 | Carbon | 我们的 `age` 解决了跨轮污染 |
| 禁止静态搜索 | Carbon | quiescence 是 M7 正式增强，不该退 |
| 禁手的"方向计数"判定 | Carbon | §13 ⑤(e) 已用数据否证（漏判 19.5~23.7%） |
| 全额 `qsort` 候选 | Carbon | 占其 11.9%；我们用宽度截断更优 |
| 硬编码大表（600 KB `.CPP`） | Carbon | 保持"生成器 + 数据文件"管线 |
| TT 渐进 resize | Carbon A5 | 我们 `ttBits` 由难度档固定，内存不是瓶颈（除非弱设备场景） |
| `fieldagent.Clone()` 每节点深拷 | Stahlfaust | 我们有 `unmakeMove`，更快；抄它 = 主动降速 |
| 朴素 Negamax 无 LMR/IID | Stahlfaust | 抄袭 = 主动弱化 |
| `int[,]` 棋盘 | Stahlfaust | 我们 `Int8Array` + Zobrist 更省更可哈希 |
| db-search 直接照抄 | Stahlfaust | freestyle 专用 + 不完备 + 组合阶段是空的 `#if false` |
| 1 KB 硬编码开局 | Stahlfaust | 我们 3733 节点前缀树 + 真胜率，量级领先 |
| `Console.WriteLine` 调试输出 | Stahlfaust | 生产代码不应有 |
| NUMA 绑定 / 大页 / `prefetch` | PentaZen | **浏览器无此原语** |
| `std::thread` + 共享可变 TT | PentaZen | **Worker 无 `SharedArrayBuffer` 保证**（§33.4 已权衡） |
| 65536×16 `uint32` 静态表（4 MB） | PentaZen | 首屏加载不可接受（我们 `WCLS` 19 KB） |
| C++ 模板多维 `NArray` | PentaZen | JS 无零成本抽象 |
| 延迟更新双标志复杂度 | PentaZen | 我们 `unmakeMove` 直算足够好 |
| `uint16` Move 坐标加减法 | PentaZen | 我们 `idxOf` 算术已等价，改造收益小 |
| 无测试/无基准/无开局库的开发方式 | PentaZen | **我们的测试与基准是真实资产，不放弃** |

---

## §9 与 `gomoku-design.md` 的接口对账表

> 本文件所有改动**必须**与既有设计文档一致；本表是"不冲突"的书面依据。
> 实施后需**回写** `gomoku-design.md` 对应章节。

| 改动 | 落点 | 关联既有章节 | 是否改变契约 | 回写位置 |
|---|---|---|---|---|
| A1 时间管理 | `search.js:think()` | §24.4 时限 / §24.7 降级链 / §17 基准 | **否**（`fallbackLevel` 语义不变，但需注明"预测式停止会减少 level=2"） | §24.4 / §17 |
| A2 剪枝 | `search.js:pvs()` | §24.1 PVS / §24.2 启发式 | 否（新增 `H_*` 位） | §24.2 / §16 |
| A3 VCF 耦合 | `search.js:pvs()` 叶 / `:threatSolve` | §25 VCF/VCT / §6 求解顺序 | 否（新增 `cfg.leafVcf*`） | §25 / §6 |
| A4 胜着复核 | `search.js:pvs()` | §24.1 / §25 | 否 | §24.1 |
| A7 反向验证 | `threat.js` 新增 | §25.4 求解顺序 / §10 提示 | 否（`opts.verify` 默认 false） | §25.4 / §10 |
| A12 算子化 | 新增 `operators.js` | §35 杀法库 / §30 文件结构 | 否（纯新增） | §30 / §35 |
| A6 增量材料表 | `core.js` / `patterns.js` | §33.3 增量评估 / §3 状态表示 | 否（新增 `pos.material`） | §33.3 / §3 |
| A5 `wldOf` | `patterns.js` / `eval.js` | §4.7 终局短路 / §11 形势判断 / §28 `judge` | 否（返回结构不变） | §4.7 / §28 |
| A8 `see` 表 | `patterns.js` | §33.2 预计算表 / §33.3 增量 | **否**（只做加速，不替代 `forbiddenCore`） | §33.2 / §16 |
| A9 候选位图 | `eval.js:candidates` | §24.3 候选生成 | 否（返回仍是有序数组） | §24.3 |
| A10 增量威胁表 | `core.js` / 新模块 | §33.3 / §25 | 否 | §33.3 |
| A11 禁手缓存 | `patterns.js` | §8 / §26 禁手判定 | 否（纯缓存） | §26 / §16 |
| A13 自检 | 新增 `selfcheck.js` | §30 文件结构 / §18 测试 | 否（不进打包） | §30 / §18 |

**三条硬约束的对账**：
1. **不破坏契约**：上表"是否改变契约"**全部为"否"**。
2. **可回滚**：每条都有 `cfg.*` 开关（§4 已列）。
3. **可验证**：每条都有量化验收指标（§4 已列）。

---

## §10 附录

### 10.1 三篇建议 → 本文件条号对照

| Carbon | Stahlfaust | PentaZen | 本文件 | 处置 |
|---|---|---|---|---|
| A7 预测式停止 | A7 预测式停止 | A1 时间管理 | **A1** | **合并**（三方共识） |
| A2 全局计数器 | — | A5 `check_wld` / A6 材料表 | **A6 + A5** | **合并**（都需计数） |
| A1-a 矩形裁剪 | A6 有意思点增量 | A8 MoveList 位图 | **A9** | **合并** |
| A3 禁手缓存 | — | — | **A11** | 保留（需 P-F） |
| A6-a WCLS 预计算 | — | A7 `see` 表 | **A8** | **合并**（都是"棋型查表化"） |
| A4 棋盘边距 | — | — | — | **排除** |
| A5 TT resize | — | — | — | **排除**（弱收益） |
| A8 自检 | A8 自检 | — | **A13** | **合并** |
| — | A1 反向验证 | A4 胜着复核 | **A7 + A4** | 分开（一条验杀线，一条验胜着） |
| — | A2 算子化 | — | **A12** | 保留 |
| — | A3 增量威胁表 | — | **A10** | 保留（需 P-A） |
| — | A4 战术分预算 | — | **A1**（并入） | **合并** |
| — | A5 db-search 分支 | — | — | **排除/延后**（研究性） |
| — | — | A2 剪枝补齐 | **A2** | 保留（逐一开） |
| — | — | A3 VCF 耦合 | **A3** | 保留 |

### 10.2 关键常量对照（实施时参考）

| 含义 | PentaZen | Carbon | Stahlfaust | 我们的现状 |
|---|---|---|---|---|
| 胜分 | `SCORE_WIN=10000` | `WIN_MIN/MAX=25000/30000` | `WIN=1000000` | `PAT.WIN=1e8`；`MATE=PAT.WIN-1000` |
| 时限缓冲 | `BUFFER_MS=300` | — | — | 无（新增） |
| 提前终止阈值 | `turnTime*0.7` | `t1+5*td>=stopTime` | `resttime>=usedtime` | **无**（A1 补） |
| 时限检查粒度 | 每 512 节点 | 每 1000 节点 | 每 3000 节点 | 每 1024 节点（`nodes & 1023`） |
| 战术预算 | `BONUS_REFUTATION=480` | `quickWinSearch` | `dbextratime` | 无（A1 补） |
| 线数 | 88 | 4 格边距 | — | **72**（长度 ≥5 过滤后，§33.3） |

### 10.3 现有开关索引（实施时勿冲突）

| 开关 | 值 | 用途 |
|---|---|---|
| `H_LMRF` | 1 | LMR 规格公式 |
| `H_KILL2` | 2 | 次级 killer 槽 |
| `H_IID` | 4 | 内部迭代加深 |
| `H_ROOT` | 8 | 根层 TT + 复用 |
| `H_LMRR` | 16 | 削减后全深重搜 |
| `H_MALUS` | 32 | history malus |
| `H_ALL` | 63 | 默认全开 |
| **新增预留** | 64/128/256/512/1024/2048/4096 | VDP / RAZOR / FUTILE / MCUT / LEAFVCF / VERIFY / （预留） |
| `cfg.incr` | bool | 线分缓存（§33.3） |
| `cfg.bookModel` | `'tree'\|'line'\|'auto'` | 开局库模型 |
| `cfg.h` | 位掩码 | 启发式总开关 |
| **新增 cfg 字段** | 见各条 | 全部可省略，省略即默认 |

### 10.4 本文件与三篇 study 文档的关系

```
carbon-gomoku-study.md ──┐
stahlfaust-study.md ─────┼──► 【本文件】优化整合设计文档 ──► 实施 ──► 回写 gomoku-design.md
pentazen-study.md ───────┘                                        （§16/§17/§33）
```

- 三篇 study = **素材与论证**（为什么做、别人怎么做）；
- **本文件 = 施工图**（做什么、按什么顺序、怎么验证、怎么回滚）；
- `gomoku-design.md` = **现行契约**（不改，只回写结果）。

---

## §11 版本记录

- **v1.0（2026-09-20）**：首版。整合 `carbon-gomoku-study.md`（v1.1）、`stahlfaust-study.md`（v1.0）、
  `pentazen-study.md`（v1.0）三篇研读的**全部可执行建议**，去重合并为 **13 条（A1–A13）**，
  按**唯一批次表**（第 0–4 批 + 贯穿）排序，给出**冲突裁决登记表 12 项**、**风险登记表 13 项**、
  **合并反向清单 21 项**、**与 `gomoku-design.md` 的接口对账表 13 项**（全部"不改变契约"）。
  **未做任何引擎代码改动。**
- **v1.1（2026-09-20，编码执行版）**：把文档从"设计级"补强为"照着敲就能写"。
  - **新增 §4.0 全局施工契约**（7 个子节）：① 改文件铁律（一律 `Edit`、同文件 `Edit` 串行、
    改引擎源码必重跑 `build-worker-src.js`）；② 新增模块三处同步（`index.html` + `build-worker-src.js`
    的 `FILES` + 依赖模块）与**打包顺序**（core→patterns→rules→eval→threat→search→book→record→coach→worker-entry）；
    ③ **位开关分配表**（`H_VDP=64`/`H_RAZOR=128`/`H_FUTILE=256`/`H_MCUT=512`/`H_LEAFVCF=1024`/`H_VERIFY=2048`，
    且 **`H_ALL` 保持 63 不变**，新位由各条按批次逐条并入）；④ **cfg 字段登记表**（13 字段，全部默认关）；
    ⑤ **新增导出登记表**（`wldOf`/`seeTable`/`candBitInfo`/`threatTableInfo`/`forbidMemoStats`/`timeInfo`）；
    ⑥ **统一验收命令**（全量回归 179 项 + 定向测试 + 效果层 + 打包新鲜度）；⑦ **每条统一交回格式**。
  - **逐条补强 A1–A13**（每条七件套：目标 / 落点 `文件:行号` / 改动 / 接口契约 / **分步提交顺序** /
    验证命令 / 量化门槛 / 回滚）：
    - **A1（时间管理）**：落点详表 `search.js:518/521-522/531/542/425/555-568/569/576`；
      新增 `timeInfo()` 观测导出；拆 **A1-a（预算切分）/A1-b（预测式停止）/A1-c（稳定加时）** 三步提交。
    - **A2（剪枝补齐）**：落点 `search.js:31-37/304/312/216/374/260/157`；拆
      **A2a(VDP)→A2b(RAZOR)→A2c(FUTILE)→A2d(MCUT)** 四步，**A2a 等价性 diff 必须为 0**。
    - **A3–A13**：逐条给出已核对的 `文件:行号` 落点、可粘贴验证命令、量化门槛
      （如 A6 自检不一致 == 0、A5 对拍不一致 == 0、A8 命中率 ≥ 20% 否则砍、A9 对拍 diff == 0 含顺序）。
  - **§5 第 1 批排序对齐**为 `A1 → A2a → A2b → A2c → A2d → A4`（与 §4.2 一致），并加"位开关进 `H_ALL` 时机"说明。
  - **修正 v1.0 三处不一致**：§5 与 §4.2 的 A2 子步顺序；§4.0.4 与正文的字段名
    （`vcfAtLeaf`→`leafVcfDepth`/`leafVcfBudget`；`verifyWin`→ 说明 A4 只有位开关 `H_VERIFY`）。
  - **未做任何引擎代码改动**（本次仅改文档）。
- **v1.2（2026-09-20，测试方法设计）**：新增 **§5.5 测试方法设计（按条 × 按场景）**，
  解决"测了但证明不了效果"（用户诉求：便于单元/功能测试、便于版本迭代、高效且真能验证效果）。
  - **核心裁决规则**：按 **"是否改变搜索真值（search truth）"** 分类——
    **改真值 ⇒ 棋力场景（需 Elo）；不改真值 ⇒ 正确性场景（禁 Elo）**。
  - **§5.5.2 场景分类表**：13 条逐条标注"改真值？/理论棋力空间/主测试类型/要 Elo 吗/硬判据"。
    **结论：只有 A1、A3（及 A2 达成"省节点换深度"时）需棋力测试；其余 10 条只做正确性/效率测试。**
  - **§5.5.3 两套正交判据**：正确性场景用"布尔/等价（`diff==0`/对拍 100%）"；
    棋力场景用"连续/统计（深度/节点/NPS 相对基线 + Elo+CI）"。★ 强调**搜索确定性 ⇒
    "深度/节点"零采样噪声，比 Elo 可信且快**（E2），Elo 仅作最后确认（L1→L3 降级）。
  - **§5.5.4 单元/功能/版本迭代三层映射**：U（纯函数等价）/ U'（对拍）/ F（引擎契约
    `think`·`hint/judge/heat/analyze`·`record`·`worker`）/ P（性能效应量）/ S（棋力）/
    V（版本迭代：`metrics.json` 快照 + `snapshot-metrics.js` ⇒ "本版 vs 上版"数据自动给出）。
  - **§5.5.5 防"永远绿测试"三步注入法**（I-neg/I-zero/I-pos）+ 验收 T-1~T-4 +
    **三条黑名单**（含"对不改真值的条跑 Elo"）。
  - **§5.5.6 逐条测试清单（施工级）**：A1–A13 每条给出**测试文件 / 用例 / 命令 / 耗时 / 判据**。
  - **§5.5.7 三种场景的 30 min 配方**：⇒ **13 条里只有 2 条需 L3（30 min），其余 11 条 12 min 内可裁决**
    （把"一次裁决 30 min+"降为"多数 12 min"）。
  - **§5.5.8 与既有 179 项的关系**：保持不动 + 叠加，测试总数预计 179 → **约 220–240 项**（全确定性）。
  - **§5.5.9 实施顺序**：S1 基线基础设施 → S2 `positions40.json` → S3 对拍脚手架 →
    S4 逐条补 → S5 版本迭代报表。★ **S1–S3 就绪前不要开始任何优化。**
  - **§7 风险表**加"通用缓解第 4 条"（只有棋力场景才跑 Elo）；**§0 阅读契约**加"要给某条写测试"行。
  - **未做任何引擎代码改动**（本次仅改文档）。
- **v1.3（2026-09-20，对账修正）**：开工前对代码逐条核查（证据链见 `optimization-plan-review.md`）：
  **行号锚点约 30 处全部核对无误**（仅 `depth<=0` 实际 :311 与原稿 :312 差 1）、
  179 项测试全绿复核通过（实测 97 s）、验证命令依赖的导出全部在位、A2a VDP 常数按本引擎
  杀分口径（`PAT.WIN − ply`）确认**正确**。据此修正 v1.2 的 **5 处文档缺陷 + 5 项裁决**：
  - ① **A1 替换循环补回 :556-564 渴望窗**（原稿整段丢失且引用未定义的 `lo/hi`——照抄会静默删除
    M7 渴望窗特性并挂 search-enhance 测试）；同步把 §4.1 代码块的 `budgetMax/mainDeadline` 改 `let`；
  - ② **A1-c `stabilFactor` 收缩对象改为 `budgetMax`**（原稿乘 `lastTd`：稳定 ⇒ "预测更便宜 ⇒ 更敢开
    下一层"，与 PentaZen"稳定 ⇒ 收缩 turnTimeMax 更早收手"方向相反；§4.0.4 登记表、接口契约、
    伪码块、实现顺序表四处同步改）；
  - ③ **A3**：`!pos.win` 改显式"上一步已成五"判定（`pos` 无 `.win` 字段）；未定义的 `o.rule/o.overlineMode`
    统一为 `cfg.*`；落点 :312 校正为 **:311**；
  - ④ **A2c 补"forcing 着法"定义**（A: `moveScoreAt ≥ 活三分值`，廉价首选；B: threat 类别判定，精确备选）；
  - ⑤ **A8 判据纠正**（§5.5.2/§5.5.6 的"命中率 ≥20%"是 A11 的判据；A8 生死判据 = P-A 热点占比 <10% 砍）；
  - ⑥ **§5.5.6 A1 用例①改写**为对 `timeInfo().tactBudget/budgetMax` 的断言（原稿 `turnTimeMin/Max`
    在 §4.1 设计中不存在）；`bench-search --compare` 标注随 S1 落地；
  - ⑦ **§5.5.9 前置扩为 S0–S3**：S0 = duel D-1~D-3（L2 过程信号 ≈8h——A1 的 Elo 噪声最大，必须有
    "形势分曲线 Δ"过程证据）；S1 并入 `tools/verdict.js`（V1/V2）；S2 并入 renjunet 派生 1000+ 大语料
    双档（吸收 kifu-test-design）；铁律同步改为"S0–S3 就绪前不动工"；
  - ⑧ **A11 验证命令重写**为真脚本（原稿 JS 内混入 `#` 注释 = 语法错误 + 伪 stdin），命中率采集
    显式依赖 P-F 探针灌流量。
  - **仍未做任何引擎代码改动**（本次仅改文档）。
- **v1.4（2026-09-21，全部实施完毕 + 版本迭代收尾）**：**13 条（A1–A13）全部有终局**。
  - **做 9 条**：A2（RAZOR/MCUT 并入；VDP/FUTILE 弃留档）、A4（VERIFY）、A5（wldFast）、A6（incrMaterial）、
    A7（refutePath verify）、A9（candBit）、A11（forbidMemo）、A12（operators）、A13（selfcheck 自检）；
    **A1 已整体回滚**（作用前提检查：全档位无正收益，见 §4.1）。
  - **砍 3 条**：A3（叶 VCF，功能门槛全过但实战 −147 Elo）、A8（`see` 表）、A10（增量威胁表，收益上限 ≈2.5%）。
  - **基础设施**：S0–S3 全部就绪（探针 / `verdict.js` / `positions40.json` / 对拍脚手架）；
    **S5 本次执行**——**新增 §7.5 版本迭代收尾**，重标基线 `A13-complete-batch4`。
  - **§7.5 关键结论**：确定性指标**逐位不变**（`mates.totalNodes` 111317、`depthFixedTotalNodes` 821409）；
    墙钟 NPS 36019→22474 经三条实测反证为**旧基线不可复现**（连"回到 A2/A4 之前"也只有 25.5k），
    **非代码回退**。纪律强化：**跨会话比较墙钟/µs 必须重采基线**。
  - **交付状态**：全量 **242 项测试全绿**（22 文件）、worker `ceffd8633c20a7b2`（206.3 KB / 上限 208）、
    浏览器实跑 PASS 3/0。
- **v1.4 附记（2026-09-21，UI 增强 R1–R4 —— 非引擎优化，走 UI 层）**：
  - **定位**：本批是**用户新增的 UI 需求**，**不动任何引擎搜索/评估语义**（13 条优化条约不受影响）。
    之所以记在本施工图，是因为 R2/R3 触及**开局库的两套数据用途分工**（§12.4.3 选点 vs §12.4.4 标注），
    而"线库是否进 worker 产物"正是 §12.4.3 已裁决过的问题 ⇒ 需要在此**明确不回退**。
  - **R1 坐标标注**：`ui/render.js` 新增 `colLabel/rowLabel/coordAt` + 非对称留白布局；
    口径与 `engine/record.js:61` / `data/openings.js:R(s)` **三处对拍 225 点一致**（天元 = H8）。
  - **R2 棋谱库**：`ui/booklib.js` + `#bookLibPanel`，数据 = `engine/data/book-lines.js`（588 局 / 26 开局）。
    **★ 线库维持"不进 worker 产物"**（§12.4.3 v3.22 的裁决不变）——`book.js` 的 `bookLines()` 访问器
    **只供主线程**，`build-worker-src.js` 的 FILES **不加** `book-lines.js`（实测 bundle 仍 206.8 KB）。
  - **R3 命中标注**：`probeTree/renderHit` 下探 `book-tree.js`（带 n/胜率）⇒ 三态措辞（命中 / 部分命中 / 未命中）。
    **★ 两个概念区分**：`depth`（匹配到第几层）与 `hit`（该层是否有可用后继）**是两个独立事实**；
    **对称展开的已占点须过滤**（规范键混入不同对称分支，实测 2193 候选里 5 个落在已占点）。
  - **R4 持久化 + 锁定**：`ui/prefs.js`（白名单 + try/catch 降级 + 读回重校验）；**高亮单一真相源**
    （`setHeatUI` 唯一写点）；`LOCK_WHILE_PLAYING = [selRule, selMode, selSide]`。
  - **验收**：**新增 `tools/browser-feat-check.js`（PASS 20/0）** + `test/ui-features.test.js`（12 项）；
    **无回归**：单文件 PASS 8/0（hash `60ff683f9b9b3615`）、开发壳 PASS 3/0、**全量 254 项全绿**（23 文件）。
  - **下一步**：无（M1–M10 + R1–R4 全部收口）；可选后续 = M11 / M3c / M9 `DIFFICULTY` 复标定。
- **v1.4 附记 ②（2026-09-22，UI 增强 R5 —— 侧栏分类归置 + 分层展开，非引擎优化）**：
  - **定位**：仍是**纯 UI 层**，**不动任何引擎搜索/评估语义**（13 条优化条约不受影响）。
  - **改动**：**新增 `ui/menu.js`（折叠分组模块）** + 侧栏重构为 7 个语义分组（`game/display/hint/judge/record/book/help`），
    只有「对局设置」默认展开 ⇒ **首屏 937 → 733 px**；点「提示/形势/棋谱」自动展开对应分组；
    分组头常驻动态摘要（`行棋中已锁定` / `第 N 手 · 5 个候选` / `均势` / `588 局 / 26 开局`）；
    开合状态写 `prefs.groups` 持久化。
  - **★ 修掉 4 个"点得动但结果不对/看不见"的真实缺陷**：
    ① `record.js: fromGame()` 漏调 `enter()` ⇒「棋谱」按钮生成的棋谱**永不进入回放**（控制条不出现、开关语义失效）；
    ② `panels.js` 用 `judgeBox.innerHTML = …` 覆写容器 ⇒ 缓存引用变**游离节点**，**形势条一次失败后永久失效**（静默）；
    ③ 请求被新请求顶替（`ai.js` 单通道 latest-wins）时面板**永久停在"计算中…"**（失败分支没有出口收尾）；
    ④ `booklib.js` 缓存了 `#blMeta` 却**从未写入** ⇒ 棋谱库标题常年显示「—」。
  - **★ 另修 3 处"画面与数据不符"**：回放中「提示/形势」算的是**后台对局**（改为回放感知）；
    回放换手后**旧候选/热力不失效**（新增步数变化即作废）；回放中方向键**双响应**（main 与 record 各有一个 keydown）。
  - **★ 通用教训（写入长期记忆）**：
    1. **重排 HTML 先查重复 id** —— 照抄控件忘删旧位置 ⇒ `getElementById` 只返回第一个，**测试全绿但用户点不动**。
    2. **凡给 UI 写"进行中"状态，必须在全部出口（成功/失败/取消/被顶替）收尾**，复位要还原**上一次有效结果**。
    3. **不要用 `innerHTML` 覆写"含被缓存子元素引用的容器"**。
    4. **验证脚本的端口必须无冲突、导航必须轮询就位** —— 假失败比真失败更危险（会误导去改没坏的代码）。
  - **验收**：**新增 `tools/browser-menu-check.js`（PASS 34/0，开发壳与单文件各跑一遍）** + **`ui-features.test.js` 12 → 21 项**；
    新增 `tools/_edge-boot.js`（共用无头 Edge 启动器，根治端口撞车）；**连跑两轮四套浏览器校验全绿**（3 + 20 + 34 + 8）；
    **全量 263 项测试全绿**（23 文件）；单文件 `gomoku.html` **652.2 KB / 22 内联脚本**。
- **v1.4 附记 ⑦（2026-09-23，R9.1 发布到线上后的黑盒实跑 —— 抓出 1 处启动期真缺陷，非引擎优化）**：
  > **定位**：**发布 / 验收批次**（引擎一行未动；R9 的功能代码只改了 `ui/main.js` 的 1 行守卫）。
  > 起因：把产物免费发布成在线分享链接后，发现**"本地全绿"并不代表"线上可用"**
  > （https 跨源、目录快照、Worker 的加载路径与 MIME 都与本地不同）。
  - **新增一次性探针 `tools/_live-check.js`**：**不改任何代码**，直接对线上链接做黑盒断言
    （两页各 13 项：就绪 / 标题 / **零未捕获异常** / 首绘 / Worker 真起 / AI 真应手 /
    触屏自动启用 / `touch-action` / 轻点只出待落点 / 确认才落 / 拖动预览跟手 / 拖动释放直接落 / 阶段零异常）。
    ★ **第一轮就抓到 1 处本地 631 项断言全都没覆盖到的真缺陷**。
  - **★ 缺陷：每次加载抛一次未捕获异常（启动竞态）**。`renderer` 在 `ui/main.js` **模块顶层**创建，
    而 `ui/render.js` 的 `ResizeObserver.observe()` 会**立刻投递初次回调** ⇒ 那时 `pos` 还没建
    （要等 init 里 `createPosition()`）⇒ `draw()` 读 `pos.board` 抛 `TypeError`。
    - **为什么 300 单测 + 331 浏览器断言全都发现不了**：异常抛在**观察器回调**里 ⇒ 不阻断启动、
      界面照常能画、`Runtime.evaluate` 照常返回 ⇒ 所有"看状态 / 看像素 / 看布局"的断言**全绿**。
      ⇒ **唯一防线是监听 `Runtime.exceptionThrown`**，而此前没有任何套件收集它。
    - **二次危害**：回调里先跑的 `_resize()` 可能已重建位图（`canvas.width=` 赋值即清空）⇒
      抛错会留下"清空后未重绘"的**白板窗口**。
    - **修法**：`draw()` 开头补 `if (!pos) return;`（与 `redraw()` 既有守卫同写法，1 行）。
  - **★ 常驻守卫**：`tools/browser-touch-check.js` 新增「**加载期零未捕获异常**」（真页面 ×2 目标）。
    双向验证：临时禁用该守卫 ⇒ **变红**（`✗ TypeError: Cannot read property 'board' of undefined`），还原即绿。
  - **★ 铁律十六（"回调里抛的异常"不在断言视野内，必须显式监听）**：已写入 design §29.2。
  - **★ 两处探针自伤（假失败）也一并修掉**：① `_live-check.js` 起初"就绪后立刻读像素/读后端"，
    报出 `drawn=0` / `backend:'main'` —— 后经诊断（强制 `reset()` 同帧采样 = 4222、子资源 24 个全 200、
    首绘最长需 264ms）判定为**读得太早**；改**有预算的轮询**后稳定全绿。
    ② `browser-explore.js` 原先把 `load()` 失败**静默丢弃**，就绪超时会以
    `Cannot set property 'value' of null` 形式爆出（看着像功能坏了）⇒ 改为显式抛出"页面未就绪 + 该往哪看"。
  - **验收**：全量 **300 项全绿**（24 文件）；浏览器 **341 项全绿**（开发壳 178 / 单文件 163，
    其中 `touch` 由 41 → **42**）；**线上链接实跑 26/26 全绿**（连跑 3 轮稳定）；
    单文件 `gomoku.html` **831.9 KB / 24 内联脚本**。

- **v1.4 附记 ⑥（2026-09-23，R9 移动端小屏模式 —— 触屏落子：确认后落子 / 拖动释放落子，非引擎优化）**：
  > **定位**：**功能批次**（不是优化、也不是审计）。引擎一行未动；改动集中在 `ui/touch.js`（新增）、
  > `ui/main.js`、`ui/render.js`、`index.html`（结构与样式）。**13 条优化条约不受影响**。
  - **需求**：手机上"点一下即落子"太危险（15 格棋盘 1 格仅 ~24px，拇指误差常达 1~2 格，而五子棋不可逆）
    ⇒ 两步式：**轻点 → 待落点（幽灵子 + 底部确认条）→ 确认才落**；**按住拖动到目标松手 = 直接落子**。
    再点同一点 / `Enter` 也确认，`Esc` / 「取消」撤掉。
  - **做法**：判定抽成纯函数模块 `ui/touch.js`（`autoOn/resolve/isDrag/decide`，Node 可穷举测边界）；
    `ui/main.js` 只做 pointer 事件 → 状态 → 重绘的编排，并新增 **`commitAt()` = 落子唯一入口**
    （鼠标点击 / 触屏确认 / 拖动释放共用 ⇒ 禁手拦截、读谱推演、触发 AI 三处语义天然一致）；
    `renderer.draw` 支持 `state.ghost`；小屏媒体查询把棋盘从 80vw 放宽到 96vw、侧栏单列、触控目标 ≥40px。
  - **★ 两条新教训（已写进 design §29.2 铁律十四 / 十五）**：
    ① **触摸设备上 `click` 是合成事件**：手势 + click 双路径必须显式让路，且只能用**真浏览器真输入**
    （`Input.dispatchTouchEvent`）验证 —— JS 合成 `PointerEvent` 既不会产生合成 click、
    也验不出 `touch-action`，等于把这条缺陷完全测漏（实测：去掉让路即"轻点直接落子"，11 项断言变红）。
    ② **状态对 ≠ 画对**：`touchState().ghost` 一直正确、而绘制优先级写反 ⇒ 拖动预览被待确认点盖住，
    用户看到"拖动毫无反应"，**所有状态断言全绿**。是**截图对比发现两张图字节相同**才揪出来的
    ⇒ 现在加了**像素级**断言（读 `getImageData` 比较拖动前后同一点的颜色），注入该缺陷即变红。
  - **验收**：全量 **300 项全绿**（24 文件）；浏览器 **331 项**（含新增 `tools/browser-touch-check.js` 37 项 ×2 目标）；
    单文件 831.0 KB / 24 内联脚本。守卫双向验证：静态 3 处、浏览器 1 处（11 项变红）均"注入即红、还原即绿"。

- **v1.4 附记 ⑤（2026-09-23，R8 完整评审 + 探索性测试 —— 健壮性与易用性，非引擎优化）**：
  - **定位**：**评审 / 加固批次**（不是新功能，也**不动引擎算法**）。改动集中在 `ui/ai.js`、`ui/main.js`、
    `ui/panels.js`、`ui/menu.js`、`ui/record.js`、`ui/booklib.js`、`engine/worker-entry.js`、
    `engine/record.js`、`engine/core.js` 与 `tools/`。**13 条优化条约（A1–A13）的终局不受影响**；
    §7.5 的基线（`A13-complete-batch4`）续用。
  - **做法**：① **完整评审**（两份设计文档 ↔ 代码逐条对账：协议字段 / 错误码 / 开关语义 / 状态机出口）；
    ② **探索性测试**（撞未被断言覆盖处：并发、崩溃超时、非法输入、读谱×对局交叉操作）；
    ③ **修复 + 补守卫**（每条修复必须配一个"能红"的守卫，否则视为未修）。
  - **★ 两处 P0**：
    ① **Worker「崩溃 / 不回应」没有出口** —— 握手期 `onerror` 里 `if (done) return` 使握手后该 handler
       **被永久挡掉**，而 `pending` 只有"收到响应 / 被顶替"两个出口 ⇒ 崩溃或丢消息时 promise **永不 settle**、
       界面**永久"思考中"且零报错**（与 R7「悬挂 promise」同族）。修法：**看门狗**（`G.AI_TIMEOUT_MS`，
       默认 45s ⇒ `E_TIMEOUT` + 降级）＋ **运行期 `onerror`**（`E_WORKER` + 降级）＋ `dispose()` 如实降级。
       自查中又抓到同族竞态：降级与"这一手结束"是**两个放行源**、都会调 `flushAux()` ⇒ 排队中的两个辅助请求
       会**并发在飞**、后者作废前者 id ⇒ 前者 `E_ABORTED` 静默失败。修法：`auxRunning` 串行守卫；
       **实验证明**（新增 `tools/_auxguard-probe.js`）：无守卫 `hint=REJECTED(E_ABORTED)`，有守卫 `hint=OK`。
    ② **同一元素被两个模块各绑一次 click** —— `btnHeat` 被 `ui/panels.js` 与 `ui/main.js` 各绑一次
       ⇒ 一次点击触发两次 toggle ⇒ 「热力图」**怎么点都打不开**，还把 prefs 写成 false；
       断言"状态 / aria / 高亮三者一致"在**一致地关着**时同样成立 ⇒ 长期全绿绕过。
       修法：panels 只暴露 API、唯一入口归 main；固化为静态守卫 **`ui-features.test.js` R8-1**
       （同一 id 的 click 绑定必须**恰好 1 处**；已用"人为注入重复绑定"验证守卫会红）。
  - **其余 6 类**：③ 快捷 <kbd>H</kbd>/<kbd>J</kbd> 与长期开关语义不一致（按完不再随落子刷新）；
    ④ 读谱/对局互踩（`undo()` 半读谱态 / 「从此续弈」在本地双人下把悔棋·重开**永久锁死** / 菜单恢复分组
    不广播 `onToggle`）；⑤ 协议与错误模型（棋盘**不校验取值** ⇒ 字符串/array-like 会静默变成**空盘**而空盘是
    合法前提 ⇒ **静默给错答案**；`analyze` 缺 moves 错误码误导 / `topN` 无下界 / 越界静默 break 无回报；
    `postMessage` 无兜底 ⇒ `DataCloneError` 让 Worker 静默死掉）；⑥ 棋谱导入/复盘正确性（跳过非法手**不翻手番**
    ⇒ 整盘反色；`stopOnRule` **永不生效**；Renju 用时对齐错位；`viewAt` 越界写坏盘面）；
    ⑦ 文档 ↔ 代码矛盾（`pos.assertIncr=false` 号称可关、实际**传 false 就崩**）；⑧ 易用性零碎（空盘棋谱面板
    一片空白 / 非法手无标注 / 档位文案写死）。
  - **★ 新增发现（视觉确认时抓到的第 9 条）**：**长期开关「提示」的自动刷新会被吞掉且永不补** ——
    `main.syncObservers()` **先写 `obsKey` 再调 `panel.askHint()`**，而 `askHint()` 在 `busy` 时**静默返回 null**
    ⇒ 这次局面变化的刷新被吞；而 `askJudge()` 没有 busy 守卫 ⇒ 症状是**"形势有值、提示空着"**。
    这正是 R7 那条「让路且**不占键**」铁律的漏网分支。**探针**（新增 `tools/_probe-hintbusy.js`）：
    连落 5 手后静置，修复前摘要**一直为空**，修复后为「第 5 手 · 5 个候选」。修法：面板忙时**同样不占键**
    + 150ms 重试（与 `thinking`/`aiWillAct` 同源）。
  - **★ 方法论收获（值得单独记）**：**"看得见"与"断言得过"是两件事** —— 本轮的 busy-key 缺陷是
    **截图时发现**的（断言全绿、DOM 属性全对，只是列表空着没人看）。这已是 R7「`hidden` 挡不住作者样式」
    之后第二次由**肉眼**抓到的真问题 ⇒ **改 UI 必须看截图**（本轮新增 `tools/_shot-r8.js`）。
  - **★ 验证工具可靠性（本轮副产物）**：单文件 `browser-menu-check` 出现 **1 次不可复现的 FAIL**。
    根因**不是产品缺陷而是断言自身的时序依赖**：该断言把 `bookHit` 与落子**分两次 `eval` 读取**，
    而第 3 手（黑）落完后轮到 AI、应手异步落地在两次调用之间 ⇒ 局面变 4 手 ⇒ 本库"精确前缀匹配"`rel=0`。
    修法：**合并到同一个 `eval`**（同一任务内 AI 无法插入）+ 把该文件**唯一残留的固定等待**（`sleep(2600)`）
    改成有预算轮询；复跑 4 次稳定 `rel=8`。
    ⇒ **再次印证**：固定时序依赖 = 假失败主因，**比真失败更危险**。
  - **新增回归守卫（+9 项，全量 273 → 282）**：`ai.test.js` **+3**（看门狗超时降级 / 运行错误自愈 /
    降级路径排队请求不得互相顶替）；`worker.test.js` **+2**（非法棋盘显式拒绝 + analyze 边界与如实回报）；
    `record.test.js` **+3**（非法手后手番 / `stopOnRule=false` / 越界不写坏盘面）；
    `ui-features.test.js` **+1**（R8-1 重复绑定守卫）；**浏览器 ux-check +1**（连落多手后提示必须跟上当前手数，
    已双向验证：移除修复即红）。
  - **产物与上限**：新增校验/兜底代码一度把 worker 产物顶到 **208.4 KB**（超上限 208）。
    处理：**精简与 §28 重复的协议表注释 + 删死字段**回到 **207.5 KB**（hash `4d7b369c0a720356`），
    **不动上限**（重标上限只在"净增真实代码"时才有理由，沿用 §4.12 口径）。
  - **验收**：全量 **282 项全绿**（23 文件，逐文件跑）；浏览器 **257 项全绿**
    （开发壳 3 + 20 + 45 + **22** + 46 = 136；单文件 45 + **22** + 8 + 46 = 121）；
    worker **`4d7b369c0a720356`**（207.5 KB / 上限 208）；单文件 `gomoku.html` **802.8 KB / 23 内联脚本**。


- **v1.4 附记 ⑨（2026-09-24，R11 —— 提示/形势/热力准确性修复，用户实测三症状）**：
  - **①终局假必胜/反向胜负**：hint/judge 不检查"盘上已有五连" ⇒ 白已五连后 hint 仍标
    "必胜·VCF"、judge 可能给"黑已胜 100%"。修复：`coach.fiveOnBoard`（复用 rules.isWin，
    含 Renju 恰五/长连之别）+ hint 空列表 + judge `source:'over'` + UI askJudge 遇 over 直接显示终局。
  - **②"0% 与必胜并存"**：败着（搜索分 ≈ −WIN）混进提示（norm≈0%）+ **候选级探测跳过对方回合**
    搜杀 = 系统性假必胜。修复：败着不上榜（`s > −WIN/2`）；候选级探测删除（搜索分已覆盖）；
    必胜只留三处 sound 源（立即成五/搜索证明/根 solveOne）。
  - **③推荐度分层**：必胜 100..80 按杀距、普通 0..78 比值归一；norm 加 title「推荐度（非胜率）」。
  - **④单成五点降级**：−WIN/2（≈0% 误伤大优局）→ urgent −2400（≈27%），UI 标注「对方有成五点」。
  - **⑤热力图**：验证（堵点=最高热 ✓ 必败局全 0 ✓）+ 修复（禁手点补上图 v=0）。
  - **验收**：全量 **309 项**（coach +4）；浏览器 **363 项**（explore +5 终局准确性断言）；
    worker `472e66a231f50c9e`（207.9 KB）。探针 7 场景（终局/双四/单四/杀局/热力/urgent/跳四）全符合。
- **v1.4 附记 ⑧（2026-09-24，R10 —— 对局中推演 / 开局库平移识别 / 杀法最短优先，非引擎优化）**：
  - **① 棋谱面板（对局中）「推演」**：`fromGame` 快照当前对局 → 读谱推演（与读谱模式行为一致）；
    进入前 `cancelAI`（防"以推演续弈"回退 AI 在飞的一手）、`load()` 复位 `startedFromGame`
    （否则库内棋谱误标"推演中"——实测踩过）、退出读谱若轮到 AI 补 `maybeAI`。触屏零新代码
    （`commitAt` 单一入口本就路由 `readMode → pushExtra`）。
  - **② 开局库匹配模式识别**：`booklib.transNorm`（黑1 对齐天元）+ `probeTree(hist, shift)` 平移下探 +
    候选回映真实盘面（越界/已占过滤）+ 如实标注「平移识别」。旋转/镜像由 canonSeq 的 8 对称
    天然覆盖（927/927 局实测旋转不变）——用户感知的"旋转认不出"实为无禁手黑1 偏移，平移补齐即解。
    引擎决策树不动（纯 UI 匹配层）。
  - **③ 杀法提示最短优先**（根因 = 威胁标注不参与排序 + normal 档 vcfDepth=0 不标注）：`coach.hint`
    ① 根局面先求一次最短杀（迭代加深）标注首选点 ② 候选级探测杀距**含候选这手本身**
    （path 是落子后的后续链，少算一手 ⇒ 慢杀排到快杀前——实测踩过）③ 多来源（立即胜/搜索证明/威胁链）
    **取最快杀**；标签显示来源与步数（必胜·2）。实测：2 手杀（I6/I7）从子力分 2222 顶到最前。
  - **新增守卫**：coach +2（杀法标注/按杀距排序——⚠ 断言只钉排序不变量，不钉来源：TT 跨调用
    使同一候选的来源在 vcf/search 间变化）；ui-features +3（**R10-1/2/3** transNorm / 旋转 927 局 /
    probeTree 平移回映——⚠ 直接 require 真实 booklib（stub window），弃"同算法 Node 重跑"；
    ⚠ 树分支会被 BOOK_SHRINK 剪枝，寒星局前缀只通到第 6 手）。
  - **验收**：全量 **305 项全绿**（24 文件）；浏览器 **349 项**（开发壳 182 = 3+20+45+22+50+42，
    单文件 167 = 45+22+50+8+42）；worker **`5729938769c7d878`**（207.8 KB / 上限 208）；
    单文件 `gomoku.html` **838.8 KB / 24 内联脚本**；触屏 42×2 全绿。

- **v1.4 附记 ④（2026-09-22，探索性测试 R7 —— 页面功能逻辑 + 易用性审计，非引擎优化）**：
  - **定位**：**测试/审计批次**（不是新功能）。引擎侧只改了一处**真缺陷**（`engine/worker-entry.js` 的
    `doAnalyze`），其余全在 `ui/` 与 `tools/`。**13 条优化条约不受影响**。
  - **方法**：新增 **`tools/browser-explore.js`** —— **探索 ≠ 回归**：回归断言"已知正确"的行为，
    探索主动去撞**没被断言覆盖**的地方（含**静态审计**段：HTML 控件 ↔ 代码引用交叉核对）。
  - **★ 关键事实：12 处真问题里 10 处在"268 项全绿"时就已存在** —— 断言覆盖不到
    "功能静默失效 / 两处状态脱钩 / 每手算错局面"这类问题。
  - **修的 7 类问题**：
    ① **死引用**：`#lastMoveBox` 根本不存在 ⇒ 悬停显示"第 k 手·用时"整块功能**静默失效**（5 个调用点全落空）；
    ② **AI 请求调度**：单通道 latest-wins 下，**AI 思考期间点「热力」/按 H** ⇒ `move` 被顶掉 ⇒ **AI 永不出招**；
       且被顶掉的 promise 无人收尾 ⇒ 面板 `busy` 永久为真 ⇒ 之后**所有提示静默失效**；
    ③ **三个长期开关同开只剩一个有效**（同 tick 连发互相顶掉）⇒ 改**串行链**；AI 回合**让路且不占幂等键**；
    ④ **读谱中「悔棋」**悄悄改动背后对局（实测 ply 4→2 且退出读谱）⇒ 读谱中锁定这两个按钮；
    ⑤ **读谱信息缺棋手/结果**（数据在库里却只传了着法文本）；总用时无数据时显示"0ms"⇒ 透传 meta + 改文案；
    ⑥ **读谱中 Esc 失效**（被 `!kbActive` 吞掉，与帮助文本承诺不符）；
    ⑦ **逐手分析（缺陷 #36）**：`doAnalyze` 每手都拿**初始盘面**算 ⇒ 180 手全部报"引擎首选 H8"。
       **为什么长期没发现**：该缺陷让每手都在空盘上搜 ⇒ **假快**（2.5s 跑完）。修正后暴露真成本：
       `hard+威胁` **3220ms/手**（整局 ≈10 分钟）｜`normal+d3` 141s｜`normal+d2` 40s｜**单手时限不收紧总时长**
       ⇒ 改 **逐手推进棋盘 + 分片 12 手 + 流式渲染 + 总预算 20s**（到点注明"已分析前 N/M 手"）。
  - **新增回归守卫**：`ui-features` **R6-6**（死引用）/ `worker.test.js` **+2**（analyze 逐手局面 + 非法手）/
    `ai.test.js` **+2**（move 不被顶掉 + 被顶替必 reject）。
  - **验收**：全量 **273 项全绿**（23 文件）；浏览器 **255 项**（开发壳 135 + 单文件 120，含 explore 46×2）；
    worker **`2c418565eed04568`**（207.1 KB / 上限 208）；单文件 `gomoku.html` **793.5 KB / 23 内联脚本**。

- **v1.4 附记 ③（2026-09-22，UI 增强 R6 —— 提示难度 / 完整棋谱库 + 开局库关联 / 长期开关 / 读谱模式，非引擎优化）**：
  - **定位**：仍是**纯 UI 层 + 数据层**，**不动任何引擎搜索/评估语义**（13 条优化条约不受影响）。
    引擎侧唯一的改动是 `engine/book.js` 的注释（并顺手把误触"裸 `ui/`"的写法改掉），核心代码零变更。
  - **① 提示难度独立可设**：`selHintLevel` 与对局难度解耦；时间预算用提示难度自身默认值（不被对局"时限"夹住）。
  - **② 棋谱库换成完整棋谱**：**新增 `tools/gen-book-games.js` / `engine/data/book-games.js`**
    —— RIF、≥25 手、每开局≤40 局、按源序（无偏）⇒ **927 局 / 26 开局 / 44 418 手（平均 47.9 手）**，含棋手与结果。
    - **旧 `book-lines.js` 保留不动**：它（前 10 手片段 + 频次）是引擎 `openingMove` 的**回落路径**，
      改它会改变引擎行为 ⇒ 新库是**增补**而非替换。
    - **★ 引擎刻意不开 `bookGames()` 访问器**：完整棋谱库是纯 UI 关注点，放引擎里会让 worker 产物
      白涨 ~0.6 KB，而**上限只剩不到 1 KB 余量** ⇒ 改由主线程直接读 `G.bookGames`（实测产物仍 206.9 KB）。
  - **③ 开局库 → 具体棋谱关联**：`ui/booklib.relatedGames()` 用 **`canonSeq` 的前缀性质**做精确前缀匹配
    （§12.4.3 已证 `m(S++x) = m(S) ++ min_{t∈T(S)} t(x)`）⇒ 亚毫秒。**★ 两个口径分开标注**：
    `样本 N 局`（前缀树，全量 11 522 局口径）vs `本库可读 K 局`（棋谱库 927 局口径）—— **不可合并成一个数**。
  - **④ 棋谱区与棋谱库整合 + 隐藏导入导出**：分组 7 → **6**（棋谱库并入棋谱）；
    导入/导出收进 `<div hidden id="recLegacy">`（**隐藏而非删除**，保住既有取值路径与 id 契约）。
  - **⑤ 三个长期开关**：提示/形势/热力打开后**每手自动刷新**，`aria-pressed` + 落盘 + 刷新保持。
    - **★ 两条硬约束**：① **幂等键**（局面身份）防重复请求；② **`thinking` 期间一律让路** ——
      `ai.js` 单通道 latest-wins，此时发 hint/judge 会把 AI 的 `move` **顶掉** ⇒ **AI 永不出招**。
  - **⑥ 棋谱菜单与读谱模式分离**：打开面板**不打断下棋**（对局中即显示开局库匹配 + 本库对应棋谱）；
    **点具体棋谱**才进读谱；读谱中可**推演**（人工续下，不改棋谱，换手即弃）；
    **「恢复下棋」**退出（推演丢弃）/ **「以推演续弈」**采纳为真实对局。
  - **⑦ ★ 修掉一个"断言全绿但肉眼可见"的显示缺陷（截图才发现，且自 v3.33 就存在）**：
    `.rec-bar { display:flex }`（作者样式）压过 UA 的 `[hidden]{display:none}` ⇒ 元素带 `hidden` 属性
    **照样显示**（非读谱态下控制条一直挂着）；而断言只查了 `el.hidden`（property=true）⇒ 全绿。
    修法：样式表顶部加 `[hidden] { display:none !important; }`，并把校验改成量**矩形 + computed display**。
  - **★ 通用教训（写入长期记忆）**：
    1. **`hidden` 挡不住作者样式**；**断言要量可见性，别只量 property**。
    2. **"长期开关"必须避开单通道竞态**（否则会把别的在飞请求顶掉——差点让 AI 不出招）。
    3. **纯 UI 关注点不要塞进引擎**（白占产物配额）。
    4. **两个口径的数不能混**（全量 vs 可读子集）。
  - **验收**：**新增 `tools/browser-ux-check.js`（PASS 21/0，双产物各跑一遍）**；
    `browser-menu-check.js` 34→**45**；`ui-features.test.js` 21→**26**；`browser-feat-check.js` 更新为 927。
    **全量 268 项测试全绿**（23 文件）；浏览器共 **163 项**全绿；单文件 `gomoku.html` **777.4 KB / 23 内联脚本**；
    worker **`205d37799ce5ea18`（206.9 KB / 上限 208）**。
- **待办**：~~§5.5.9 的 S0–S3 测试/信号基础设施~~ **✅ 全部就绪**；
  ~~第 0 批六个只读探针~~ **✅ 全部完成**（P-A~P-F）。
  ~~**M10 打磨发布** + **M9 收尾**~~ **✅ 已完成**（v3.32）；
  ~~**UI 增强 R1–R4**~~ **✅ 已完成**（v3.33）；~~**UI 增强 R5（菜单分类归置）**~~ **✅ 已完成**（v3.34）；
  ~~**UI 增强 R6（提示难度/完整棋谱库/长期开关/读谱模式）**~~ **✅ 已完成**（v3.35）。
  **当前无遗留必做项**。
