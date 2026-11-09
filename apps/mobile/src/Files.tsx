/** Browse the configured daemon workspace and share downloaded artifacts. */

import { randomUUID } from 'expo-crypto'
import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { isRecord, type RemoteClient } from '../../cli/src/remote-client.ts'

interface Entry {
  readonly name: string
  readonly kind: 'file' | 'directory'
}

interface Tree {
  readonly root: string
  readonly entries: readonly Entry[]
}

async function read(client: RemoteClient, path: string, mode: 'list' | 'preview', signal: AbortSignal): Promise<unknown> {
  const request = client.fileRequest(path, mode)
  const response = await fetch(request.url, { headers: request.headers, signal, redirect: 'error' })
  if (!response.ok) throw new Error(`文件请求失败（${response.status}）`)
  return response.json()
}

async function share(client: RemoteClient, path: string): Promise<void> {
  if (!(await Sharing.isAvailableAsync()) || FileSystem.cacheDirectory === null) throw new Error('此设备无法分享文件')
  const folder = `${FileSystem.cacheDirectory}${randomUUID()}/`
  await FileSystem.makeDirectoryAsync(folder)
  try {
    const request = client.fileRequest(path, 'download')
    const name = encodeURIComponent(path.split('/').at(-1) ?? 'artifact')
    const result = await FileSystem.downloadAsync(request.url, folder + name, { headers: { ...request.headers } })
    if (result.status !== 200) throw new Error(`下载失败（${result.status}）`)
    await Sharing.shareAsync(result.uri)
  } finally {
    await FileSystem.deleteAsync(folder, { idempotent: true })
  }
}

/**
 * @param props - connected Host and optional absolute path from an artifact event.
 * @returns an authenticated workspace explorer or artifact preview.
 */
export function Files(props: { client: RemoteClient; artifact: string | undefined }) {
  const { client, artifact } = props
  const [directory, setDirectory] = useState('')
  const [file, setFile] = useState<string>()
  const [tree, setTree] = useState<Tree>()
  const [preview, setPreview] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setNotice('')
    setTree(undefined)
    void read(client, directory, 'list', controller.signal).then((value) => {
      if (!isRecord(value) || typeof value.root !== 'string' || !Array.isArray(value.entries)) {
        throw new Error('服务器返回了无法读取的文件目录')
      }
      const entries = value.entries.filter((entry): entry is Entry => isRecord(entry)
        && typeof entry.name === 'string' && (entry.kind === 'directory' || entry.kind === 'file'))
      if (!controller.signal.aborted) setTree({ root: value.root, entries })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setNotice(String(error))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [client, directory])

  useEffect(() => {
    if (artifact === undefined || tree === undefined) return
    if (!artifact.startsWith(`${tree.root}/`)) {
      setNotice('这个产物位于可下载的工作区之外')
      return
    }
    setFile(artifact.slice(tree.root.length + 1))
  }, [artifact, tree?.root])

  useEffect(() => {
    if (file === undefined) return
    const controller = new AbortController()
    setPreview('')
    setNotice('')
    void read(client, file, 'preview', controller.signal).then((value) => {
      if (!isRecord(value) || typeof value.text !== 'string') throw new Error('服务器返回了无法读取的预览')
      if (!controller.signal.aborted) setPreview(value.text + (value.truncated === true ? '\n\n… 预览已截断' : ''))
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setNotice(String(error))
    })
    return () => { controller.abort() }
  }, [client, file])

  const up = (): void => {
    setNotice('')
    if (file !== undefined) setFile(undefined)
    else setDirectory(directory.split('/').slice(0, -1).join('/'))
  }
  return (
    <View style={styles.frame}>
      <View style={styles.toolbar}>
        <Pressable accessibilityRole="button" onPress={up}><Text style={styles.action}>‹ 返回上级</Text></Pressable>
        {file !== undefined && (
          <Pressable accessibilityRole="button" disabled={sharing} onPress={() => {
            setSharing(true)
            void share(client, file).catch((error: unknown) => { setNotice(String(error)) }).finally(() => { setSharing(false) })
          }}><Text style={styles.action}>{sharing ? '正在下载…' : '下载并分享'}</Text></Pressable>
        )}
      </View>
      <Text numberOfLines={2} style={styles.path}>/{file ?? directory}</Text>
      {notice !== '' && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
      {loading && <ActivityIndicator />}
      <ScrollView>
        {file !== undefined ? <Text selectable style={styles.preview}>{preview}</Text>
          : tree?.entries.map((entry) => {
            const path = directory === '' ? entry.name : `${directory}/${entry.name}`
            return (
              <Pressable key={entry.name} accessibilityRole="button" style={styles.entry} onPress={() => {
                if (entry.kind === 'directory') setDirectory(path)
                else setFile(path)
              }}>
                <Text style={styles.path}>{entry.kind === 'directory' ? '› ' : '· '}{entry.name}</Text>
              </Pressable>
            )
          })}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  frame: { flex: 1, gap: 12, padding: 16 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: 44 },
  action: { color: '#315eaa', fontSize: 15, paddingVertical: 10 },
  path: { fontSize: 14, color: '#253551' },
  notice: { color: '#9d3b41' },
  entry: { minHeight: 44, justifyContent: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#dce3ef' },
  preview: { fontFamily: 'monospace', color: '#23324c', lineHeight: 20 },
})
