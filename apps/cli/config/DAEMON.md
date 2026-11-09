# DSH 守护进程与远程客户端

`dsh daemon` 使用同一套 Web Host、Gateway 和会话存储为 TUI 与移动端提供服务。它在前台运行，由 systemd 管理，固定监听 `127.0.0.1`。一个 `DSH_HOME` 只运行一个写入会话的 Host。客户端退出后，正在执行的 turn 继续由 Host 管理。

## 在 Linux 启动

1. 在仓库根目录使用 Node 24.9+ 和仓库指定的 pnpm 版本，运行 `pnpm install --frozen-lockfile` 和 `pnpm run build`。
2. 准备一个专用服务用户、可写的工作区和独立的 `DSH_HOME`。用 `umask 077; node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))' > daemon-token` 生成 43 字符 Token 文件。模型凭证继续通过 Host 配置提供。
3. 设置 `DSH_DAEMON_TOKEN_FILE` 指向该文件。需要导出工作区文件时，将 `DSH_DAEMON_WORKSPACE` 设为要导出的目录。从工作区执行 `node /opt/deepseek-harness/apps/cli/lib/bin.js daemon --port 3080 --trusted-host dsh.example.com`。
4. 长期运行时，按实际目录、Node 路径、服务用户和域名调整 [systemd 服务](dsh-daemon.service)。将 Token 放在 `LoadCredential` 指定的位置，将模型环境变量放入可选的 `provider.env`。安装后运行 `systemctl daemon-reload` 和 `systemctl enable --now dsh-daemon`，用 `journalctl -u dsh-daemon` 查看启动信息。
5. 按域名及证书位置调整 [Nginx 模板](dsh-nginx.conf)，执行 `nginx -t`，再由 Nginx 暴露 HTTPS 和 WSS。默认只转发客户端使用的 HTTP 接口与原生 WebSocket 路由。更换 Token 文件后重启 Daemon。

## 连接

在 SSH 中设置 `DSH_DAEMON_TOKEN_FILE` 指向客户端可读的 Token 文件，运行 `dsh tui` 或 `dsh tui --session <id>`。也可使用 `--url https://dsh.example.com` 连接 Nginx。输入 `/help` 查看会话切换、思考折叠、Git 差异和审批命令。源码检出中使用 `pnpm dsh tui`。

交互式终端启动时在蓝色的 `DSH CLI` 字标旁显示客户端版本，也可以运行 `dsh tui --version` 查看。输入 `/` 后连按两次 Tab 可列出命令，继续输入前缀可缩小候选范围。用 `/status` 查看连接、当前会话、模型和 API Key 是否已配置。用 `/login` 打开隐藏输入，保存的 DeepSeek API Key 由 Host 的原有凭证服务管理，并用于后续模型请求。Daemon Token 仍通过启动环境或 Token 文件提供。

在输入框里按 `Alt+V`（Windows）或 `Ctrl+V`（macOS、Linux），也可用 `/paste` 将剪贴板图片加入草稿。回车时图片与文字一同发送，只有图片时也可以直接回车。用 `/images` 查看附件，`/images clear` 清空草稿。Windows 使用系统剪贴板，macOS 需要 `pngpaste`，Linux 桌面使用 `wl-paste`（Wayland）或 `xclip`（X11）。剪贴板属于运行 TUI 的机器。连接远端 Daemon 时可在自己的桌面终端运行 `dsh tui --url https://dsh.example.com`，粘贴电脑上的截图。

用 `/image "/path/to/screenshot.png"` 添加文件。通过 SSH 启动 TUI 时，路径指向 SSH 服务器上的文件。命令支持 PNG、JPEG、WebP 和 GIF。发送图片时，模型须支持图像输入。

输入 `/model` 并回车打开模型菜单。可输入关键词筛选，用上下键选中、回车切换，或按 Esc 取消。也可直接用 `/model 提供方 模型` 指定。

在手机 App 的设置页填写 HTTPS 域名和同一个 Token。设置保存在设备的安全存储中。打开会话列表即可接续同一 Host 的会话。[移动端构建说明](../../mobile/README.zh.md)

Token 代表同一个 Host 管理员。每个持有者可以通过 Agent 执行该服务用户和 DSH 沙箱授权的操作。文件浏览另外限定到显式配置的工作区，跳过隐藏项，拒绝目录逃逸。预览返回至多 128 KiB 的 UTF-8 文本，下载接受至多 100 MiB 的普通文件。产物链接可下载工作区内的文件。文件路由使用 Linux 文件描述符验证打开后的路径。

## 会话通信参考

[共享类型](../src/remote-contract.ts)从 Host Session controller 导出持久 `SessionEvent` 的 wire 形式，并复用模型层的 `Message`。桌面端使用的 `session/follow` 在同一个 WSS 多路复用连接中提供开场窗口、后续持久事件以及实时 Assistant 片段。客户端以持久 `seq` 作为游标，用 `session/events` 补齐超过开场窗口的缺口。Assistant 活动快照有独立 revision，持久事件接替实时片段。Host 硬退出时，尚未提交的实时片段随进程结束。

HTTP 的 Session 请求由 `/api/session/*` 接收，WSS 使用 `/api/remote.mux`。两个入口共享 Connection 的 Host/Origin 检查和 Bearer 鉴权。审批通过同一连接的 `$events` 转发，由 Host 仲裁先收到的有效决定。文件接口为 `GET /api/daemon.files?mode=list|preview|download&path=<相对路径>`。

终端和手机渲染文本、思考、工具调用与结果、子代理状态及产物链接。工作区变更通过桌面端原有的 `changes.summary` 和 `changes.diff` 获取，随 Host 保留的变更快照可用。桌面插件特有的卡片、对话节点扩展和富媒体预览需要各自的平台渲染实现。
