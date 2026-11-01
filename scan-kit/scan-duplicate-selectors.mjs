/**
 * 同一个选择器在**同一个样式文件**里被定义了几次（基类块）。
 *
 * 为什么值得单扫：`check-one-family-one-source` 比的是**跨文件**的家族重复，
 * 而"同一份 ui.css 里同一个选择器写了两遍"从它下面钻过去 —— 后果一样静默：
 * **后一份整体压前一份**（同特异性看顺序），前一份的值看着权威、其实全是死的。
 *
 * 实测（2026-09-27）：`.ot-field__input` 在 ui.css 里出现两次 ——
 *   L68  `padding: 0 var(--ot-spacing-md)`（16px）· `font-size: 12px` · `--ot-font-ui`
 *   L594 `padding: 0 var(--ot-spacing-sm)`（10px）· `--ot-font-size-sm` · `--ot-font-sans`
 * 两处特异性相同 ⇒ **L594 整体压 L68**，真实生效的是 10px / sm / sans。
 * 也就是说 L68 那几条"看着是权威定义"的值从来没生效过，谁去改它都改不动东西。
 *
 * ⚠️ 三条必须做对，否则报出来的是噪声（第一版全踩了）：
 *   ① **展开选择器组**：`.ot-field__input, .ot-field select { … }` 与 `.ot-field__input { … }`
 *      是同一个选择器被定义两次 —— 按整串文本比对会**漏掉**这一对（正是上面那个真案例）。
 *   ② **跳过 at-rule 里的规则**：`@media` 分支里的同名选择器是**响应式覆盖**，不是重复；
 *      `@keyframes` 里的 `from` / `to` / `50%` 更不是选择器。
 *      不跳的话 `.ot-kpi-grid` / `.ot-stat-row` / `to` / `from` 全被误报。
 *   ③ **只在同一 at-rule 上下文里比**：全局的 `.x` 与 `@media` 里的 `.x` 是两回事。
 *
 * 用法：node scripts/scan-duplicate-selectors.mjs [file...]
 *      node scripts/scan-duplicate-selectors.mjs --strict   ← 只报"基类块"（声明 ≥3 条）
 */
import { readFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const STRICT = argv.includes('--strict')
const FILES = argv.filter((a) => !a.startsWith('--'))
const targets = FILES.length
  ? FILES
  : [
      'packages/ui/src/styles/ui.css',
      'packages/ui/src/styles/tokens.css',
      'apps/craft/src/workbench/styles/panel.css',
      'apps/craft/src/workbench/styles/workbench.css',
      'apps/craft/src/styles/shell-reset.css',
    ]

/** 去掉注释（保留换行数，行号才对得上）。不处理字符串里的 `/*` —— CSS 里没有那种东西。 */
function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
}

/**
 * 逐字符扫一遍，维护 at-rule 栈，产出 [{ selector, decl, line, context }]。
 * 手写扫描而不是正则：需要知道"当前在哪个 at-rule 里"以及嵌套大括号的层数。
 */
function collect(css) {
  const out = []
  const stack = [] // at-rule 名（如 '@media (max-width: 900px)' / '@keyframes ot-x'）
  let depth = 0
  let buf = ''
  let line = 1
  let bufLine = 1
  const flushRule = (sel, decl, at) => {
    if (!sel) return
    for (const one of sel.split(',')) {
      const s = one.trim().replace(/\s+/g, ' ')
      if (!s) continue
      out.push({ selector: s, decl: decl.trim().replace(/\s+/g, ' '), line: bufLine, context: at })
    }
  }
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '\n') line++
    if (ch === '{') {
      const head = buf.trim()
      buf = ''
      if (head.startsWith('@')) {
        stack.push({ name: head, line })
        depth++
      } else {
        // 规则体：一直读到配对的 '}'
        let d = ''
        let k = i + 1
        let braces = 1
        for (; k < css.length && braces > 0; k++) {
          const c2 = css[k]
          if (c2 === '\n') line++
          if (c2 === '{') braces++
          else if (c2 === '}') { braces--; if (braces === 0) break }
          d += c2
        }
        const at = stack.length ? stack[stack.length - 1].name : null
        flushRule(head, d, at)
        i = k
      }
      continue
    }
    if (ch === '}') {
      if (buf.trim() === '' && stack.length) stack.pop()
      else if (buf.trim()) { buf = '' }
      depth--
      continue
    }
    if (buf === '') bufLine = line
    buf += ch
  }
  return out
}

let total = 0

