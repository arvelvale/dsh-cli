---
kind: upgrade-guide
description: "The DSH CLI installation now provides dsh-cli in place of dsh."
---

# Launch DSH CLI with `dsh-cli`

English | [中文](guide.zh.md)

## Change

The DSH CLI installation now registers `dsh-cli` so it can share a command path with the upstream Harness installation. Running `dsh-cli` starts a local Host and opens the terminal client. With Daemon connection settings, it attaches to the configured Host.

## Migration

1. Replace `dsh daemon` with `dsh-cli daemon` in startup scripts. For a source checkout, update service commands from `lib/bin.js daemon` to `lib/dsh-cli.js daemon` or use the [service template](../../../../apps/cli/config/dsh-daemon.service).
2. Run `dsh-cli` for a local conversation. To connect to a running Daemon, configure its connection settings and replace `dsh tui` with `dsh-cli tui`. For example, run `dsh-cli tui --session <id>` to resume a specific session.
3. Run `dsh-cli --version` to check the client version. From a source checkout, use `pnpm dsh-cli --version`.
