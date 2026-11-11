# 用 Git + SSH Deploy Key 部署 DSH daemon

服务器直接从 GitHub clone 本仓库，不再从开发机打包上传源码。部署脚本本身也在仓库里，
跟着代码一起版本化；更新只需要 `git fetch` + 重启。

## 为什么改成这样

| | 旧方案（源码 tarball） | 本方案 |
| --- | --- | --- |
| 首次交付 | 本机 `git archive` 打约 42MB 包，scp 上传 | 服务器 `git clone --depth 1` |
| 更新 | 重新打包、重新上传、重新解压 | `sudo bash /opt/dsh/repo/deploy/update.sh` |
| 版本追溯 | 服务器上只是一堆文件 | `git rev-parse HEAD` 精确对应某个提交 |
| 回滚 | 重新传旧包 | `git checkout <sha>` 后重启 |
| 凭据 | 每次 scp/ssh 输密码 | 一次配置只读 deploy key |

链路不变：`手机 App --HTTPS/WSS--> Caddy(443, 自动证书) --HTTP--> daemon(127.0.0.1:3080)`。
daemon 只监听回环，Caddy 只转发 `/api/*`，其余 404；`flush_interval -1` 保证流式输出不被缓冲。

**为什么不用仓库自带的 `apps/cli/config/dsh-nginx.conf`**：那份模板的 `location` 白名单
只覆盖老路径（`session/(list|create|prompt|events|cancel|modelCatalog|selectModel)` 等），
新增的 `skills/list`、`mcpManager/*`、`settings/*`、`session/search`、`session/projections`
会被 404；`proxy_read_timeout 75s` 对 WSS 长连接也偏短。

## 前置事实（动手前先看）

- 远端 `origin` 是上游 `deepseek-ai/deepseek-harness`；你自己的仓库是 `dsh-cli`
  (`https://github.com/arvelvale/dsh-cli.git`)，**PUBLIC**，默认分支 `main`，你有 ADMIN 权限。
- 本地 `master` 基于上游历史，比 `origin/master` 领先若干提交（新的 TUI、六个浮层、
  本部署目录）。最新代码以快照提交发布在 `deploy/seoul` 分支；`main` 仍是 0.0.1 快照。
- `dsh-cli/main` 是「导入 DSH CLI 0.0.1 源码快照」，与本地 `master` **没有共同祖先**。
  所以 `git push dsh-cli master:main` 会 non-fast-forward 被拒。默认做法是推到独立部署分支
  `deploy/seoul`，不动 `main` 和 `v0.0.1` tag；服务器按这个分支 clone。
- **本 checkout 是 shallow clone**：`.git/shallow` 标记边界 `fcc0ad46`，而它是个 merge commit，
  两个 parent 对象（含 `abc0e709…`）本地都不存在。所以从 `master` 直接 push 任何分支都会在服务端
  报 `did not receive expected object ... / index-pack failed`，`git push --no-thin` 也无效。
  这个 fork 本来就按「源码快照」管理（`main` 是单个 root commit），因此 `deploy/publish.sh`
  用 HEAD 的 tree 生成一条新提交、parent 接在已有快照之后，绕开断掉的历史。
- 仓库是 public，只读 clone 其实 HTTPS 也能做。仍然用 SSH 的理由：deploy key 只授权单个仓库、
  只读、可随时在仓库设置里撤销；把服务器公钥加到**账号** SSH Keys 会连带获得该账号所有仓库的
  读写权限，权限过大。将来仓库转 private 也不用改部署方式。

## 步骤

### 0. 云控制台

轻量应用服务器的防火墙是独立于系统 ufw 的一层，在 `实例 → 防火墙` 放行 TCP `80`、`443`
（以及你自己的 SSH `22`）。不放行 80 会让 Let's Encrypt 的 HTTP-01 挑战失败，证书签不下来。
顺带确认套餐的峰值带宽 / 月流量包：手机传图片、文件吃上行。

### 1. 开发机：把代码发布到部署分支

首次发布已完成，`deploy/seoul` 分支已存在。开发继续在 `master` 上做，之后每次改动用下面
这条命令追加一条新快照提交：

```bash
cd D:/bigproject/dsh-cli
bash deploy/publish.sh deploy/seoul
```

脚本会用当前 HEAD 的 tree 生成一条快照提交，parent 取远端 `deploy/seoul` 的 tip（首次则取
`main` 的 `0.0.1` 快照提交），然后 `git push --no-thin` 到该分支。工作区有未提交改动时会拒绝发布。

