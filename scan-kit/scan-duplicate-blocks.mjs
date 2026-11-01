#!/usr/bin/env node
/**
 * 重复声明块扫描（开发期脚本，不进构建）—— `scan-duplicate-controls.mjs` 的补集。
 *
 * 那个脚本只认「纯单类选择器」（`^\.a(\.b)*$`），于是两类真实重复它看不见：
 *   ① **后代/子代选择器**：`.a .b`、`.a > .b`、`.a button`
 *   ② **成组选择器**：`.a,\n.b { … }`
 * 踩过的实例：`.iaw-pos-seg button` / `.iaw-pos-seg button.on` / `:hover` 三条
 * 与小说侧逐字节相同，报告里只有容器那一条 —— **真实重复量是报告的两倍**。
 *
 * 本脚本放宽到**任意选择器**（仍排除含 `:deep()`/`:global()` 的规则，那是 SFC
 * 编译期伪类，浏览器不认），按「归一化后的声明串」分组，报出跨 ≥2 文件者。
 *
 * ⚠️ 假阳性是**预期的**：父子组件各自声明「同一条规则」常常是有意的（子组件不该
 * 依赖父组件的样式作用域）。所以本脚本的产出是**待人眼过一遍的线索**，不是待办清单。
 *
 * 用法：node scan-duplicate-blocks.mjs [--root=src] [--values] [--min N] [--min-decls=3]
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = (process.argv.find((a) => a.startsWith('--root='))?.split('=')[1]) || 'src'
const SHOW_VALUES = process.argv.includes('--values')
const minArg = process.argv.find((a) => a.startsWith('--min='))
const MIN = minArg ? Number(minArg.split('=')[1]) : 2
// 一条声明的「重复」没有意义（`display:flex` 谁都写）—— 沿用
// scan-duplicate-controls 的门槛：至少 3 条声明。
const minDeclsArg = process.argv.find((a) => a.startsWith('--min-decls='))
const MIN_DECLS = minDeclsArg ? Number(minDeclsArg.split('=')[1]) : 3

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith('.vue') || p.endsWith('.css')) out.push(p)
  }
  return out
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
}

const NOISE = /^(box-sizing|transition|animation|font-family|cursor|user-select|z-index)$/

/** 拆成 {selector, body}；浅层但够用（规则体内无嵌套的现代 CSS）
 *
 * ⚠️ 这函数第一版错了**两次**，两次都表现为「恒报 0」，都不是靠读代码发现的：
 *   ① `head.replace(/[^{}]*$/, '')` 想切掉「上一条规则的残留」，结果把**整条选择器**
 *      也吃掉了（选择器里没有花括号，末尾整段都是「非花括号字符」）。
 *   ② 修成「`start` 取 '{' 的下标」后，`css.slice(start, i)` **从花括号开始**，
 *      `s.indexOf('{')` 恒为 0 ⇒ `selector` 恒是空串 ⇒ 每条都被
 *      `selector.length < 2` 跳过。
 *      正确的起点是**上一条规则闭合 '}' 之后**，不是 '{' 自己。
 * ⇒ 教训见 spec §5：新写检测器，**先证明它能报错**，再相信它报 0。
 */
function parseRules(css) {
  const refined = []
  let d = 0
  let ruleStart = 0
  for (let i = 0; i < css.length; i++) {
    if (css[i] === '{') {
      d++
      continue
    }
    if (css[i] === '}') {
      if (d === 1) {
        const s = css.slice(ruleStart, i)
        const braceAt = s.indexOf('{')
        if (braceAt > 0) refined.push({ selector: s.slice(0, braceAt).trim(), body: s.slice(braceAt + 1) })
      }
      d--
      if (d === 0) ruleStart = i + 1
    }
  }
  return refined
}

function norm(body) {
  const list = body
    .split(';')
    .map((d) => d.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((d) => !NOISE.test(d.split(':')[0].trim()))
    .map((d) => d.replace(/:\s*/, ':'))
    .sort()
  return { key: list.join(';'), n: list.length }
}

const groups = new Map()
for (const file of walk(ROOT)) {
  const src = readFileSync(file, 'utf8')
  // .vue 取 <style> 块；.css 整个文件就是一份 css
  const cssChunks = file.endsWith('.css') ? [src] : [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  for (const cssRaw of cssChunks) {
    const css = stripComments(cssRaw)
    // SFC 编译期伪类：浏览器不认，整条丢弃（否则它们的选择器会让分组失真）
    const cleaned = css.replace(/([^{}]+)\{[^{}]*:(?:deep|global)\([^{}]*\}[^{}]*\}/g, '')
    for (const rule of parseRules(cleaned)) {
      if (!rule.selector || rule.selector.length < 2) continue
      if (rule.selector.includes('&') || rule.selector.includes('@')) continue
      const { key, n } = norm(rule.body)
      if (n < MIN_DECLS) continue
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push({ file: relative(ROOT, file).replace(/\\/g, '/'), sel: rule.selector })
    }
  }
}

const dupes = [...groups.entries()]
  .map(([decls, list]) => ({ decls, list, files: new Set(list.map((x) => x.file)) }))
  .filter((g) => g.files.size >= MIN && g.list.length > g.files.size ? true : g.files.size >= MIN)
  .sort((a, b) => b.files.size - a.files.size || b.decls.length - a.decls.length)

console.log(`跨 ≥${MIN} 文件的重复声明块：${dupes.length} 组\n`)
for (const g of dupes.slice(0, 40)) {
  const sels = [...new Set(g.list.map((x) => x.sel.replace(/\s+/g, ' ')))].slice(0, 4)
  console.log(`  ${g.files.size} 文件 / ${g.list.length} 处`)
  for (const x of g.list.slice(0, 8)) console.log(`      ${x.sel.replace(/\s+/g, ' ').slice(0, 60).padEnd(62)} ${x.file}`)
  if (SHOW_VALUES) console.log(`      声明：${g.decls.slice(0, 150)}`)
  console.log()
}
console.log(`（共 ${dupes.length} 组；假阳性是预期的 —— 父子组件各自声明同一条规则常是有意的。产出是线索，不是待办清单。）`)
