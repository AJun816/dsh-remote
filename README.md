# dsh-remote

办公室浏览器安全访问家里 Mac 上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 网页版：Cloudflare Tunnel + 固定钥匙门卫代理，一次书签、长期免验证。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)

## 架构

```
办公室浏览器
   │ HTTPS 443（公司网络零要求）
   ▼
Cloudflare 边缘（dsh.htgjai.com）
   ▼ QUIC/http2 隧道（cloudflared 容器，restart=always）
gate（127.0.0.1:17777，固定 key 门卫 + dsh token→cookie 自动交换维持）
   ▼
dsh web（127.0.0.1:17877，LaunchAgent KeepAlive 常驻，
        --public-url/--trusted-host 按官方反代约定）
```

- 公网无凭证一律 401；`/?key=<固定钥匙>` 一次换 10 年期门卫 cookie，之后无任何登录步骤
- dsh 的启动 token 每次进程重启随机轮换，由 gate 从服务日志自动读取并完成官方 token→cookie 交换，用户无感
- 与本机既有的 aff 隧道完全隔离（独立隧道 / 独立配置目录 / 独立容器）

## 仓库内容

| 路径 | 说明 |
|---|---|
| `gate.mjs` | 门卫代理（Node，零依赖）：固定 key 认证 + token 交换维持 + WebSocket/HTTP 转发 |
| `plists/` | 两个 LaunchAgent 模板（dsh web 常驻 + gate 常驻） |
| `cloudflared/config.yml` | 隧道配置模板（凭据 JSON 不入库） |
| `ACCEPTANCE.md` | 验收断言与防作弊协议原文 |
| `REPORT.md` | 验收报告（四列验收表 / 排障命令 / 运维记录，敏感串已打码） |
| `evidence/` | 全部验收证据（公网 cf-ray、自愈时间线、aff 零影响 diff 等，敏感串已打码） |

## 复刻步骤（另一台 Mac）

1. `cloudflared tunnel login` → `tunnel create dsh-remote` → `tunnel route dns dsh-remote <域名>`
2. 隧道凭据 JSON 放入私有目录（不入库），ingress 指向 `http://host.docker.internal:17777`
3. `openssl rand -base64 32 | tr '+/' '-' | tr -d '=' > gate-secret.txt`（0600，绝不入库）
4. 按 `plists/` 模板安装两个 LaunchAgent（dsh web 端口、公网域名按需修改）
5. 按 `ACCEPTANCE.md` 的断言逐条验收

## 安全模型

- 固定 43 字符 gate key（书签携带一次）+ dsh 自带 token/cookie 闸 + CF 边缘 TLS 与隐藏家 IP
- 泄露应急：CF 面板删 DNS 记录即断公网入口；或换 gate-secret.txt 后重启 gate 服务
- 本仓库所有凭证/cookie/token 均已打码，`gate-secret.txt` 与隧道凭据 JSON 由 .gitignore 强制排除

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
