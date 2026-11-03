# Oh My Snooker

可离线运行的 3D 斯诺克工程。全部运行源码、资产、模板与第三方依赖位于 `src`；冻结 PCOL 仅用于完整性校验和行为对照。

当前功能包括 Single Play（三档 AI 对战）、Practice、同机双人、联网房间（PLAY TOGETHER → ROOMS）与四套室内。房间已提供本机双会话对战、服务端裁判、结果、双方重赛与刷新恢复；公网与跨设备尚未验收，详见[房间与双人方案](docs/development/rooms-and-two-player-plan.md)。

## 启动

推荐 Node.js 24，最低 22.13。执行 `node src/start.mjs` 后打开 http://127.0.0.1:5173/，也可双击 `start.cmd`。源码启动无需安装工程依赖或先构建；复制整个 `src` 后在其中运行 `node start.mjs` 即可，修改源码后刷新页面。

启动页提供 SINGLE PLAY、PLAY TOGETHER、PRACTICE、INTERIOR DESIGN 及 ABOUT。四套场馆为原始、001、002、003，可通过菜单或 `?interior=interior-design-001` 等参数选择。桌面浏览器需要支持 WebGL；球在手中时在 D 区点击放母球，W 瞄准，滚轮控制力度，Space 击球，完整操作见游戏内 CONTROLS。

## 工程目录

| 目录                                                    | 职责                                     |
| ------------------------------------------------------- | ---------------------------------------- |
| `src/domain`                                            | 数学、几何、物理、模拟、裁判             |
| `src/application`                                       | 启动、依赖装配、模型、控制器、AI、回放   |
| `src/presentation`                                      | 输入、相机、渲染、场景、界面、样式与字体 |
| `src/infrastructure`、`shared`、`adapters`              | 本地 I/O、共享工具与引擎适配             |
| `src/runtime`、`assets`、`compatibility`、`third-party` | 模块清单、资源、兼容边界与运行依赖       |
| `baselines/pcol`                                        | 冻结游戏及其 SHA-256 清单                |
| `config`、`scripts`、`tooling`                          | 工程配置、命令及实现                     |
| `tests`、`docs`、`reports`                              | 当前验证、维护文档与结果                 |
| `artifacts/testing`                                     | 当前浏览器截图、状态和诊断               |
| `build/development`、`dist`                             | 从 `src` 生成的开发与生产输出            |

## 维护命令

构建、校验、测试和测量命令需先执行 `npm ci`。`node scripts/dev-server.mjs` 的 `/` 提供开发构建，`/baseline/` 提供冻结对照；与源码服务同时运行时用 `--port` 指定不同端口，例如 `--port 5174`。`dist` 可通过任意 HTTP 静态服务交付。

| 命令                                          | 用途                                 |
| --------------------------------------------- | ------------------------------------ |
| `npm run dev` / `npm start`                   | 从 src 启动                          |
| `npm run rooms:serve`                         | 启动本机房间 WebSocket 服务          |
| `npm run dev:built`                           | 校验并启动开发构建版                 |
| `npm run build` / `npm run verify`            | 构建 / 校验输入输出完整性            |
| `npm run verify:algorithms`                   | 137 项算法结构对照                   |
| `npm run verify:headless`                     | Node 无界面物理、裁判与比赛快照      |
| `npm run lint` / `npm run format:check`       | lint / 格式检查                      |
| `npm test`                                    | 单元与集成测试                       |
| `npm run check` / `npm run check:browser`     | 整体检查 / 另含浏览器回归            |
| `npm run check:maintenance`                   | 模块、资产、文档、命令与锁文件审计   |
| `npm run test:e2e`                            | 浏览器完整游戏回归                   |
| `npm run test:e2e:rooms`                      | 两个浏览器会话的 ROOMS 大厅与开局    |
| `npm run test:e2e:rooms-wire`                 | 房间协议层双浏览器生命周期与击球快照 |
| `npm run test:e2e:rooms-match`                | 远端对局镜像：放球、击球、比分与球权 |
| `npm run test:e2e:rooms-result`               | 结果、再来一局与刷新恢复             |
| `npm run test:e2e:rooms-motion`               | 远端逐帧运动回放                     |
| `npm run test:e2e:rooms-cue`                  | 远端完整杆法：塞、跟杆与缩杆         |
| `npm run test:e2e:rooms-venue`                | 房间场馆一致性                       |
| `npm run test:e2e:rooms-capacity`             | 房间服务容量与连接上限               |
| `npm run test:e2e:source`                     | 仅复制 src 独立运行                  |
| `npm run test:e2e:interior`                   | 室内加载、界面、字体、切换和恢复     |
| `npm run test:e2e:continuous`                 | AI、连续击球、回放及重开             |
| `npm run test:e2e:shadows`                    | 静态阴影缓存验证                     |
| `npm run test:e2e:motion`                     | 四室内真实硬件操作验证               |
| `npm run test:e2e:context`                    | 完整 WebGL 恢复验证                  |
| `npm run test:e2e:original`                   | 原始场景精确对照                     |
| `npm run measure:interior -- --label current` | 实际 GPU 室内移动测量                |

维护以[架构](docs/architecture/overview.md)、[开发流程](docs/development/workflow.md)、[学习入口](docs/learning/guide.md)及[当前交接](docs/learning/conversation-handoff.md)为入口。组合根与子装配的职责和状态寿命已明确，见[维护边界](docs/architecture/composition-root-assessment.md)。

第二阶段的无界面物理、裁判、比赛快照和房间服务入口、结果与边界见[headless 验证](docs/validation/headless-match.md)及[房间协议](docs/validation/room-service.md)。

同机双人入口为 PLAY TOGETHER → TWO-PLAYER MATCH，可设置两位姓名和四套室内，轮流使用一套键鼠。实现与验证见[同机双人专项](docs/validation/hotseat-match.md)。联网入口为 PLAY TOGETHER → ROOMS：先运行 `npm run rooms:serve`，再在页面创建房间或用六位房间码加入；开局后两名真人进入同一球台，放球、击球、比分与球权都由服务端裁决。

源码、冻结基准、测试、文档和验证摘要按[仓库维护约定](docs/development/repository-workflow.md)提交；生成输出、缓存、截图与逐帧测量数据由 `.gitignore` 排除。冻结资源、第三方依赖和资产保持原始字节。现有署名见[src/third-party/notices.txt](src/third-party/notices.txt)。

功能开发前的工程审查、清理范围和验收结果见[工程规范化记录](docs/validation/project-normalization.md)。
