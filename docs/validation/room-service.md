# 房间协议与验证

更新于 2026-10-21。运行实现位于 `src/server`、`src/infrastructure/net` 与远端模型/控制器；冻结 PCOL 不参与联网服务构建。启动服务用 `node scripts/start-room-server.mjs`，游戏用 `node src/start.mjs`。从 PLAY TOGETHER → ROOMS 创建或加入六位房间码；也可通过 `?rooms=ws://127.0.0.1:8787/rooms` 指定服务。

## 架构与状态

Node 服务管理两席凭据、准备、开局、规则结算、结果和重赛。每局使用独立模块装载器、真实 22 球模拟器和标准裁判；当前在同一 Node 进程中同步执行物理，没有 Worker 或进程隔离。浏览器只负责本地相机、输入、界面和服务端轨迹的显示。

状态依次为 `waiting` → `ready` → `playing` → `finished`。准备要求两位玩家，开局还要求两席在线；结束后只能双方投票重赛。比赛中主动离房关闭房间并通知对手；等待或结束后离房保留剩余席位并转回等待，房主离开时转移房主。

## 消息

客户端消息带 `v: 1`、`type`、`requestId`。需要身份的命令还带 `roomId`、`playerId`、`token`。令牌只发给所属席位，公开房间状态不包含令牌。姓名按文本显示，当前限制为 10 个 Unicode 码点。

| 消息                             | 作用                                                    |
| -------------------------------- | ------------------------------------------------------- |
| `room.create` / `room.join`      | 创建或按房间码加入；返回本人身份及公开状态              |
| `room.ready`                     | 设置准备；本人收到带 requestId 的确认，双方收到状态广播 |
| `room.start`                     | 房主在双方在线且准备后创建真实比赛                      |
| `room.resume`                    | 用原令牌替换旧连接，恢复原席位与快照                    |
| `room.state`                     | 主动读取或广播公开状态                                  |
| `room.leave` / `room.left`       | 主动离房及确认                                          |
| `room.closed`                    | 通知剩余玩家比赛房间已关闭并清理凭据                    |
| `match.place`                    | 当前玩家放母球                                          |
| `match.shot`                     | 当前玩家提交方向、力度及可选击球点和杆轴                |
| `match.state` / `match.snapshot` | 请求或推送权威比赛快照                                  |
| `match.rematch`                  | 结束后的双方重赛投票                                    |
| `room.error`                     | 错误代码、原因及可关联的 requestId                      |

放球和击球命令带 `matchId`、`commandId`、`matchVersion`、`turn`。重复命令不重复执行物理，旧局、旧版本、错误球权的命令被拒。房间按 `revision` 排序，比赛快照按 `matchId` 内的 `version` 排序；新局版本零可替换旧局高版本，迟到的旧局快照被忽略。

击球使用原力度曲线 `(0.5 + 11p)(3.2 + 6p)`；可选 `shot.kiss` / `shot.axis` 传递塞、跟杆与缩杆，服务端重算速度并校验接触几何。当前接触距离允许 `[0.05, 1.1] × 球半径`。物理步长、摩擦与裁判算法保持原实现。

## 回放、终局与恢复

服务端先结算一杆，再发送终态与采样轨迹。浏览器按轨迹插值显示，播放期间禁止再次击球或放球；完成、超时、新局或退出时释放回放。重复确认不会重播同一杆。轨迹有 240 帧上限，超限只发送终态。

裁判给出 `ballOn === 0` 后，服务端记录结果并广播 `finished`，浏览器显示服务端结果。双方 REMATCH 才能换新 matchId；普通准备和开局不能绕过投票。刷新已结束的比赛仍恢复结果面板。

席位凭据保存在 `sessionStorage`。短暂断线可恢复同席位；新连接替换旧连接后，旧页面不会自动抢回席位。开局等房间抽屉的关闭事件后再转交控制器，保证球台没有遗留模态遮罩。终局与退出清理所属弹窗，退出后可在同一页面重新建房并开局；控制器交接期间的服务错误仍由请求 Promise 和 lastError 保留。当前仅在两席都离线超过 120 秒后清理房间，一席长期离线时尚无自动结束或判负策略。心跳、限流、TLS 与来源配置见[部署说明](../development/rooms-deployment.md)。

## 验证入口

| 验证                                            | 范围                                                                                                           |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `tests/unit/room-client.test.mjs`               | 请求关联、房间/新局版本排序、关闭中连接、替换连接、凭据恢复                                                    |
| `tests/unit/motion-replay.test.mjs`             | 轨迹采样、插值、重复确认、回放完成和旧局清理                                                                   |
| `tests/integration/room-client-server.test.mjs` | 真实浏览器传输实现连接真实 ws 服务；准备确认、真实裁判终局、双方重赛、继续放球及离房通知                       |
| `tests/integration/room-finished.test.mjs`      | 终局、投票及禁止用大厅命令绕过重赛                                                                             |
| `tests/integration/room-wss.test.mjs`           | 一次性自签证书的 WSS 生命周期与明文拒绝；测试配置独立于本机 OpenSSL 默认目录                                   |
| `tests/integration/room-match.test.mjs`         | 真实物理击球、双方快照、重复命令与旧版本拒绝                                                                   |
| `tests/integration/room-resilience.test.mjs`    | 心跳、限流、断线恢复、无人房间清理和来源限制                                                                   |
| `tests/e2e/rooms-ui.test.mjs`                   | 两个独立浏览器会话通过可见表单创建、加入、准备、开局                                                           |
| `tests/e2e/rooms-result.test.mjs`               | 真实一杆、刷新恢复、受控清彩后经击球协议触发真实裁判终局、结果面板、结果刷新、双方按钮重赛、继续放球和对手离房 |
| 其他 `tests/e2e/rooms-*.test.mjs`               | 双方稳定快照、完整杆法、逐帧运动、场馆一致性与容量                                                             |

执行 `node scripts/check-project.mjs --browser` 完成整体检查与全部房间浏览器专项。Chrome/Edge 各覆盖 source/development/production。结果专项输出位于 [rooms-result.json](../../artifacts/testing/rooms-result/rooms-result.json)，截图同目录；维护摘要见[房间优化记录](../../reports/validation/room-optimization.json)。

终局测试控制服务端接触/入袋结果，再走真实裁判、WebSocket 与结果界面；它没有通过自然键鼠操作打满整局。既有物理专项证明真实击球，不能把受控终局算作实打完整比赛。

## 当前边界

TLS/WSS 与来源白名单已通过本机测试；没有真实域名、CA 证书链、双设备或公网时延/丢包验收。页面 CSP 仍只放行回环 WebSocket。服务状态只在内存，重启后不能恢复；容量只测到两局并发开局，不能推算高并发对局能力。以上限制与源码独立启动的本地单机能力分开维护。
