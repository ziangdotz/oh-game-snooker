# 房间服务部署与运维

本文记录联网房间服务当前可以怎样部署、必须配置什么、以及哪些结论还没有经过公网验证。

## 当前形态

- 服务入口：`npm run rooms:serve -- --port 8787`，默认绑定 `127.0.0.1`，只监听 `/rooms`（WebSocket）与 `/healthz`（HTTP）。
- 浏览器通过 `?rooms=ws://host:port/rooms` 或 `window.__snookerRoomEndpoint` 指定地址；未指定时按 `ws(s)://<当前主机名>:8787/rooms` 推断。
- 页面 CSP 只放行回环 WebSocket（`connect-src 'self' ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:*`）。部署到公网域名时必须同时修改这一行，否则浏览器会拒绝连接。
- 房间状态全在内存里：进程重启即丢失所有房间与对局。

## 连接健康

| 项目     | 当前值            | 位置                              |
| -------- | ----------------- | --------------------------------- |
| 心跳周期 | 15 s              | `HEARTBEAT_INTERVAL_MS`           |
| 掉线判定 | 连续 2 次         | `MAX_MISSED_HEARTBEATS`           |
| 限流     | 20 条/秒，突发 40 | `RATE_LIMIT_PER_SECOND`/`_BURST`  |
| 断线宽限 | 120 s             | `DISCONNECT_GRACE_MS`             |
| 连接上限 | 256 个传输        | `MAX_CONNECTIONS`                 |
| 单条消息 | 64 KiB            | `room-server.mjs` 的 `maxPayload` |

行为说明：

- 心跳用 WebSocket 原生 ping/pong。对端连续两次没有 pong 就被 `terminate()`，该座位置为离线并广播新状态。
- 席位掉线不会结束对局：座位保留在房间里，`room.resume` 用原令牌可以回到同一帧。只有两个席位都离线超过宽限时间，清扫器才释放房间与比赛实例。
- 超限连接在握手阶段就被拒绝（HTTP 503），不会占用一个已打开的 socket。
- 超出限流的命令返回 `room.error{code:'rate_limited'}`，连接保留，以便玩家在短暂连点后继续操作。
- `origins` 为空时不校验 `Origin`（回环场景安全）；公网部署必须传入站点来源。带 `*` 的模式按前后缀匹配端口。

## 容量实测

`node tests/e2e/rooms-capacity.test.mjs` 在本机循环、无 TLS 的单进程上测得（记录见 [rooms-capacity.json](../../artifacts/testing/rooms-capacity/rooms-capacity.json)）：

| 场景                 | 结果                       |
| -------------------- | -------------------------- |
| 8 房 / 16 连接       | 约 0.10–0.15 s，堆约 11 MB |
| 24 房 / 48 连接      | 约 0.19–0.37 s，堆约 12 MB |
| 48 房 / 96 连接      | 约 0.43–1.24 s，堆约 15 MB |
| 2 局真实开局（并发） | 约 0.58 s，堆 18.5 MB      |
| 第 257 个连接        | 握手被拒（HTTP 503）       |

大厅状态很便宜；真正昂贵的是开局，因为每个进行中的对局都独占一个物理世界。上面只有两局的数据，不能据此推算几十局并发的上限。具体毫秒数随机器负载波动，量级稳定。

## 已完成的部分

1. **TLS/WSS**：服务可直接加载证书，`npm run rooms:serve -- --port 8443 --key key.pem --cert cert.pem --origins https://play.example.com` 会以 `wss://` 提供服务。`room-wss.test.mjs` 用一次性自签证书跑通完整大厅与开局，并验证明文 `ws://` 连不上 TLS 服务、`/healthz` 也走 HTTPS。
2. **来源白名单**：`--origins` / `origins` 已生效，白名单外的浏览器来源在握手阶段被拒（WSS 与明文都已验证）。
3. **限流与容量保护**：令牌桶限流、连接上限、单条消息 64 KiB 上限均已实现并测试。

## 公网部署还缺什么

未完成、因此**不得**声称公网可用：

1. **页面 CSP**：`config/project.config.mjs` 的 `connect-src` 仍只放行回环。部署到真实域名时必须加上该域名（如 `wss://play.example.com`），否则浏览器会拒绝连接。
2. **真实域名与证书链**：只用自签证书验证过，没有真实 CA 证书、HSTS 或域名校验。
3. **跨设备实测**：现有验收都在同一台机器上的两个浏览器上下文之间完成，没有经过真实网络时延、丢包或 NAT。
4. **持久化**：进程重启即清空；没有房间快照落盘，也没有恢复协议版本迁移。
5. **容量上限**：只测到 2 局并发开局，“多少局同时进行仍可玩”还没有结论；单进程也没有 CPU 隔离或多进程分流。
6. **账号体系**：没有鉴权账户，席位令牌只是随机 UUID；令牌泄露等于席位泄露。

## 本地运行

```powershell
# 明文，仅回环
npm run rooms:serve -- --port 8787

# TLS 直连（自签证书时浏览器需先信任该证书）
npm run rooms:serve -- --port 8443 --key key.pem --cert cert.pem `
  --origins https://play.example.com

# 另开一个终端，用两个标签访问
# http://127.0.0.1:8080/?interior=interior-design-original&rooms=wss%3A%2F%2F127.0.0.1%3A8443%2Frooms
```

`/healthz` 返回 `{ ok, rooms, connections, sockets, matches, capacity }`，可用于部署探针与容量观测。
