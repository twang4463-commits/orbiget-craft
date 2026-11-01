#!/usr/bin/env node
/**
 * 近重复文件扫描（开发期脚本，不进构建）
 *
 * 起因：2026-09-27 连着清出两个「已被取代但没人删」的整文件 ——
 * BrainstormSidePanel.vue（554 行，被 BrainstormRightPanel 覆盖）与
 * StoryboardGrid.vue（587 行，被 StoryboardWorkspace 取代）。两者都**零引用**，
 * 所以 scan-vue-orphans 抓得到；但如果哪天是「两份都在用、只是慢慢分叉」，
 * 孤儿扫描就看不见了 —— 那正是 CLAUDE.md 铁律 4 要防的
 * 「改一处漏一处、每次视觉迭代都得改两遍」。
 *
 * 判据：**归一化后的 Jaccard 相似度**。
 *   归一化：去注释、去空白、把连续标识符压成一个 token —— 这样
 *   `const a = 1` 与 `const   b   =   2` 的 token 集合长得一样，
 *   度量的是**结构**而不是字面。
 *   只比 .vue 与 .ts；文件太小（<25 行）噪声太大，排除。
 *
 * 输出按相似度降序，≥ 阈值（默认 0.55）即列出。用法：
 *   node scan-duplicate-files.mjs [目录...] [阈值] [--show]   ← 缺省扫当前目录
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 扫描根：位置参数里的目录，缺省扫当前目录（自动跳过 node_modules / dist / .git） */
const ROOTS = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const walkRoots = (roots, accept) => {
  const out = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const n of entries) {
      if (n === 'node_modules' || n === 'dist' || n === '.git') continue
      const p = join(dir, n)
      let st
      try { st = statSync(p) } catch { continue }
      if (st.isDirectory()) walk(p)
      else if (accept(n)) out.push(p)
    }
  }
  for (const root of roots) walk(root)
  return out
}

const THRESHOLD = Number(process.argv.find((a) => /^\d*\.?\d+$/.test(a)) ?? 0.55)
const SHOW = process.argv.includes('--show')
const MIN_LINES = 25

/** 归一化成 token 集合：去注释 → 抽出所有标识符/字符串字面量 */
function tokens(src) {
  const noCmt = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ')
  const set = new Set()
  for (const m of noCmt.matchAll(/[A-Za-z_$][\w$-]*|'[^']*'|"[^"]*"|`[^`]*`|\d+/g)) set.add(m[0])
  return set
}

const files = []
for (const p of walkRoots(ROOTS.length ? ROOTS : ["."], (n) => /\.(vue|ts)$/.test(n))) {
  const src = readFileSync(p, 'utf8')
  const lines = src.split(/\r?\n/).length
  if (lines < MIN_LINES) continue
  files.push({ p: p.replace(/\\/g, '/'), lines, t: tokens(src) })
}

function jaccard(a, b) {
  let inter = 0
  const [small, big] = a.size <= b.size ? [a, b] : [b, a]
  for (const x of small) if (big.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

const pairs = []
for (let i = 0; i < files.length; i++) {
  for (let j = i + 1; j < files.length; j++) {
    const s = jaccard(files[i].t, files[j].t)
    if (s >= THRESHOLD) pairs.push({ a: files[i], b: files[j], s })
  }
}
pairs.sort((x, y) => y.s - x.s)

console.log(`扫描 ${files.length} 个文件（≥${MIN_LINES} 行）；相似度 ≥ ${THRESHOLD} 的成对：${pairs.length}\n`)
for (const { a, b, s } of pairs) {
  console.log(`  ${(s * 100).toFixed(1)}%  ${a.p} (${a.lines})  ⇄  ${b.p} (${b.lines})`)
  if (SHOW) {
    const onlyA = [...a.t].filter((x) => !b.t.has(x)).slice(0, 14)
    const onlyB = [...b.t].filter((x) => !a.t.has(x)).slice(0, 14)
    console.log(`        只在 A：${onlyA.join(' ')}`)
    console.log(`        只在 B：${onlyB.join(' ')}`)
  }
}
