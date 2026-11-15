# 场馆切换、入场与焦点优化

2026-11-14。本轮基于[帧耗时基线](frame-time-baseline.md)修改等待链，并采集操作时间对齐trace。数据及输入哈希见[优化汇总](../../reports/measurement/entry-optimization-summary.json)和[trace分析](../../reports/measurement/entry-trace-analysis-summary.json)。

## 行为修改

- 从抽屉返回菜单使用160ms整体恢复，不重播原432ms逐项入场。首次菜单的逐项效果保留；退出动效与抽屉轨迹保留。
- 首页相机入场包含延迟的有效时长最多600ms，本地Practice/AI/同机相机入场最多450ms。通过既有tween的timeScale限时，不改写相机轨迹、目标、物理、计分或游戏时钟。远端比赛仍使用原有快照进入流程。
- 减少动画偏好使用16ms预算。每次进入重新计算速度，不继承上一轮的缩放比例。
- 场景未准备好时仍等待真实资源就绪；抽屉关闭前菜单保持inert，焦点与输入由CLOSE及现有模态栈交还，不提前穿透。

维护入口：[入场预算](../../src/presentation/animation/entry-motion.js)、[菜单动效](../../src/presentation/ui/interior-side-menu.js)、[场馆交接](../../src/application/controllers/interior-menu-controller.js)、[本地比赛进入](../../src/application/controllers/game-ui-controller.js)。

## 修复的焦点竞态

提速后的同机专项复现了延迟默认聚焦抢输入：第二姓名框已经获得焦点，下一帧的自动聚焦又移回第一框，后续文本落进错误字段。原生事件记录显示输入从预期的“Alice / alice”变成“Alice alice / Dan”，因此绕过的不是校验逻辑，而是实际表单内容已经不同。

修复在[多人面板](../../src/presentation/ui/more-things-dialog.js)：延迟默认聚焦发现用户已选择面板内控件时不再转移焦点，仍在模态阻挡解除后处理。覆盖同机、房间设置和房间等待三个面板。没有延长睡眠、跳过重名断言或改写姓名规则。

[修复前事件证据](../../artifacts/testing/hotseat-lifecycle/entry-focus-before.json)保留；修复后24个同机场景均验证重名被拒，源码生命周期场景也记录实际输入事件。定向单元测试覆盖已有焦点、默认焦点和阻挡期。

## 独立耗时复测

与基线同机、同浏览器版本、1440×900、DPR2及既有DPR上限。开发构建加载每浏览器三轮；缓存切换每浏览器15次观测。性能任务独立顺序运行，未与功能测试争抢资源。

| 中位数指标             | Chrome：之前 → 之后 | Edge：之前 → 之后 |
| ---------------------- | ------------------- | ----------------- |
| 菜单就绪               | 4068 → 1852ms       | 4585 → 1970ms     |
| 点击Practice到可操作   | 1806 → 983ms        | 1784 → 984ms      |
| 缓存场馆点击到可操作   | 476 → 281ms         | 467 → 282ms       |
| 场景完成后等待输入交接 | 447 → 258ms         | 441 → 257ms       |

缓存切换总等待减少约40–41%，Practice入场约45%，菜单就绪约54–57%。这是本机少量样本的对比，不是跨设备保证。OS缓存与温度未锁定；最稳固的依据是缓存切换的交接段缩短，以及实际tween有效时长记录。复测仍要求菜单非inert、无模态阻挡且动画稳定，不把视觉出现视为输入可用。

源码两浏览器四场馆无trace操作也通过。所有场景记录到首页相机预算600ms、本地比赛450ms。没有把这些等待改善解释成游戏内帧率普遍提高。

## 时间对齐trace结果

Chrome/Edge各三轮003场馆，从导航开始记录。原生User Timing标记覆盖文档、菜单就绪、Practice点击/就绪、首次移动预热、11个操作阶段及关键输入；同时记录主线程、资源、V8/GC、合成及GPU调度事件。trace有诊断开销，不用于计算上表提速比例。

采用渲染器主线程的规范ThreadControllerImpl::RunTask事件，排除嵌套调度与Edge包装事件的重复计数。GC及布局时长采用任务内区间并集，不累加嵌套事件。

### 操作阶段

六轮trace未稳定复现之前51–103ms的操作期主线程长任务；八个无trace场景也未捕获50ms以上longtask，但Edge仍出现约47–48ms单帧间隔，不能宣称全部卡顿已消除。

蹲起的100–133ms渲染间隔可以稳定复现，但与输入对齐后，14个无trace/trace场景都显示：前一帧相机已在蹲稳高度，期间保持静止，松开X后约1–14ms出现起身帧。该间隔是按需渲染的静止保持段，不应通过强制重绘或替换RAF去“修复”。

### 启动阶段的可重复同步长任务

六轮均记录到模型请求readyState=4后的回调任务，资源为`interior-design-original-room.babylon`，规范主线程任务约1.09–1.96秒，任务内GC区间约104–155ms。该回调还会串联后续初始化，不能把整段计为JSON.parse或网络下载。

首次冷一些的样本中还出现GetProgramiv/WaitForCmd同步GPU命令等待，单段约75–149ms；后续轮次较轻。这属于启动时的CPU/驱动同步，不等于持续绘制GPU超预算。

下一处明确的细化入口是[GameView的SceneLoader.Load完成及构建链](../../src/presentation/rendering/game-view.js)：继续分别刻画模型解析、对象/材质创建、HDR环境处理和着色器就绪查询，再决定是否分批或预热。本轮未改第三方引擎、模型资产或就绪判定。

## 验证与复测

整体浏览器检查和205项单元/集成通过；室内六套、三抽屉轨迹/焦点/窄屏/减少动画、24个同机组合、两个源码生命周期及src独立启动均通过。原始像素对照及场景对象身份继续成立。

```powershell
node scripts/measure-loading.mjs --label entry-after --runs 3
node scripts/measure-loading.mjs --label entry-after --runs 3 --mode switching
node tests/e2e/gameplay-motion.test.mjs --label entry-after
node tests/e2e/gameplay-motion.test.mjs --browser chrome --design interior-design-003 --runs 3 --label entry-trace-chrome --trace true
node tests/e2e/gameplay-motion.test.mjs --browser edge --design interior-design-003 --runs 3 --label entry-trace-edge --trace true
```

后续复测使用新label，保留已有基线。`--trace true`为测试侧注入，不进入交付文件；默认关闭。六份原始trace已无损压缩为`.trace.json.gz`，解压后的哈希与原始JSON核对一致；归档约129MB，未压缩约1.23GB。原始trace保存在artifacts/testing，汇总保留归档及解压内容的SHA-256，既有基线未覆盖。
