/**
 * 页面线程账本（2026-10-29）：重开后还能不能接着只发新增。
 *
 * 守的规则：
 * · 地址还是那条会话 + 本地前缀没改 ⇒ 认账本，接着发；
 * · 用户开了新对话 / 地址变了 ⇒ 不认（页面里的历史不是我们的了）；
 * · 本地历史被编辑 / 压缩过 ⇒ 不认（前缀对不上）；
 * · 没有账本 ⇒ 不认（第一轮全量）。
 */
import { describe, expect, it } from 'vitest'
import { hashSnapshots, ledgerKey, restoreDeltaPrefix } from '../capture/page-ledger'

describe('page-ledger · 重开后恢复「页面看过哪」', () => {
  const snapshots = [
    { role: 'user', text: '第一问' },
    { role: 'assistant', text: '第一答' },
    { role: 'user', text: '第二问' },
  ]
  const entry = {
    url: 'https://chat.deepseek.com/a/chat/s/abc',
    count: 2,
    hash: hashSnapshots(snapshots.slice(0, 2)),
  }

  it('地址还是那条会话 + 前缀没改 ⇒ 恢复前缀', () => {
    expect(restoreDeltaPrefix(entry, snapshots, entry.url)).toEqual(snapshots.slice(0, 2))
  })

  it('会话地址变了（用户开了新对话）⇒ 不认', () => {
    expect(restoreDeltaPrefix(entry, snapshots, 'https://chat.deepseek.com/a/chat/s/xyz')).toBeNull()
    expect(restoreDeltaPrefix(entry, snapshots, 'https://chat.deepseek.com/')).toBeNull()
  })

  it('本地历史前缀被改过（编辑 / 压缩）⇒ 不认', () => {
    const edited = [{ role: 'user', text: '第一问（改过）' }, ...snapshots.slice(1)]
    expect(restoreDeltaPrefix(entry, edited, entry.url)).toBeNull()
  })

  it('账本条数比现在多（历史被删短）⇒ 不认', () => {
    expect(restoreDeltaPrefix({ ...entry, count: 9 }, snapshots, entry.url)).toBeNull()
  })

  it('没有账本 ⇒ 不认（第一轮全量）', () => {
    expect(restoreDeltaPrefix(null, snapshots, entry.url)).toBeNull()
  })

  it('指纹稳定：同内容同指纹，改一个字就变', () => {
    expect(hashSnapshots(snapshots)).toBe(hashSnapshots([...snapshots]))
    expect(hashSnapshots(snapshots)).not.toBe(hashSnapshots([{ role: 'user', text: '第一问!' }]))
  })

  it('存储键按协议 + 线程分开', () => {
    expect(ledgerKey('deepseek-web', 's1')).not.toBe(ledgerKey('doubao-web', 's1'))
    expect(ledgerKey('deepseek-web', 's1')).not.toBe(ledgerKey('deepseek-web', 's2'))
  })
})
