/** Native entry for Host setup, Session selection, transcript, and workspace files. */

import * as SecureStore from 'expo-secure-store'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StatusBar,
  StyleSheet, Text, TextInput, View,
} from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { isRecord, type RemoteClient } from '../../cli/src/remote-client.ts'
import type { DisplayRow } from '../../cli/src/remote-presentation.ts'
import { Files } from './Files.tsx'
import { makeClient, type ServerSettings } from './remote.ts'
import { prependHistory, refreshSessions, useRemoteState, watchSession } from './store.ts'
import { TranscriptRow, WorkspaceDiff } from './Transcript.tsx'

const settingsKey = 'dsh-daemon-settings'
type Screen = 'settings' | 'sessions' | 'chat' | 'files'

function Button(props: { label: string; onPress(): void; primary?: boolean; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: props.disabled }} disabled={props.disabled}
      onPress={props.onPress} style={[styles.button, props.primary && styles.primary, props.disabled && styles.disabled]}>
      <Text style={[styles.buttonText, props.primary && styles.primaryText]}>{props.label}</Text>
    </Pressable>
  )
}

function Setup(props: { initial: ServerSettings | undefined; onSave(value: ServerSettings): Promise<void> }) {
  const [url, setUrl] = useState(props.initial?.url ?? '')
  const [token, setToken] = useState(props.initial?.token ?? '')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <View style={styles.setup}>
      <Text style={styles.headline}>连接你的 DSH</Text>
      <Text style={styles.secondary}>填写服务器地址和管理员令牌，即可接续服务器上的开发会话。</Text>
      <TextInput accessibilityLabel="服务器地址" autoCapitalize="none" autoCorrect={false}
        keyboardType="url" value={url} onChangeText={setUrl} placeholder="https://dsh.example.com" style={styles.field} />
      <TextInput accessibilityLabel="访问令牌" autoCapitalize="none" autoCorrect={false} secureTextEntry
        value={token} onChangeText={setToken} placeholder="访问令牌" style={styles.field} />
      {notice !== '' && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
      <Button label={busy ? '正在连接…' : '连接服务器'} primary disabled={busy || url.trim() === '' || token.trim() === ''}
        onPress={() => {
          setBusy(true)
          setNotice('')
          void props.onSave({ url: url.trim(), token: token.trim() }).catch((error: unknown) => {
            setNotice(error instanceof Error ? error.message : String(error))
          }).finally(() => { setBusy(false) })
        }} />
    </View>
  )
}

function SessionList(props: { choose(id: string): void; refresh(): void; create(): void; busy: boolean }) {
  const sessions = useRemoteState(state => state.sessions)
  return (
    <FlatList contentContainerStyle={styles.list}
      data={sessions.filter(session => session.origin !== 'subagent')}
      keyExtractor={item => item.sessionId}
      refreshing={props.busy} onRefresh={props.refresh}
      ListHeaderComponent={<Button label="新建会话" onPress={props.create} disabled={props.busy} />}
      ListEmptyComponent={<Text style={styles.secondary}>这里还没有会话</Text>}
      renderItem={({ item }) => (
        <Pressable accessibilityRole="button" onPress={() => { props.choose(item.sessionId) }} style={styles.session}>
          <Text numberOfLines={1} style={styles.sessionTitle}>{item.cwd?.split(/[\\/]/u).at(-1) ?? '会话'}</Text>
          <Text numberOfLines={1} style={styles.secondary}>{item.running ? '运行中 · ' : ''}{item.sessionId}</Text>
        </Pressable>
      )} />
  )
}

