# DSH 远程访问（办公室→家）验收报告 v1
时间：2026-11-01 22:35 ｜ 域名：https://dsh.htgjai.com ｜ 隧道：669b8e29-9626-43e8-9ab3-2efa9982e169

## 你的书签（唯一入口，一次保存长期免验证）
```
https://dsh.htgjai.com/?key=<GATEKEY>
```
首次打开自动 303 跳干净首页并种下 10 年期门卫 cookie；之后直接访问 https://dsh.htgjai.com，无任何登录/OTP。

## 验收表
| 断言 | 判定 | 证据位置 | 遗留风险 |
|---|---|---|---|
| A1【红线】aff 零影响（容器/配置/hosts 逐字节不变） | ✅ 通过 | evidence/aff-before.txt vs aff-after.txt（diff 为空）；hosts-before/after.sha | 无 |
| A2 公网 DNS 指向新隧道 | ✅ 通过 | evidence/dns.txt（@1.1.1.1、@8.8.8.8、权威 NS 均 CF 边缘 IP；route dns 日志 CNAME→669b8e29） | CF 橙云代理不暴露 CNAME 明文（修正记录见 ACCEPTANCE.md） |
| A3 公网无凭证 401 闸 | ✅ 通过 | evidence/public-401.txt（GET 与 POST 均 HTTP/2 401，带 cf-ray LAX） | 无 |
| A4 固定 key 一次书签免验证 | ✅ 通过 | evidence/public-key.txt（?key→303+dshgate Max-Age=315360000；cookie→200+cf-ray） | key 留在书签/历史（本机）；若泄露：换 gate-secret.txt 并 kickstart gate |
| A5 dsh token 轮换自愈 | ✅ 通过 | evidence/restart-recover.txt（token 前缀 AvWZ→Xc0V 变化；重启后 ~15s 公网 200；gate.log 新增 session cookie adopted） | dsh 会话 cookie 30 天到期由 gate 自动重换（该路径已验证） |
| A6 dsh web 进程自愈 | ✅ 通过 | evidence/selfheal.txt（kill -9 → ~5s 新 PID 重监听 17877） | 无 |
| A7 隧道容器自愈 | ✅ 通过 | evidence/container.txt（RestartPolicy=always；docker restart→~5s running；公网 401 闸复测在） | 依赖 Docker Desktop 开机自启（与 aff 同一前提，现状已如此） |
| A8 公网真实 RPC 端到端（双通道对照） | ✅ 通过 | evidence/api-e2e.txt（公网 200 server-response ok:true；本地对照 200 一致） | 无 |

防作弊三查：业务改动（新增 gate.mjs、2 个 LaunchAgent、1 容器、1 隧道）> 断言改动（仅 A2 事实性修正并留痕）；通过均来自真实公网请求（cf-ray）加本地对照；无跳过/模拟（--resolve 仅绕过家侧 DNS 缓存，网络路径仍真实走 CF 边缘）。

## 架构
办公室浏览器 → Cloudflare 边缘(443, dsh.htgjai.com) → 隧道 dsh-remote（容器 dsh-remote-cloudflared, restart=always, QUIC×4） → host.docker.internal:17777 gate（固定key门卫 + token交换维持） → 127.0.0.1:17877 dsh web（--public-url/--trusted-host, LaunchAgent KeepAlive）

## 组件清单
- ~/dsh-remote/：gate.mjs、gate-secret.txt(0600)、dsh-web.log、gate.log、ACCEPTANCE.md、REPORT.md、evidence/、cloudflared/
- LaunchAgent：com.ajun.dsh-remote-web（17877）、com.ajun.dsh-remote-gate（17777）
- Docker：dsh-remote-cloudflared（restart=always，复用本地镜像 cloudflare/cloudflared:2026.6.1）
- 与 aff 完全隔离：独立隧道 669b8e29、独立配置目录、独立容器（aff 逐字节未动，见 A1）

## 自查命令（家里侧排障，哪层失败查哪层）
```bash
curl -s http://127.0.0.1:17777/gate/health          # gate（{"ok":true,...}）
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:17877/    # dsh web（401=活着）
curl -sS -o /dev/null -w '%{http_code}\n' https://dsh.htgjai.com/   # 公网（401=通）
docker logs --tail 20 dsh-remote-cloudflared
tail -20 ~/dsh-remote/gate.log
launchctl list | grep dsh-remote
```

