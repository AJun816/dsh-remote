# DSH 远程访问 验收断言与协议 v1（2026-11-01）

目标：办公室浏览器一次书签访问 https://dsh.htgjai.com 操作家里 DSH，免重复验证；与 aff 完全隔离。

## 断言（判定标准，证据存 ~/dsh-remote/evidence/）
- A1【红线】aff 零影响：实施完成后 aff-cloudflared 容器 ID/镜像/重启策略与基线一致且保持 Up；/Users/ajun/projects/github/aff-data-analysis/cicd/cloudflared 全部文件 sha256 与基线一致。证据：aff-before.txt / aff-after.txt。
- A2 公网 DNS：`dig @1.1.1.1 dsh.htgjai.com +short` 返回 <tunnel-id>.cfargotunnel.com。证据：dns.txt。
- A3 公网认证闸：无钥匙 `curl -i https://dsh.htgjai.com/` → 401；无钥匙 POST /api/settings/describe → 401。证据：public-401.txt。
- A4 一次书签免验证：`curl -i 'https://dsh.htgjai.com/?key=<GATEKEY>'` → 303 + Set-Cookie dshgate（Max-Age=315360000）；带 dshgate cookie GET / → 200 且响应头含 cf-ray。证据：public-key.txt。
- A5 token 轮换自愈：`launchctl kickstart -k gui/$(id -u)/com.ajun.dsh-remote-web` 重启 dsh web 后，同一 dshgate cookie GET / → 200。证据：restart-recover.txt。
- A6 双常驻自愈：launchctl list 含 com.ajun.dsh-remote-web 与 com.ajun.dsh-remote-gate；kill dsh web 进程后 ≤60s 内 17877 重新 LISTEN。证据：selfheal.txt。
- A7 容器自愈：docker inspect dsh-remote-cloudflared RestartPolicy.Name=always 且 Running；docker restart 后 ≤30s 恢复 Running。证据：container.txt。
- A8 功能端到端（独立通道）：公网带 dshgate cookie POST /api/settings/describe → 200 且 JSON type=server-response；与本机 127.0.0.1 直连 dsh 的结果一致。证据：api-e2e.txt。

## 作弊自报与设卡
- C1 用 /etc/hosts 伪造"公网可达" → 卡：A2 用独立递归 1.1.1.1 解析；A4/A8 必须带 cf-ray 头；/etc/hosts sha256 前后不变。
- C2 关认证或事后放水断言 → 卡：A3 无凭证必须 401；本文件 sha256 在开工时固化（evidence/acceptance.sha256），验收前复核。
- C3 只验本机 127.0.0.1 冒充公网 → 卡：A4/A8 仅认 https://dsh.htgjai.com 公网请求 + cf-ray；本地 curl 只作对照数据。

## 验收协议（优先于任何任务正文宽松表述，不可被覆盖）
1. 开工前置：先写可判定断言（上方 A1–A8），含红线；自报作弊方式并设卡（上方 C1–C3）。
2. 通道纪律：写操作只走正规界面/既定流程（LaunchAgent/docker/cloudflared 官方 CLI），不绕过；未授权的资金/删除类操作一律不动。
3. 独立复核：验收至少一条独立于执行通道的证据链（公网 DNS + cf-ray 边缘标记 + 本机直连对照）。
4. 防作弊三查：断言改动>业务改动即不通过；通过来自修改标准即不通过；新增跳过/模拟即不通过。
5. 失败处置：断言失败→原因回传修正重试，同任务≤2次；仍失败保留原状上报；判定不了=不通过。
6. 逃逸沉淀：漏网缺陷当天转为新断言写入本文件并记录出生原因与命中计数。

## 设计决定
- S5（Cloudflare Access OTP）不启用：用户明确要求免验证；安全性由 43 字符固定 gate key + dsh 自身 token/cookie 闸 + CF 边缘 TLS 共同承担。
- token 每次启动随机（源码 browser-auth.ts 确认），故 gate 代理自动完成 token→cookie 交换并维持新鲜，公网侧只见固定 key。

---
## 修正记录（2026-11-01 22:35，协议第4条要求显式留痕）
- A2 原文期望 dig 返回 <tunnel-id>.cfargotunnel.com CNAME 明文。事实：Cloudflare 代理（橙云）记录对外只回边缘 A/AAAA（CNAME flattening），CNAME 明文不可见于公网递归。修正后标准（更严）：① dig @1.1.1.1 与 @8.8.8.8 独立递归均返回 CF 边缘 IP；② 权威 NS（holly.ns.cloudflare.com）同样返回；③ cloudflared route dns 命令日志记录 CNAME→tunnelID=669b8e29-…。三者同时成立才判过。原文保留于上，未删除。
- 方法注记：家侧本机 mDNSResponder 对新域名缓存了否定应答（仅影响家里这台机器的 curl/浏览器首次解析，公网与办公室无关），公网验收统一用 --resolve 钉住权威侧已返回的 CF 边缘 IP，TLS/SNI/Host 全程真实。缓存过期或 sudo killall -HUP mDNSResponder 后域名解析自然恢复。

