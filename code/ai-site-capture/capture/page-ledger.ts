/**
 * 页面线程的「看过哪」账本（2026-10-29）。
 *
 * 增量状态原来只在驱动闭包里（内存）—— 扩展重载 / App 重开就没了 ⇒ 第一轮
 * 必然全量重放，把整段历史又贴进已经在的会话。这里把「会话地址 + 已发送到第几条
 * + 前缀指纹」落到 chrome.storage.local：重开后只要地址还是那条会话、本地历史
 * 前缀没被改过，就能接着只发新增/补记。
 *
 * ⚠️ 账本只回答「页面有没有这段历史」，不回答「页面里的回答是不是最新的」——
 *   页面自己的回答由 `planDelta` 按「紧跟在前缀后的 assistant」识别。
 */
import { conversationPath, type TurnSnapshot } from './delta'

export interface PageLedgerEntry {
  /** 上一轮回复结束时会话地址（判断页面是不是还是那一条线程） */
  url?: string
  /** 已经发给页面的快照条数 */
  count: number
  /** 这些快照的前缀指纹（编辑/压缩/删除后对不上 ⇒ 不认） */
  hash: string
}

const LEDGER_KEY = 'occWebChatPageLedger'

type LedgerMap = Record<string, PageLedgerEntry>

/** 存储键：协议 + 线程（场次 id） */
export function ledgerKey(protocolId: string, threadKey: string): string {
  return `${protocolId}\u0000${threadKey}`
}

/** 稳定指纹：角色 + 文本，FNV-1a 32 位（够用，不追求加密强度） */
export function hashSnapshots(snapshots: TurnSnapshot[]): string {
  let hash = 0x811c9dc5
  for (const m of snapshots) {
    const s = `${m.role}\u0000${m.text}\u0001`
    for (let i = 0; i < s.length; i += 1) {
      hash ^= s.charCodeAt(i)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 恢复「上一轮发到哪」：地址还是那条会话 + 本地历史前缀没被改过才认。
 * 认 ⇒ 返回前缀快照；不认 ⇒ null（调用方退回全量）。
 */
export function restoreDeltaPrefix(
  stored: PageLedgerEntry | null,
  snapshots: TurnSnapshot[],
  pageUrl: string | undefined,
): TurnSnapshot[] | null {
  if (!stored || stored.count <= 0 || stored.count > snapshots.length) return null
  if (conversationPath(stored.url) !== conversationPath(pageUrl)) return null
  if (hashSnapshots(snapshots.slice(0, stored.count)) !== stored.hash) return null
  return snapshots.slice(0, stored.count)
}

interface StorageArea {
  get(key: string): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
}

function storage(): StorageArea | null {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) return null
  return chrome.storage.local as unknown as StorageArea
}

export async function readPageLedger(protocolId: string, threadKey: string): Promise<PageLedgerEntry | null> {
  const area = storage()
  if (!area) return null
  try {
    const got = await area.get(LEDGER_KEY)
    const map = (got?.[LEDGER_KEY] as LedgerMap | undefined) ?? {}
    return map[ledgerKey(protocolId, threadKey)] ?? null
  } catch {
    return null
  }
}

export async function writePageLedger(
  protocolId: string,
  threadKey: string,
  entry: PageLedgerEntry,
): Promise<void> {
  const area = storage()
  if (!area) return
  try {
    const got = await area.get(LEDGER_KEY)
    const map = { ...((got?.[LEDGER_KEY] as LedgerMap | undefined) ?? {}) }
    map[ledgerKey(protocolId, threadKey)] = entry
    await area.set({ [LEDGER_KEY]: map })
  } catch {
    /* 存储失败只影响「重开后还能不能增量」，不影响这一轮 */
  }
}
