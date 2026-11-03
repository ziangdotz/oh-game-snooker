# 无界面物理与比赛快照

2026-10-19 在 Node 中建立无界面验证夹具，覆盖真实球台物理、同机双人模型、标准裁判和可恢复的比赛快照。房间服务、WebSocket 和断线重连见[房间协议与房间服务](room-service.md)；房间服务现在复用同一套 `src/server/matches/` 无界面模型执行受控击球。

## 运行

```powershell
node scripts/verify-headless-match.mjs
```

命令默认要求独立冷启动浏览器参考 [chrome-physics-cold.json](../../artifacts/testing/regression/chrome-physics-cold.json)；文件缺失时直接失败并提示采集命令，不会静默降级。必要时可用 `--allow-legacy` 运行非严格的旧基准诊断，此时报告 `reference.coldStart=false` 且 `strictPassed=false`。在 Node 中重新构建球台与 22 球，执行五个固定击球脚本，并运行三杆受控比赛。输出：

- [物理与比赛验证记录](../../reports/validation/headless-match.json)
- [完整比赛快照](../../reports/validation/headless-match-snapshot.json)

报告记录参考文件的 SHA-256、`coldStart`、容差和严格判定。冷启动文件位于本地 `artifacts/testing/`，不随 Git 提交；干净工作树需要先在宿主机采集。`--allow-legacy` 的结果不能表述为逐位严格对照。

集成回归：

```powershell
node tests/integration/headless-match.test.mjs
node tests/integration/headless-match-model.test.mjs
```

## 独立冷启动采集

旧参考 [chrome-physics.json](../../artifacts/testing/regression/chrome-physics.json) 在一个浏览器世界中顺序执行五个脚本，前面的脚本会留下求解器状态。宿主机补跑使用 `scripts/capture-browser-physics.mjs`：每个夹具新建浏览器页面，并在页面内新建 `WorldClient`，从同一碰撞网格和初始布局重新生成 22 球，再采集 480 步中的 25 帧。

```powershell
# 终端 A
node src/start.mjs --port 5180

# 终端 B：先启动 Chrome 的 CDP 端点
chrome --headless=new --remote-debugging-port=9778 --user-data-dir=.cache/chrome-cdp about:blank

# 终端 C：每个夹具独立冷启动采集
node scripts/capture-browser-physics.mjs --cdp http://127.0.0.1:9778 --origin http://127.0.0.1:5180
```

采集确认了旧 `follow` 差异的根因：游戏开局时 AI/瞄准流程会给球杆留下 `rfPower≈0.2357`，而 `rfPower`、`rfDir` 不在世界序列化字段内。旧夹具只执行 `deserialize`，因此会把这个非序列化残留带入后续脚本；独立世界消除了该差异。Node 夹具现在也显式复位 `rfPower`/`rfDir`，把夹具准备状态固定下来。

## 物理结果

五个夹具全部逐位一致，容差为 0：

| 夹具              | 结果     | 位置/速度最大差 | 自旋/姿态最大差 | 接触与入袋          |
| ----------------- | -------- | --------------- | --------------- | ------------------- |
| break-center      | 精确一致 | 0               | 0               | 球 1、库 3、入袋 0  |
| cushion-side-spin | 精确一致 | 0               | 0               | 球 1、库 1、入袋 0  |
| draw              | 精确一致 | 0               | 0               | 球 19、库 0、入袋 0 |
| follow            | 精确一致 | 0               | 0               | 球 22、库 2、入袋 0 |
| middle-pocket     | 精确一致 | 0               | 0               | 球 0、库 2、入袋 1  |

两个独立实例各拥有不同的模块类、`ContactSolver` 和预测求解器；交错执行 `break-center` 与 `draw` 时，两条轨迹分别与各自单实例运行逐帧相同。

## 裁判与完整快照

[headless-match-model.mjs](../../src/server/matches/headless-match-model.mjs) 使用运行时的 `HotseatGameModel`、标准 `std-sno` 裁判和 `Simulator`，不是另写一套计分规则；[tooling 适配器](../../tooling/validation/headless-match-model.mjs) 只转出同一实现并保留受控回合脚本。受控序列为红球、黑球、红球：

| 杆       | 得分 | 犯规 | 上下文 ballOn | 当前球员 |
| -------- | ---- | ---- | ------------- | -------- |
| 红球入袋 | 1    | 0    | 252（彩球）   | 0        |
| 黑球入袋 | 7    | 0    | 2（红球）     | 0        |
| 红球入袋 | 1    | 0    | 252（彩球）   | 0        |

三杆后球员 0 为 9 分、球员 1 为 0 分，20 颗球仍在台面。快照包含：

- `match`：模型状态、回合上下文、双方球员统计、裁判标识和场景；
- `physics`：完整球体序列化数据、演化号、步长和累加器；
- `mesh`：碰撞场景、面数与分组；
- `simulator`：模拟器状态和最近一次击球结果；
- `balls`：22 球的可见性、位置、速度、自旋、姿态和置球点。

快照经过 JSON 往返后恢复到新的模型/模拟器，恢复快照逐字节一致；恢复后再打一杆黑球，得分和完整快照也与未恢复实例一致。故意写入错误 `mbid` 会被拒绝。

## 边界

- 只覆盖原始 `tigerClubSno` 球台；四套室内的碰撞体和相机尚未参与此项对照。
- 快照恢复目前是验证夹具级别的直接状态恢复，不是运行时公开的存档 API；比赛暂停/恢复、断线重连仍需在房间协议层重新设计。
- 裁判验证使用受控的 `firstKissIndex` 和入袋结果，不宣称覆盖完整真实比赛、全部犯规分支或随机 AI 分支。
- 下一步进入房间协议与本地房间服务：玩家身份、开局/轮次消息、重连令牌和权威快照推送。实施方案见[房间与双人对战方案](../development/rooms-and-two-player-plan.md)。
