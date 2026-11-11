/** Own the local terminal Host's temporary credential and exclusive writer lock. */

import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

/** Hold the local data directory until the mounted Host has disposed. */
export interface LocalTerminal {
  close(): Promise<void>
}

/**
 * Prepare an authenticated loopback Host before mounting the daemon profile.
 * @param home - data directory for the managed Host.
 * @returns The owner of the credential and lock, to be closed after the Host.
 */
export async function prepareLocalTerminal(home: string): Promise<LocalTerminal> {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const acquired = Promise.withResolvers<void>()
  const released = Promise.withResolvers<void>()
  const lock = withFileLock(join(home, 'local-daemon'), async () => {
    acquired.resolve()
    await released.promise
  })
  await Promise.race([acquired.promise, lock])

  let directory: string | undefined
  let tokenFile: string | undefined
  let closed: Promise<void> | undefined
  const close = (): Promise<void> => closed ??= (async () => {
    try {
      if (tokenFile !== undefined) {
        if (process.env.DSH_DAEMON_TOKEN_FILE === tokenFile) delete process.env.DSH_DAEMON_TOKEN_FILE
        await rm(tokenFile, { force: true })
      }
      if (directory !== undefined) await rmdir(directory)
    } finally {
      released.resolve()
      await lock
    }
  })()
  try {
    directory = await mkdtemp(join(tmpdir(), 'dsh-cli-local-'))
    tokenFile = join(directory, 'daemon-token')
    await writeFile(tokenFile, randomBytes(32).toString('base64url'), { mode: 0o600, flag: 'wx' })
    process.env.DSH_DAEMON_TOKEN_FILE = tokenFile
    return { close }
  } catch (error) {
    try { await close() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], '本地 Host 初始化和清理失败')
    }
    throw error
  }
}
