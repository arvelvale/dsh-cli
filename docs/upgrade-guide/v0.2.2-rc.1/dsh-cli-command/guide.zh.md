---
kind: upgrade-guide
description: "DSH CLI 安装后使用 dsh-cli 命令，取代原来的 dsh。"
---

# 使用 `dsh-cli` 启动 DSH CLI

[English](guide.md) | 中文

## 变更

DSH CLI 安装后注册 `dsh-cli`，因此可与上游 Harness 安装在同一命令搜索路径中。运行 `dsh-cli` 会启动本地 Host 并打开终端客户端。已设置 Daemon 连接信息时，会接入指定的 Host。

## 迁移

1. 将启动脚本中的 `dsh daemon` 改为 `dsh-cli daemon`。从源码运行时，把服务命令中的 `lib/bin.js daemon` 改为 `lib/dsh-cli.js daemon`，或使用[服务模板](../../../../apps/cli/config/dsh-daemon.service)。
2. 在本机对话时运行 `dsh-cli`。如果要连接已有的 Daemon，先配置连接信息，再将 `dsh tui` 改为 `dsh-cli tui`。例如，运行 `dsh-cli tui --session <id>` 接续指定会话。
3. 运行 `dsh-cli --version` 查看客户端版本。从源码目录执行 `pnpm dsh-cli --version`。
