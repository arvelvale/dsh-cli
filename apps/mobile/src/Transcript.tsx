/** Native rows for Markdown, tool results, reasoning, and diffs. */

import { memo, useEffect, useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import Markdown, { type RenderRules } from 'react-native-markdown-display'
import Prism from 'prismjs'
import 'prismjs/components/prism-typescript'
import 'prismjs/components/prism-json'
import 'prismjs/components/prism-bash'
import 'prismjs/components/prism-python'
import { changedFiles, unifiedDiff, type ChangedFile, type DisplayRow } from '../../cli/src/remote-presentation.ts'
import type { RemoteClient } from '../../cli/src/remote-client.ts'

const tokenColor: Record<string, string> = {
  comment: '#627078', keyword: '#7250a4', string: '#236c50', number: '#9a561c',
  function: '#295cad', property: '#23658c', operator: '#4d5874',
}

function codeTokens(tokens: readonly (string | Prism.Token)[]): React.ReactNode[] {
  return tokens.map((token, index) => {
    if (typeof token === 'string') return token
    const content = typeof token.content === 'string' ? token.content
      : codeTokens(Array.isArray(token.content) ? token.content : [token.content])
    return <Text key={index} style={{ color: tokenColor[token.type] ?? '#273653' }}>{content}</Text>
  })
}

const markdownRules: RenderRules = {
  fence: (node) => {
    const info = 'sourceInfo' in node && typeof node.sourceInfo === 'string' ? node.sourceInfo : ''
    const language = info.trim().split(/\s+/u)[0] ?? ''
    const grammar = Prism.languages[language]
    return (
      <ScrollView key={node.key} horizontal style={styles.code}>
        <Text selectable style={styles.monospace}>
          {grammar === undefined ? node.content : codeTokens(Prism.tokenize(node.content, grammar))}
        </Text>
      </ScrollView>
    )
  },
}

/**
 * @param props - display row and callback for a workspace artifact path.
 * @returns the native presentation for a single conversation block.
 */
export const TranscriptRow = memo(function TranscriptRow(props: {
  row: DisplayRow
  onFile(path: string): void
}) {
  const { row, onFile } = props
  const [expanded, setExpanded] = useState(false)
  if (row.kind === 'file' && row.path !== undefined) {
    const path = row.path
    return (
      <Pressable accessibilityRole="button" style={styles.card} onPress={() => { onFile(path) }}>
        <Text style={styles.heading}>{row.title}  ›</Text>
        <Text style={styles.monospace}>{row.text}</Text>
      </Pressable>
    )
  }
  if (row.kind === 'assistant' || row.kind === 'user') {
    return (
      <View style={row.kind === 'user' ? styles.user : styles.reply}>
        <Text style={styles.heading}>{row.title}</Text>
        <Markdown rules={markdownRules} style={markdownStyle} onLinkPress={() => false}>{row.text}</Markdown>
      </View>
    )
  }
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => { setExpanded(!expanded) }}>
        <Text style={[styles.heading, row.kind === 'error' && styles.removed]}>{expanded ? '⌄' : '›'}  {row.title}</Text>
      </Pressable>
      {expanded && (row.kind === 'diff'
        ? <DiffLines text={row.text} />
        : <Text selectable style={row.kind === 'reasoning' ? styles.reasoning : styles.monospace}>{row.text}</Text>)}
    </View>
  )
})

function DiffLines(props: { text: string }) {
  return (
    <ScrollView horizontal><View>{props.text.split('\n').map((line, index) => (
      <Text key={index} selectable style={[
        styles.monospace, line.startsWith('+') && styles.added, line.startsWith('-') && styles.removed,
      ]}>{line}</Text>
    ))}</View></ScrollView>
  )
}

/** @param props - original Session and journal coordinates of a Desktop workspace diff. */
export function WorkspaceDiff(props: { client: RemoteClient; sessionId: string; seq: number; title: string }) {
  const { client, sessionId, seq, title } = props
  const [expanded, setExpanded] = useState(false)
  const [index, setIndex] = useState<number>()
  const [files, setFiles] = useState<readonly ChangedFile[]>([])
  const [diff, setDiff] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    if (!expanded) return
    const controller = new AbortController()
    setDiff('')
    setNotice('')
    setLoading(true)
    void client.changes(sessionId, seq, index, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      if (index === undefined) setFiles(changedFiles(result))
      else setDiff(unifiedDiff(result))
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : String(error))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => { controller.abort() }
  }, [client, sessionId, seq, index, expanded])
  return (
    <View style={styles.card}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => { setExpanded(!expanded) }}>
        <Text style={styles.heading}>{expanded ? '⌄' : '›'}  工作区差异 · {title}</Text>
      </Pressable>
      {expanded && (
        <>
          {loading && <ActivityIndicator />}
          {notice !== '' && <Text accessibilityRole="alert" style={styles.removed}>{notice}</Text>}
          {index === undefined ? files.map(file => (
            <Pressable key={file.index} accessibilityRole="button" style={styles.change} onPress={() => { setIndex(file.index) }}>
              <Text style={styles.monospace}>{file.label}</Text>
            </Pressable>
          )) : (
            <>
              <Pressable accessibilityRole="button" style={styles.change} onPress={() => { setIndex(undefined) }}>
                <Text style={styles.heading}>‹ 返回文件列表</Text>
              </Pressable>
              <DiffLines text={diff} />
            </>
          )}
        </>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  heading: { color: '#385381', fontSize: 13, fontWeight: '500' },
  reply: { paddingVertical: 8 },
  user: { paddingVertical: 8, paddingHorizontal: 12, borderRadius: 14, backgroundColor: '#eef3ff', marginLeft: 28 },
  card: { gap: 7, borderRadius: 10, borderColor: '#dde3ee', borderWidth: StyleSheet.hairlineWidth, padding: 9 },
  reasoning: { color: '#576276', fontSize: 14, lineHeight: 21 },
  monospace: { fontFamily: 'monospace', color: '#273653', fontSize: 12, lineHeight: 19 },
  code: { borderRadius: 8, backgroundColor: '#f0f3f8', padding: 10 },
  change: { minHeight: 36, justifyContent: 'center' },
  added: { color: '#216f4c', backgroundColor: '#e9f6ee' },
  removed: { color: '#9d3b41', backgroundColor: '#fceff0' },
})

const markdownStyle = {
  body: { color: '#1a263a', fontSize: 15, lineHeight: 23 },
  code_inline: { color: '#385381', backgroundColor: '#edf2fb' },
}
