/** React Native adapters for the shared remote client. */

import { randomUUID } from 'expo-crypto'
import { RemoteClient } from '../../cli/src/remote-client.ts'

/** User-supplied HTTPS origin and administrator token. */
export interface ServerSettings {
  readonly url: string
  readonly token: string
}

// React Native accepts headers in the third constructor argument.
const NativeWebSocket = WebSocket as typeof WebSocket & {
  new (url: string, protocols: null, options: { headers: Readonly<Record<string, string>> }): WebSocket
}

/**
 * @param settings - validated by the portable client before it sends credentials.
 * @returns an isolated native client for one selected conversation.
 */
export function makeClient(settings: ServerSettings): RemoteClient {
  if (!settings.url.startsWith('https://')) throw new Error('请填写以 https:// 开头的服务器地址')
  return new RemoteClient(settings.url, settings.token, {
    id: randomUUID,
    socket: (url, headers) => new NativeWebSocket(url, null, { headers }),
  })
}