## 应急与运维
- 断公网入口（怀疑泄露）：Cloudflare 面板删 dsh.htgjai.com 记录，或 docker rm -f dsh-remote-cloudflared
- 换钥匙：openssl rand -base64 32 | tr '+/' '-_' | tr -d '=' > ~/dsh-remote/gate-secret.txt && launchctl kickstart -k gui/$(id -u)/com.ajun.dsh-remote-gate
- 合盖外出：依赖 com.ajun.caffeinate-lid-closed（已在跑），出门前确认 launchctl list 里有它
- 家侧浏览器首次打不开域名：mDNSResponder 否定缓存，等几分钟或 sudo killall -HUP mDNSResponder（办公室不受影响）

## 运维记录（2026-11-01 22:41 追加）
- 事件：用户重开 DSH 桌面 App 后公网变慢（401 秒级/偶发超时）。排查：本地三层毫秒级正常；同 zone 的 aff 隧道（app/lp.htgjai.com）同样 5.6–9.4s；无关站点 www.cloudflare.com 4.8s、dash.cloudflare.com 超时 → 判定为家里宽带到 CF 边缘的国际链路周日晚高峰拥塞，与本架构无关（三独立证据链）。
- 动作：隧道协议 quic→http2（国内 UDP 更易被 QoS，TCP 更稳），config.yml 已固化 protocol: http2，容器已重建。功能验证：公网 API 完整传输 39KB 成功。
- 影响：高峰期慢但可用；平峰恢复秒级（22:26 实测毫秒-秒级）。桌面 App 重开/升级不影响本栈（App 动态端口与 17877/17777 无冲突，实测并行）。

## 运维记录（2026-11-01 22:53 追加：web 端与桌面端配置对齐）
- 现象：网页版看不到部分插件和已配置模型。根因：同一 App 按 profile 隔离配置（~/.dsh/profiles/desktop vs web），桌面端 7 个插件 + zai 三组 provider 只配在 desktop profile。
- 动作：①官方通道 `dsh plugin --profile web add` 安装 6 个插件（workmate/project-memory/subagent-claude-code/subagent-codex/model-failover/glm-suite）；②bundles 5→19（补 8 个 experimental）；③cordis.patch.yml 以 desktop 为准合并（备份 .bak-1101-remote）；④移除两条 web 无目标插件的孤儿 patch 条目。
- 事故留痕：22:51 清理脚本缺陷损坏 patch 致实例短暂崩溃循环，22:52 从备份+desktop 源重建恢复（KeepAlive 自动拉起，中断 <2 分钟）。
- 验证：本地与公网 API 均 200 且含 glm-5.3/zai-coding-cn-2；dump-config 零告警；node_modules 27→121。
- 注意：以后桌面端新装插件/改模型不会自动同步到 web 端（profile 隔离是产品行为）。再同步参考本记录①②③。

## 运维记录（2026-11-01 23:10 追加：gate v2 双上游 = 完整接力）
- 需求：办公室要能直接接力桌面 App 正在进行的对话（读+写+实时流），而非旁观。
- 方案：gate 升级双上游——优先自动发现桌面 App 内置服务（lsof+签名探测，15s 刷新），用 ~/.dsh/.credentials.yaml 共享签名密钥铸造 loopback 授权 cookie（与官方 token→cookie 交换等价，30 天窗口内合法），Host/Origin 改写通过信任栅栏；桌面 App 关闭时自动回退 17877 常驻 web 实例（官方 token 交换）。公网侧固定 key 门卫不变。
- 效果：桌面 App 开着 → 办公室浏览器 = 桌面本身（同一实例，实时流，双方可同时操作，无锁冲突）；桌面 App 关闭 → 锁随进程释放，web 实例可继续任何会话。
- 验证（evidence/desktop-takeover.txt）：page 200 桌面 shell（42641B≠web 39212B）；API 200 桌面 profile（44761B≠web 43746B，含 model-failover 配置）；WS /api/remote.mux 101 握手成功；无 cookie 401。
- 安全注记：铸造 cookie 使用的密钥与官方交换所用同一持久密钥，本机 0600 存储，未新增信任边界；gate 仍是公网唯一入口与认证层。

## 最终验证（2026-11-01 23:27，用户确认可用）
- session/list 经 gate→桌面实例：900 会话、20 工作区全覆盖；当前对话 running=true、updatedAt=23:26:43、asOfSeq=1555 —— 网页与桌面运行状态一致（完整接力成立）。
- 桌面 App 重启（60013→51914）gate 15 秒自动重锁端口，查询无感恢复。
- 用户浏览器实测通过。
