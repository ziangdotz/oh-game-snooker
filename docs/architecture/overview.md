# 当前工程架构

全部运行代码及资产位于 `src/`。源码和构建版使用同一份实现；冻结 PCOL 只用于独立行为对照，不作为构建输入。本文只记录职责和依赖，专题实现与证据由链接文档维护。

## 维护目录

| 目录                                           | 唯一职责                                                    |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `src/domain`                                   | 数学、物理、模拟、裁判与布局；只依赖 domain 和无界面 shared |
| `src/application`                              | 组合根、对局、AI、回放与模式编排                            |
| `src/presentation`                             | 输入、相机、渲染、场景、UI、模板、样式与字体                |
| `src/infrastructure`                           | 资产读取、导航、会话存储和浏览器网络传输                    |
| `src/server`                                   | Node 房间传输、席位状态及无界面权威比赛；不进入浏览器构建   |
| `src/shared`                                   | 不依赖 DOM、网络或应用层的共享工具                          |
| `src/adapters`、`compatibility`、`third-party` | 引擎适配、明确的兼容修复、保留的第三方依赖与署名            |
| `src/runtime`、`assets`                        | 运行模块清单与装载器、实际资产                              |
| `scripts`                                      | 用户命令入口、参数解析和流程编排                            |
| `tooling/build`、`server`                      | 工程构建及构建版静态服务                                    |
| `tooling/validation`                           | 结构、命名、维护、算法及无界面验证                          |
| `tooling/measurement`、`testing`               | 性能测量、工程与测试共用的诊断辅助                          |
| `tooling/lib`                                  | 文件、哈希、产物分类和命令执行等跨职责基础工具              |
| `tests/unit`、`integration`、`e2e`、`helpers`  | 单元、集成、浏览器测试及测试夹具                            |
| `docs`、`reports`                              | 维护说明、带日期与输入范围的验证记录                        |
| `baselines/pcol`                               | 冻结程序与 SHA-256 清单，保持原始字节                       |

`build/development`、`dist`、`.cache`、`artifacts/testing` 和 `node_modules` 是本地生成内容，不作为维护源码。它们分别服务于开发输出、生产交付、构建事务、浏览器证据和工程依赖，不为缩短目录列表混入 `src`。

## 运行与装配

`src/start.mjs` 是仅依赖 Node 内置模块的源码服务，整个 src 可以独立复制启动。源码版直接加载 ES 模块；第三方 UMD 通过兼容工厂保留非严格模式。具体见[源码运行](../development/source-runtime.md)。

`src/runtime/runtime-catalog.json` 登记 115 个具名模块，记录来源、分包及实际依赖。组合根 `application/compose-game.js` 按原顺序创建子装配并连接跨组依赖。子装配明确拥有设置、编号、缓存及活动状态；共享可变状态通过显式 getter/setter 读取。工厂 ABI 和循环导出仍是现有契约，不能仅为缩短代码改成提前初始化。见[游戏装配](game-composition.md)、[球杆装配](cue-composition.md)和[维护边界](composition-root-assessment.md)。

`runtime/factory-loader.js` 是浏览器及 Node 比赛共用的实例化核心，每次创建拥有独立缓存，保留循环导出、工厂 receiver 与失败后重试。浏览器 module-loader 仅增加分包注册、传输和导出辅助；服务端 runtime-loader 负责本地工厂及碰撞资产读取。编译器沿默认 ESM 导入图纳入共享核心，不增加第二份手工包装。

物理、碰撞求解顺序和裁判保留既有算法。旧式语法例外只限清单的 `preservedSources` 文件，新代码不继承例外。算法整理与玩法优化应分别建立验证范围。

## 单机与联网

Practice、三档 AI、同机双人使用本地模型与控制器。同机双人共享一套输入和相机，双方身份与统计独立，交接依据裁判结果。见[同机验证](../validation/hotseat-match.md)。

菜单控制器分为本地界面与房间工作流：`interior-menu-controller` 管理场馆、抽屉、输入焦点和 UI 生命周期；`room-menu-controller` 管理房间请求、席位恢复、场馆对齐及比赛交接。连接订阅随菜单绑定/解绑，进入比赛时保留连接所有权交接。启动必须先等待场景就绪并完成加载，再恢复设置抽屉或房间，避免模态面板阻断加载完成。

