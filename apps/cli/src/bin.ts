#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'
import type { RunProfileOptions } from './profile-boot.ts'
import type { LocalTerminal } from './tui-local.ts'

const hasRemoteSettings = (): boolean => [
  process.env.DSH_DAEMON_URL, process.env.DSH_DAEMON_TOKEN, process.env.DSH_DAEMON_TOKEN_FILE,
].some(value => value !== undefined && value !== '')

/** Installation-owned dependencies supplied by a packaged CLI launcher. */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /** Public name used by the terminal client launcher. */
  commandName?: 'dsh-cli'
  /** Permit plugin commands for Desktop's existing profile; reserved for its installed carrier. */
  manageDesktopProfile?: boolean
}

/**
 * Run the public dsh command-line interface.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const version = getDshRuntimeVersion()
  const { commandName, manageDesktopProfile, ...profileOptions } = options
  const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile, commandName)

  switch (invocation.mode) {
    case 'profile': {
      const { runProfile } = await import('./profile-boot.ts')
      const bareClient = commandName === 'dsh-cli' && process.argv.length === 2
      if (bareClient && !hasRemoteSettings() && !process.env.DSH_HOME?.trim()) {
        process.env.DSH_HOME = join(homedir(), '.dsh-cli')
      }
      const environment = loadLayeredEnv('dsh')
      const useLocalTerminal = bareClient && !hasRemoteSettings()
      const profile = useLocalTerminal ? 'daemon' : invocation.profile
      try {
        let localTerminal: LocalTerminal | undefined
        if (useLocalTerminal) {
          const { prepareLocalTerminal } = await import('./tui-local.ts')
          localTerminal = await prepareLocalTerminal(resolveDshHome())
        }
        await runProfile({
          environment,
          profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: localTerminal === undefined ? invocation.args : ['--port', '0'],
          localTerminal,
          ...profileOptions,
        })
      } catch (error) {
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (import.meta.main) {
  await runCli()
}