function Conversation(props: {
  client: RemoteClient
  sessionId: string
  onFile(path: string): void
  historySignal: AbortSignal | undefined
}) {
  const { client, sessionId, onFile, historySignal } = props
  const transcript = useRemoteState(state => state.transcript)
  const active = useRemoteState(state => state.active)
  const status = useRemoteState(state => state.status)
  const streamNotice = useRemoteState(state => state.notice)
  const approvals = useRemoteState(state => state.approvals)
  const list = useRef<FlatList<DisplayRow>>(null)
  const pinned = useRef(true)
  const [draft, setDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [sending, setSending] = useState(false)
  const [paging, setPaging] = useState(false)
  const [answering, setAnswering] = useState(false)
  const live = active?.rows ?? []
  const send = (): void => {
    const text = draft.trim()
    if (text === '' || sending) return
    setSending(true)
    setNotice('')
    void client.prompt(sessionId, text).then(() => {
      setDraft(current => current.trim() === text ? '' : current)
      pinned.current = true
    }).catch((error: unknown) => { setNotice(String(error)) }).finally(() => { setSending(false) })
  }
  const answer = (id: string, choice: 'allowed-once' | 'rejected'): void => {
    setAnswering(true)
    void client.answer(id, choice).catch((error: unknown) => { setNotice(String(error)) }).finally(() => { setAnswering(false) })
  }
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.fill}>
      <View style={styles.status}>
        <Text numberOfLines={1} style={styles.secondary}>{status === 'connected' ? '已连接' : status === 'connecting' ? '连接中…' : '连接断开'} · {sessionId}</Text>
      </View>
      <FlatList ref={list} data={transcript.rows} keyExtractor={row => row.key}
        contentContainerStyle={styles.transcript} keyboardShouldPersistTaps="handled"
        maintainVisibleContentPosition={{ minIndexForVisible: 1 }}
        onScroll={({ nativeEvent: event }) => {
          pinned.current = event.contentSize.height - event.layoutMeasurement.height - event.contentOffset.y < 100
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => { if (pinned.current) list.current?.scrollToEnd({ animated: false }) }}
        ListHeaderComponent={transcript.hasMore ? <Button label="加载更早的消息" disabled={paging}
          onPress={() => {
            if (historySignal === undefined) return
            setPaging(true)
            pinned.current = false
            void prependHistory(client, sessionId, historySignal).catch((error: unknown) => {
              setNotice(String(error))
            }).finally(() => { setPaging(false) })
          }} /> : undefined}
        ListEmptyComponent={status === 'connecting' && live.length === 0 ? <ActivityIndicator /> : undefined}
        ListFooterComponent={<View style={styles.live}>{live.map(row => <TranscriptRow key={row.key} row={row} onFile={onFile} />)}</View>}
        renderItem={({ item }) => item.changesSeq === undefined ? <TranscriptRow row={item} onFile={onFile} />
          : <WorkspaceDiff client={client} sessionId={sessionId} seq={item.changesSeq} title={item.text} />}
      />
      {approvals.map(approval => (
        <View key={approval.id} style={styles.approval}>
          <Text style={styles.sessionTitle}>审批 · {approval.tool}</Text>
          <Text style={styles.secondary}>{approval.sessionId} · {approval.reason}</Text>
          <View style={styles.actions}>
            <Button label="拒绝" disabled={answering} onPress={() => { answer(approval.id, 'rejected') }} />
            <Button label="仅允许这次" primary disabled={answering} onPress={() => { answer(approval.id, 'allowed-once') }} />
          </View>
        </View>
      ))}
      {(notice || streamNotice) !== '' && <Text accessibilityRole="alert" style={styles.notice}>{notice || streamNotice}</Text>}
      <View style={styles.composer}>
        <TextInput accessibilityLabel="开发指令" value={draft} onChangeText={setDraft} placeholder="继续这次开发…"
          style={styles.draft} multiline />
        <Button label="发送" primary disabled={sending || status !== 'connected' || draft.trim() === ''} onPress={send} />
      </View>
    </KeyboardAvoidingView>
  )
}