联网使用浏览器原生 WebSocket 和独立 Node 服务。`server/rooms` 管理席位与房间状态，`server/matches` 使用真实物理及裁判权威结算；每局独立模块装载器，当前仍是单进程同步计算，没有 Worker 隔离。浏览器提交操作、显示轨迹，不决定得分和球权。比赛版本按 matchId 分组，重赛需要双方投票。见[房间协议](../validation/room-service.md)和[部署边界](../development/rooms-deployment.md)。

## 场景与展示

四套正式室内由 registry 管理，切换时复用引擎、球台和球，仅启用当前方案的装饰与灯光。加载、失败重试、字体就绪与恢复共享既有入口；静态阴影首次生成后缓存。现代单墙试做仍是显式可选功能，不能作为无引用代码删除。见[室内选择](../development/interior-selection.md)、[场景系列](../development/interior-design-collection.md)、[墙面试做](../development/modern-wall-study.md)。

UI、样式与字体各有唯一维护说明：[游戏界面](../development/game-ui.md)、[样式](../development/styles.md)、[字体](../development/typography.md)。允许的操作节奏和 DPR 差异见[操作流畅性](../validation/gameplay-motion.md)，WebGL 兼容恢复见[恢复专项](../validation/context-restoration.md)。这些记录不能证明当前主观手感已经流畅。

## 构建与验证

构建先校验冻结基准及维护输入，检查具名依赖、层次和资源引用闭包，再编译工厂导入图及按需分包。暂存输出通过逐文件哈希校验后事务发布，失败保留或恢复上一版。维护输入和开发/生产输出都由清单校验，不在构建阶段执行迁移补丁。

所有工程子命令通过 `tooling/lib/run-node.mjs` 使用同一 Node、工程工作目录、继承输出、无 shell 及隐藏窗口执行，保留非零退出状态和信号失败。命令入口继续保留在 scripts；不为复用引入框架或依赖。

检查命令与按改动选择的验证矩阵统一见[开发流程](../development/workflow.md)，提交分类见[仓库维护](../development/repository-workflow.md)。架构检查和功能测试通过不等同于真实 GPU 性能或长时间比赛验收。旧报告只对应当时的输入；同机刷新恢复的历史失败见[更名验证记录](../../reports/validation/project-renaming.json)，修复及当前范围见[交接](../learning/conversation-handoff.md)。

## 2026-11-15 精简复审

本轮沿现有职责边界收敛命令实现，不增设目录或运行框架：

- scripts/capture-browser-physics.mjs 只解析 CDP、来源及输出参数，浏览器采集归 tooling/testing/capture-browser-physics.mjs。
- scripts/verify-headless-match.mjs 只处理命令选项和退出码，对照流程归 tooling/validation/verify-headless-match.mjs。可复用函数返回通过状态，导入不会读取参考文件、写报告或退出宿主进程。
- 两个命令路径、物理夹具、容差、报告结构及默认输出保持原约定。命令入口的实现合计由约 470 行收敛至约 30 行；实现只迁移一次，没有兼容副本。

运行层复审保留 factory-loader 的每局隔离缓存、module-loader 的分包传输及 legacy-factory 的非严格模式边界。三者解决不同运行契约，合并会让浏览器与服务端重新耦合。构建的输入校验、编译及事务发布仍分别维护。控制器此前已分离房间工作流，本轮没有为文件长度引入新的转发层。

启动同步任务见[入场与 trace 记录](../validation/entry-optimization.md)。现有证据覆盖模型解析、对象创建和驱动同步的组合任务，尚不足以确定可安全移除的单一热点。按本轮的工作量限制，不改模型、第三方引擎、材质或就绪语义；没有新增启动提速结论。

这轮属于维护职责整理，不构成商用验收。公网、异常网络、长期运行和跨硬件验证仍需独立完成；目录数或检查通过不能替代这些证据。

## 目录合并与产物清理

2026-11-15：本地请求模块已从 infrastructure/network 迁入 infrastructure/assets，模块 ID、运行清单、保留源码白名单、算法迁移映射及测试同步更新；原 network 目录移除。net 继续只维护联网工作流。请求实现与物理算法保持原样。

本地产物按哈希清单清理：删除字节完全相同且未被维护记录引用的重复截图、过期测试夹具、一次性探针及旧日志；旧开发和生产构建删除后重新构建。物理冷启动参考、启动 trace 及分析脚本、焦点修复证据、测量摘要、最新引用证据和可选墙面试做保留。node_modules 保留供日常开发使用。文件清单与验证结果见[清理记录](../../reports/validation/directory-cleanup.json)。