`pre-push` hook 会跑 `pnpm run typecheck`（约 40 秒）。本机默认 Node 22 不满足
`engines >=24.9.0`，建议把便携 Node 24 放到 PATH 前面再发布：

```bash
PATH="/d/bigproject/dsh-cli/.dsh-build/runtime/node-v24.21.0-win-x64:$PATH" \
  bash deploy/publish.sh
```

以后每次有改动：先在 `master` 提交，再跑一次 `publish.sh`，最后在服务器跑 `update.sh`。
不要改 `main`；如果确实要合并进 `main`，走 PR 或 `git push --force-with-lease dsh-cli master:main`
（后者会改写已发布分支，且 `v0.0.1` tag 仍指向旧快照）。

### 2. 服务器：生成 key，并在 GitHub 登记

本机只需传**一个**几 KB 的脚本（不传源码）：

```bash
scp deploy/bootstrap.sh ubuntu@<SERVER_IP>:/tmp/dsh-bootstrap.sh
ssh -t ubuntu@<SERVER_IP> "sudo bash /tmp/dsh-bootstrap.sh init-key"
```

`init-key` 会生成 `/root/.ssh/dsh_deploy`（ed25519、无口令）、写好 `~/.ssh/config` 的
`Include` 段与 `known_hosts`，并打印公钥。把公钥贴到：

```
GitHub -> arvelvale/dsh-cli -> Settings -> Deploy keys -> Add deploy key
```

**不要勾选 `Allow write access`**。这一步是「填到 GitHub」的正确位置，不是账号
Settings → SSH and GPG keys。登记后可用 `sudo ssh -T git@github.com` 验证，
成功时输出 `Hi arvelvale/dsh-cli! You've successfully authenticated...`（退出码 1 是正常的）。

### 3. 服务器：clone 并安装

```bash
ssh -t ubuntu@<SERVER_IP> \
  "sudo bash /tmp/dsh-bootstrap.sh install <DOMAIN> deploy/seoul"
```

`<DOMAIN>` 用免费泛解析域名，例如 IP `43.166.12.116` 对应 `43-166-12-116.sslip.io`
（写进域名里的 IP 就是解析结果，不用买域名、不用 DNS 记录、境外节点不涉及备案）。
Caddy 自动向 Let's Encrypt 申请并续期证书，0 元。

`install` 依次做：校验 SSH 认证 → `git clone --depth 1 --branch deploy/seoul` 到
`/opt/dsh/repo` → 校验 `pnpm-lock.yaml` / `apps/cli/src/tui-panels.ts` / `deploy/setup.sh`
存在（防止忘了 push 就装旧代码）→ 把分支名记到 `/etc/dsh/deploy-branch` → 执行 `setup.sh`。

`setup.sh` 做 8 件事：装依赖与 Caddy → 装 Node 24.21.0（用仓库
`scripts/primary-runtime/lock.json` 的官方 SHA256 校验）→ 装 pnpm 11.28.5 →
`pnpm install --frozen-lockfile` → 建 `dsh` 服务用户与 256bit 随机 Token →
写 systemd unit 与 Caddyfile → 放行 ufw → 启动并自检。幂等，可重复运行。

**运行方式**：systemd 用 `node --import tsx/esm apps/cli/src/dsh-cli.ts daemon ...` 直接跑源码，
而不是 `pnpm run build` 产物。完整 build 会编译 native addon 并构建 Web/Desktop，
在 2 核 8GB 上耗时长且易失败；源码 + tsx 这条路径已在本机 Node 24 下真实跑通过 TUI。

### 4. 日常更新

```bash
ssh -t ubuntu@<SERVER_IP> "sudo bash /opt/dsh/repo/deploy/update.sh"
```

开发机 `bash deploy/publish.sh` 发布新快照 → 服务器 fetch → 若 HEAD 变化则
`pnpm install --frozen-lockfile` + `systemctl restart dsh-daemon`；无变化则跳过。
工作树有本地改动时会拒绝覆盖并提示。

## 手机 App 配置

安装成功后终端会打印：

```
服务器地址 : https://<DOMAIN>
Daemon Token: <43 字符随机串>
部署分支   : deploy/seoul
代码版本   : <short sha>
```

在 `apps/mobile` 设置页填入前两项（App 只校验 `https://` 前缀），Token 通过
`Authorization: Bearer` 传给 `/api/*`。Token 等同 Host 管理员权限，请存到密码管理器。

