# DSH 移动端

[English](README.md) | 中文

Expo 与 TypeScript 应用，通过 HTTPS 和 WSS 连接 DSH Daemon。运行项目时使用仓库的 Node 和 pnpm 版本。

```sh
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-mobile typecheck
pnpm --filter @deepseek-ai/dsh-mobile start
```

类型检查使用 DSH 的生成声明。第一次从源码运行时，先在仓库根目录执行 `pnpm run build:artifacts`。用 Android 设备运行 `pnpm --filter @deepseek-ai/dsh-mobile android`。在 macOS 上可以运行 `pnpm --filter @deepseek-ai/dsh-mobile ios`。移动端需要设备能访问的 HTTPS Daemon 域名和对应 Token。

配置服务器后，可创建或切换会话、接收实时回复、展开思考和工具卡片、审批工具调用、查看可用的编辑差异，并浏览工作区及下载分享文件。断线期间保留已加载的会话，重连从最后持久事件的位置补齐。切换到较旧的会话后，使用对话顶部的历史加载按钮查看更早的消息。

服务器配置和文件范围见 [Daemon 部署说明](../cli/config/DAEMON.md)。
