# 本机真实操作帧耗时基线

测量日期：2026-11-14。本轮只修改工程测量工具，没有调整运行源码、物理、画质或操作节奏。原始数据、分位数和报告哈希见[汇总](../../reports/measurement/frame-time-baseline-summary.json)。

## 条件与覆盖

Intel Core Ultra 7 258V / Intel Arc 140V，Windows、ANGLE/D3D11、硬件 WebGL。Chrome 157.0.8103.51、Edge 157.0.4341.46；1440×900、DPR 2，游戏既有上限使绘制缓冲为2160×1350。使用无头浏览器的真实键鼠路径，不替换时钟、RAF、输入或 WebGL；不是物理显示器输入延迟测试。

- 操作：两浏览器、四套场馆，各一遍走位、转向、蹲起、瞄准、预测、加塞及真实击球。逐帧记录间隔、CPU渲染提交时间和长任务。
- CPU：Chrome 003另做三遍带CDP采样的完整操作，单独保存profile，不混入无profile基线。
- GPU：两浏览器、四场馆各三轮，预热1.5秒后采6秒真实D键移动，仅当前配置，单独使用异步GPU计时。
- 加载：开发构建、两浏览器各三个新上下文，记录菜单和Practice就绪及资源时间线。新上下文不代表磁盘和OS缓存已清空。
- 切换：开发构建、两浏览器各三轮，从原始场馆首次进入001/002/003，再返回及重复切换。真实点选，分别记录场景准备和菜单可操作。
- 联网：真实RoomClient与WebSocket服务，三种力度各五次新比赛，分别记录同步结算、事件循环定时器延后与完整回包时间。同进程回环，不是公网或并发容量测试。

性能任务顺序执行。没有锁定整机电源、温度或排除所有后台进程，结果应作为当前机器的基线，不能作为跨设备承诺。

## 持续渲染与短时卡顿

下表汇总三轮稳定移动阶段的GPU样本。分位数采用nearest rank；CPU提交不等于纯JS时间，也不能与GPU时间直接相加。

| 场馆 | Chrome GPU中位/P95 ms | Edge GPU中位/P95 ms | 绘制调用/帧 |
| ---- | --------------------- | ------------------- | ----------- |
| 原始 | 3.55 / 5.68           | 3.49 / 5.10         | 35          |
| 001  | 6.50 / 9.63           | 6.53 / 9.53         | 52          |
| 002  | 7.14 / 10.34          | 6.79 / 7.96         | 54          |
| 003  | 5.96 / 9.31           | 5.53 / 6.60         | 57          |

各组帧间隔中位数约16.7ms，P95约17.8–18.2ms，CPU提交P95约1.8–4.1ms。在本次60Hz条件下，没有持续GPU超出16.7ms预算的证据；不能据此保证120Hz或所有操作都流畅。此时直接减少灯光、阴影或分辨率缺乏依据。

无profile的实际操作仍捕获到51–103ms长任务：例如Chrome原始场馆击球61ms、003瞄准89ms；Edge001走位71ms、003反向走位103ms及击球84ms。这说明平均帧率会掩盖短时停顿，但一次操作采样不能估计稳定出现概率。

Chrome003三轮profile复测没有重现原来的89ms长任务。累计self-time靠前的是引擎getUniform、render、bindForSubMesh、setTexture和活动网格遍历，不足以把某个累计热点认定为该次卡顿的原因。profile采样、GC或驱动调度等因素仍需时间对齐的trace进一步区分。蹲起等按需渲染阶段还出现116–134ms无长任务间隔，不能直接算成动画丢帧。

## 等待链比持续GPU更值得优先处理

| 开发构建指标         | Chrome中位 | Edge中位 |
| -------------------- | ---------- | -------- |
| 导航到菜单就绪       | 4.07s      | 4.59s    |
| 点击Practice到可操作 | 1.81s      | 1.78s    |
| 首次场馆：场景准备   | 634ms      | 714ms    |
| 首次场馆：菜单可操作 | 1068ms     | 1163ms   |
| 缓存场馆：场景准备   | 32ms       | 25ms     |
| 缓存场馆：菜单可操作 | 476ms      | 467ms    |

