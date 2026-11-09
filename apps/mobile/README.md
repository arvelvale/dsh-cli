# DSH mobile

English | [中文](README.zh.md)

The Expo and TypeScript app connects to DSH Daemon over HTTPS and WSS. Use the repository's Node and pnpm versions to run it.

```sh
pnpm install --frozen-lockfile
pnpm --filter @deepseek-ai/dsh-mobile typecheck
pnpm --filter @deepseek-ai/dsh-mobile start
```

Type checking uses generated DSH declarations. Before running from source for the first time, run `pnpm run build:artifacts` from the repository root. Run `pnpm --filter @deepseek-ai/dsh-mobile android` for Android or `pnpm --filter @deepseek-ai/dsh-mobile ios` on macOS for iOS. The device needs a reachable HTTPS Daemon address and its token.

Once connected, you can create and switch Sessions, receive streaming replies, expand reasoning and tool cards, approve tool calls, view available diffs, and browse, download, and share workspace files. The app retains the loaded Session during a disconnect and catches up from the last persisted event on reconnect. Use the history button at the top of the conversation to load older messages.

See the [Daemon deployment guide](../cli/config/DAEMON.md) for server configuration and file access scope.