**模型 Key**：编辑服务器 `/etc/dsh/provider.env` 写入 `DEEPSEEK_API_KEY=sk-...`，
然后 `systemctl restart dsh-daemon`；也可在已连接的 TUI 里用 `/login` 配置。

## 验证

```bash
systemctl status dsh-daemon caddy
journalctl -u dsh-daemon -n 50
journalctl -u caddy -n 50
curl -H "Authorization: Bearer <TOKEN>" https://<DOMAIN>/api/session/list
```

手机浏览器打开域名应看到 404（说明 Caddy 已起、证书有效、非 `/api` 路径被挡）。
App 里依次试 `/skills`（应列出 Host 的技能）、`/mcp`、`/plan`、`/files`，发一条消息看流式
输出是否实时到达，再试 Ctrl+C / Esc 中断。

## 安全清单

- **Token 等同 Host 管理员**：持有者可通过 Agent 执行服务用户与 DSH 沙箱授权的操作，
  这是公网部署最大的残余风险，不要当普通登录密码。
- 已做：daemon 只听回环；Caddy 只转发 `/api/*`；Host 自带 Host/Origin + Bearer 校验；
  `--trusted-host` 限制为实际域名；Token 256bit 随机；ufw 只开 22/80/443；
  deploy key 只读且仅授权本仓库。
- **建议追加**：SSH 改密钥登录并禁用密码登录；`ufw limit 22/tcp`；装 fail2ban 盯 401；
  在云控制台把 SSH 来源限到自己的 IP。之前在对话里出现过的 SSH 初始密码、
  工作台管理员初始密码和访问令牌应视为已泄露，请轮换。部署脚本不读取也不写入这些值。
- 不要开 `tailscale funnel`、不要把 3080 直接映射到公网、不要给 Caddy 加 Basic Auth
  （会和 App 的 `Authorization: Bearer` 抢同一个 header）。
- 工作区文件浏览由 `DSH_DAEMON_WORKSPACE=/srv/dsh/workspace` 限定，跳过隐藏项、拒绝目录逃逸；
  手机端 `/files` 只读。上传走 `session/uploadFileBinary` 生成一次性 receipt 作为对话附件，
  **不是**把文件写进工作区。

## 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `Permission denied (publickey)` | 公钥没加到**仓库 Deploy keys**，或 `known_hosts` / `config` 没生效；重跑 `init-key` |
| clone 后提示缺少 `deploy/setup.sh` | 部署提交没 push 到 `$BRANCH`，或分支参数填错 |
| Caddy 一直签不下证书 | 云控制台没放行 80；或 sslip.io 撞上 Let's Encrypt 公共后缀限流，换 `nip.io` 并在 systemd 与 Caddyfile 里同步改 `--trusted-host` |
| 返回 403 / browser-trust 拒绝 | `--trusted-host` 与实际 Host 不一致。Caddyfile 已用 `header_up Host {http.request.host}` 显式透传；换域名时 systemd 和 Caddyfile 两处必须同时改 |
| 流式输出卡住不刷新 | 检查 `flush_interval -1` 是否生效 |
| `/skills`、`/mcp` 返回 404 | 用了旧 Nginx 模板，换成本目录的 Caddyfile |
| App 报连接失败 | 先确认手机能打开 `https://<DOMAIN>` 拿到 404，再核对 Token 与控制台 443 |

### 备选：连泛解析域名都不想要

Let's Encrypt 自 2026-01-15 起正式签发 **IP 地址证书**，可以直接用 `https://<公网IP>`。
代价：证书只有约 160 小时（6 天）、必须走 `shortlived` profile 自动续期、需要 Caddy 2.11.4+
且仍标实验性，还要配 `default_sni`。Ubuntu 22.04 apt 源里的 Caddy 偏旧，得单独升级。
首版建议先用 sslip.io 跑通。

## 关于旧的 tarball 方案

`.dsh-build/deploy/`（已 gitignore）里的 `upload.sh` / `server-setup.sh` 是上一轮产物，
**已废弃**，不要再执行 `bash .dsh-build/deploy/upload.sh`。保留只是作为历史参考，
本目录是唯一有效的部署入口。

服务端就绪后还差两件：`apps/mobile` 缺 `android/` 原生工程与 APK（需 `expo prebuild` +
签名构建）；手机端图片/文件上传 UI（协议侧 `RemoteClient.uploadImage()` → `receiptId` →
`prompt(sessionId, text, receipts)` 已现成，但 `App.tsx` 的 `prompt()` 还没传 receipts，
也缺 `expo-image-picker` / `expo-document-picker` 依赖）。