/**
 * 分析一份 CSS：返回**真有害**的重复（同一属性被后一块压死）。
 *
 * ⚠️ **"定义了两次"不等于"有东西被压死"** —— 第四版才加的判据。
 * 分散声明（后面那块只补前面没写过的属性）是无害的，只是难看；
 * 真正要修的是**同一属性被写了两次**：前一次的值从此是死的。
 * 不做这个区分的话，报出来的一大半是这个形状：
 *   `.workbench, .wb-route-page, .wb-route-head, … { user-select: none }`
 *   —— 一个组选择器管一大片，每片都"被定义了两次"，但没有一条值失效
 *   （`--update` 时会被这堆噪声淹掉，真问题反而看不见）。
 */
function analyze(raw) {
  const rules = collect(stripComments(raw))
  // ③ 只在同一 at-rule 上下文里比（null = 全局）
  const key = (r) => `${r.context ?? '«global»'} :: ${r.selector}`
  const defs = new Map()
  for (const r of rules) {
    if (!defs.has(key(r))) defs.set(key(r), [])
    defs.get(key(r)).push(r)
  }
  let dups = [...defs.entries()].filter(([, v]) => v.length > 1)
  if (STRICT) dups = dups.filter(([, v]) => v.some((r) => r.decl.split(';').filter(Boolean).length >= 3))

  const propOf = (decl) => decl.split(';').map((d) => d.split(':')[0]?.trim()).filter(Boolean)
  const harmOf = (v) => {
    const seen = new Set()
    const dead = new Set()
    for (const r of v) for (const p of propOf(r.decl)) {
      if (seen.has(p)) dead.add(p)
      seen.add(p)
    }
    return [...dead]
  }
  const harmful = dups
    .map(([k, v]) => [k, v, harmOf(v)])
    .filter(([, , dead]) => dead.length)
  const benign = dups.filter(([, v]) => !harmOf(v).length)
  return { harmful, benign, ruled: dups.length > 0 }
}

// ── 负向对照：证明"它真会报"，且注入必须自检落地 ──
if (argv.includes('--selftest')) {
  const cases = [
    ['同一选择器两块、属性撞车（真有害）', 'a { color: red; padding: 1px; }\n\na { color: blue; }', true],
    ['后块只补新属性（无害，不该报）', 'a { color: red; }\n\na { padding: 1px; }', false],
    ['@media 里的同名（响应式覆盖，不该报）', 'a { color: red; }\n@media (max-width: 9px) { a { color: blue; } }', false],
    ['@keyframes 的 from/to（不是选择器，不该报）', '@keyframes x { from { opacity: 0; } to { opacity: 1; } }', false],
    ['选择器组展开后撞车（真有害）', 'a, b { color: red; }\n\nb { color: blue; }', true],
  ]
  let ok = 0
  for (const [name, css, want] of cases) {
    const hit = analyze(css).harmful.length > 0
    const pass = hit === want
    console.log(`${pass ? '✔' : '✗'} ${name} → ${hit ? '报出' : '放过'}${pass ? '' : `（期望${want ? '报出' : '放过'}，**判据错**）`}`)
    if (pass) ok++
  }
  console.log(`\n${ok}/${cases.length} 档对照通过`)
  process.exit(ok === cases.length ? 0 : 1)
}

for (const f of targets) {
  let raw
  try { raw = readFileSync(f, 'utf8') } catch { console.log(`— ${f}（不存在）`); continue }
  const { harmful, benign, ruled } = analyze(raw)
  if (!ruled) { console.log(`✔ ${f}：没有重复定义的选择器`); continue }
  total += harmful.length
  if (!harmful.length) {
    console.log(`✔ ${f}：无"值被压死"的重复（另有 ${benign.length} 处分散声明，无害）`)
    continue
  }
  console.log(`\n✗ ${f}：${harmful.length} 个选择器的**声明值被后一块压死**（同上下文 + 同特异性）`)
  for (const [k, v, dead] of harmful.sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n   ▸ ${k}   ×${v.length}   被压死的属性：${dead.join(', ')}`)
    for (const r of v) {
      console.log(`       L${r.line}  ${r.decl.slice(0, 140)}${r.decl.length > 140 ? ' …' : ''}`)
    }
  }
  if (benign.length) {
    console.log(`\n   （另有 ${benign.length} 处只是分散声明、没有值被压死，不计入：`)
    console.log(`     ${benign.map(([k]) => k.split(':: ')[1]).slice(0, 8).join(' · ')}${benign.length > 8 ? ' …' : ''}）`)
  }
}
console.log(total ? `\n合计 ${total} 处"值被压死"的重复定义` : '\n✔ 全部干净（没有值被压死的重复定义）')
// `--gate`：给 build preflight 用（退出码即结论）。人看时不用带，输出一样。
if (argv.includes('--gate') && total > 0) process.exit(1)