function Main() {
  const [settings, setSettings] = useState<ServerSettings>()
  const [screen, setScreen] = useState<Screen>('settings')
  const [session, setSession] = useState<string>()
  const [artifact, setArtifact] = useState<string>()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const watch = useRef<AbortController | undefined>(undefined)
  const client = useMemo(() => settings === undefined ? undefined : makeClient(settings), [settings])

  useEffect(() => {
    let live = true
    void SecureStore.getItemAsync(settingsKey).then((saved) => {
      if (!live || saved === null) return
      const parsed: unknown = JSON.parse(saved)
      if (!isRecord(parsed) || typeof parsed.url !== 'string' || typeof parsed.token !== 'string') return
      const value = { url: parsed.url, token: parsed.token }
      makeClient(value)
      setSettings(value)
      setScreen('sessions')
    }).catch(() => { if (live) setNotice('无法读取已保存的连接设置') }).finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [])

  useEffect(() => {
    if (client === undefined) return
    void refreshSessions(client).catch((error: unknown) => { setNotice(String(error)) })
  }, [client])

  useEffect(() => {
    if (client === undefined || session === undefined) return
    const controller = new AbortController()
    watch.current = controller
    void watchSession(client, session, controller.signal)
    return () => { controller.abort() }
  }, [client, session])

  const save = async (value: ServerSettings): Promise<void> => {
    await makeClient(value).list()
    await SecureStore.setItemAsync(settingsKey, JSON.stringify(value))
    setNotice('')
    setSession(undefined)
    setSettings(value)
    setScreen('sessions')
  }
  const choose = (id: string): void => { setSession(id); setScreen('chat') }
  const runListAction = (action: () => Promise<unknown>): void => {
    if (busy) return
    setBusy(true)
    setNotice('')
    void action().catch((error: unknown) => { setNotice(String(error)) }).finally(() => { setBusy(false) })
  }
  const openArtifact = useCallback((path: string): void => { setArtifact(path); setScreen('files') }, [])
  let content
  if (loading) content = <ActivityIndicator style={styles.fill} />
  else if (screen === 'settings' || client === undefined) content = <Setup initial={settings} onSave={save} />
  else if (screen === 'files') content = <Files key={artifact ?? 'tree'} client={client} artifact={artifact} />
  else if (screen === 'chat' && session !== undefined) content = (
    <Conversation key={session} client={client} sessionId={session} onFile={openArtifact} historySignal={watch.current?.signal} />
  )
  else content = <SessionList choose={choose} busy={busy}
    refresh={() => { runListAction(() => refreshSessions(client)) }}
    create={() => { runListAction(async () => { choose((await client.create()).sessionId); await refreshSessions(client) }) }} />

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" />
      <View style={styles.header}>
        <Text style={styles.brand}>DeepSeek Harness</Text>
        {client !== undefined && <View style={styles.actions}>
          <Button label={screen === 'chat' ? '会话' : session === undefined ? '会话' : '对话'}
            onPress={() => { setScreen(screen !== 'chat' && session !== undefined ? 'chat' : 'sessions') }} />
          <Button label="文件" onPress={() => { setArtifact(undefined); setScreen('files') }} />
          <Button label="设置" onPress={() => { setScreen('settings') }} />
        </View>}
      </View>
      {notice !== '' && <Text accessibilityRole="alert" style={styles.notice}>{notice}</Text>}
      {content}
    </SafeAreaView>
  )
}

/** @returns the native application within its safe-area provider. */
export default function App() {
  return <SafeAreaProvider><Main /></SafeAreaProvider>
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fcfdff' },
  fill: { flex: 1 },
  header: { minHeight: 55, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#dce3ef' },
  brand: { color: '#243c68', fontSize: 16, fontWeight: '500', flexShrink: 1 },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 5, alignItems: 'center' },
  button: { paddingHorizontal: 9, paddingVertical: 7, minHeight: 40, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  buttonText: { fontSize: 14, color: '#315eaa' },
  primary: { backgroundColor: '#305ca9', paddingHorizontal: 15 },
  primaryText: { color: '#fff' },
  disabled: { opacity: 0.45 },
  setup: { paddingHorizontal: 22, paddingTop: 30, gap: 15 },
  headline: { color: '#203658', fontSize: 23, fontWeight: '500' },
  secondary: { color: '#58657a', fontSize: 13, lineHeight: 19 },
  field: { minHeight: 48, borderWidth: StyleSheet.hairlineWidth, borderColor: '#bccae0', borderRadius: 10, paddingHorizontal: 12, color: '#1a263a' },
  notice: { color: '#973f43', fontSize: 13, paddingHorizontal: 16, paddingVertical: 5 },
  list: { padding: 16, gap: 8 },
  session: { minHeight: 59, paddingVertical: 10, gap: 3, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#dce3ef' },
  sessionTitle: { color: '#233858', fontSize: 15, fontWeight: '500' },
  status: { paddingHorizontal: 18, paddingTop: 8, paddingBottom: 4 },
  transcript: { paddingHorizontal: 26, paddingVertical: 10, gap: 5 },
  live: { gap: 5 },
  composer: { marginHorizontal: 10, marginVertical: 7, flexDirection: 'row', alignItems: 'flex-end', gap: 6, borderRadius: 13, padding: 6, borderWidth: StyleSheet.hairlineWidth, borderColor: '#bdcbe2' },
  draft: { flex: 1, paddingHorizontal: 8, paddingVertical: 8, minHeight: 40, maxHeight: 130, color: '#1a263a' },
  approval: { marginHorizontal: 12, borderRadius: 10, padding: 9, backgroundColor: '#fff5e8', gap: 4 },
})