切换细分复测中的首次准备受OS缓存、着色器及纹理就绪等条件影响，不是完全冷启动结论。缓存切换期间仅见favicon请求，没有重新下载房间装饰资源。场景准备完成后，输入就绪仍有约435–447ms等待，这在首次和缓存切换中都出现，是可重复的UI交接成本。

相关代码：[场馆切换交接](../../src/application/controllers/interior-menu-controller.js)、[抽屉关闭及CLOSE事件](../../src/presentation/ui/interior-dialog.js)、[首页菜单进入动画](../../src/application/controllers/menu-controller.js)。等待包含关闭抽屉、菜单恢复及输入门控，不能把整个差值直接等同于某个单一tween时长。

默认加载每轮57个请求、约7.56MB响应体。菜单前发起的资源在约0.74–2.11s完成，菜单就绪仍晚约3.0–3.1s。结合菜单进入动画与就绪条件，下一步应拆解“下载完成→场景就绪→动画结束→允许输入”，不能把4秒开局都归因于下载。Resource Timing本身不能区分纹理解码、GPU上传和所有主线程工作。

## 联网同步结算

同一初始球位、方向，仅改变力度。每组五次，表中最大值不是可靠的高分位容量指标。

| 力度 | 同步结算中位/最大 ms | 定时器延后中位 ms | 回环命令RTT中位 ms |
| ---- | -------------------- | ----------------- | ------------------ |
| 0.10 | 5.37 / 8.00          | 6.70              | 7.36               |
| 0.25 | 11.79 / 15.66        | 13.67             | 14.20              |
| 0.65 | 35.36 / 41.74        | 37.66             | 38.29              |

测量封装未改写的[shoot同步结算](../../src/server/matches/match-session.mjs)，覆盖模拟、轨迹记录、裁判及快照生成。较大力度会阻塞当前服务事件循环数十毫秒，回包约100KB。它可以延后同进程其他房间的处理；浏览器和正式服务属于不同进程，不能据此声称浏览器主线程也冻结了相同时间。优先补两房交错击球/探针，再决定Worker或有界调度，不根据单房数据推导容量。

## 后续优化顺序

1. 优先压缩可重复的场馆切换UI交接等待，验证输入不穿透、焦点和失败恢复仍正确。
2. 分阶段刻画首页与Practice进入流程，区分主动动画、资源解码/上传及真正的忙碌时间。
3. 对用户可重复的走位/瞄准卡顿采集时间对齐的trace；现有profile不支持直接改写某个物理或引擎函数。
4. 测量联网结算对另一房间的实际影响，再决定隔离方案。

## 复测命令

```powershell
node tests/e2e/gameplay-motion.test.mjs
node tests/e2e/gameplay-motion.test.mjs --browser chrome --design interior-design-003 --runs 3 --label runtime-cpu-probe --profile true
node scripts/measure-interior-performance.mjs --label runtime-baseline-chrome --runs 3 --seconds 6 --browser chrome --dpr 2 --mode current
node scripts/measure-interior-performance.mjs --label runtime-baseline-edge --runs 3 --seconds 6 --browser edge --dpr 2 --mode current
node scripts/measure-loading.mjs --label runtime-baseline --runs 3
node scripts/measure-loading.mjs --label runtime-baseline --runs 3 --mode switching
node scripts/measure-room-settlement.mjs --label runtime-baseline
```

每次复测使用新label保留对照。未提供选项时原操作专项仍测两浏览器四场馆；GPU工具未指定mode时仍运行原有阴影对照与消融，不能与本页current基线混用。汇总记录原始报告及CPU profile哈希；逐帧数组和profile属于本地产物。

GPU首次探测曾因基本操作说明未关闭而样本不足，已修正测量前的真实关闭操作并保留失败日志；没有放宽有效帧数断言。以上结论均来自随后通过的测量。
