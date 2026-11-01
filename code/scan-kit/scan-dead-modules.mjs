#!/usr/bin/env node
/**
 * 全仓「没人 import 的 TS 模块」扫描（开发期脚本，不进构建）
 *
 * 为什么需要它：.vue 孤儿有 `scan-vue-orphans.mjs`、桶里藏的死代码有
 * `scan-barrel-orphans.mjs`、没人用的全局 CSS 类有 `scan-global-dead-classes.mjs` ——
 * **但「一个 .ts 谁都不 import」这一格是空的**。2026-09-27 才发现
 * `content-script/capture/cs-enrich.ts`（126 行，含一份与 `shared/inbox/enrich-image-asset.ts`
 * 并行的 EXIF→provenance 映射）自 2026-08-14 起就没有任何调用方。
 * 这类死代码比 CSS 死类更坏：它**看起来是实现**，有人要修 EXIF 映射时会找到两份，
 * 可能改到没在跑的那一份。
 *
 * 判据：从 src 下所有 .ts/.vue/脚本里抽 import 说明符（含**动态** `import()` 与
 * 副作用 `import '...'`），解析成磁盘路径；**零入边**即为死模块。
 *
 * ⚠️ 三条排除，缺一条就会淹在假阳性里：
 *   ① **入口**（HTML 的 `<script src>`、`build.mjs` / `vite.config.ts` 的 `input`）——
 *      入口本来就没有 importer。入口清单**从配置里读**，不写死，免得加了新入口
 *      就凭空多一个"死模块"。
 *   ② **类型声明** `*.d.ts` 与 `env.d.ts` 之类（走 tsconfig 的 include，不走 import）。
 *   ③ **测试**（`__tests__/`、`*.test.ts`、`*.spec.ts`）本身不是死模块的目标；
 *      但「**只被测试 import**」的模块会单独列一档 —— 那是可疑而非确定死，
 *      因为测试可能是它唯一的消费者（该考虑连测试一起删，或说明它是留给将来的）。
 *
 * ⚠️ 本脚本报的是**入边为零**，不是「可以删」。删之前仍要确认三件事：
 *   是不是留给将来的开关分支、是不是被字符串拼出来的路径引用、是不是公开 API。
 *
 * 用法：node scan-dead-modules.mjs [--src=src] [--config=path/to/vite.config.ts]
 *       （'@/' 别名解析到 --src 指向的目录）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve, relative, sep } from 'node:path'

const argv = process.argv.slice(2)
const SRC = (argv.find((a) => a.startsWith('--src='))?.split('=')[1]) || 'src'
const CONFIGS = argv.filter((a) => a.startsWith('--config=')).map((a) => a.split('=')[1])
/**
 * ⚠️ 一律归一成「相对 cwd 的正斜杠路径」。
 * 第一版这里写的是 `p.split(sep).join('/')`，只换分隔符不消相对/绝对 ——
 * 目标集来自 `walk('apps/craft/src')`（相对），而 import 侧来自 `resolve(...)`（绝对），
 * 两边永远匹配不上，于是**整棵树 672/672 全报死**。
 * 这种"报得太多"和"报 0"一样危险：都是一眼看不出错的假象。
 */
const rel = (p) => relative(process.cwd(), p).split(sep).join('/')

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) {
      // ⚠️ **不要在这里跳过 `__tests__`**：第一版跳了，后果是测试文件根本不在
      //    importer 集合里，于是「只被测试 import」那一档**永远是空的**，
      //    `renderAgentTrace.ts`（只有测试在用）被误报成零引用死模块。
      //    排除测试是**目标集**的事（见 isTest），不是遍历的事。
      if (n === 'node_modules') continue
      walk(p, out)
    } else out.push(p)
  }
  return out
}

// ── 入口清单：从真实配置读，别写死 ──────────────────────────────────────────
const entries = new Set()

// ① HTML 的 <script type="module" src="...">
for (const html of walk(SRC).filter((p) => p.endsWith('.html'))) {
  const text = readFileSync(html, 'utf8')
  for (const m of text.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) {
    if (!/^https?:/.test(m[1])) {
      // ⚠️ 要去掉 `?v=1` 这类查询串 —— popup 入口正是 `./popup/main.ts?v=1`，
      //    第一版没剥，于是 `apps/craft/src/popup/main.ts` 被当成"零 import 的死模块"报了出来。
      const clean = m[1].replace(/[?#].*$/, '')
      entries.add(rel(resolve(dirname(html), clean)))
    }
  }
}

// ② build.mjs / vite.config.ts 里的 src('...')
// ⚠️ vite 配置随宿主壳搬到 `apps/craft/` 了（2026-10-28 装配线收口）——
//    路径写错的话这里会**静默跳过**（existsSync 为 false）⇒ 4 个 HTML 入口
//    被当成「零 import 的死模块」误报。
// vite / build 配置里 input 块的 src('path') 形态入口；路径随项目传 --config=
for (const cfg of [...CONFIGS, SRC + '/../vite.config.ts']) {
  if (!existsSync(cfg)) continue
  const text = readFileSync(cfg, 'utf8')
  // 只认 input 块里的：`input: { key: src('path') }`（单行写法即可覆盖当前两处配置）
  for (const m of text.matchAll(/input:\s*\{([^}]*)\}/g)) {
    for (const s of m[1].matchAll(/src\(\s*['"]([^'"]+)['"]\s*\)/g)) entries.add(rel(resolve(SRC, s[1])))
  }
}

// ── 收集所有文件的 import 说明符 ────────────────────────────────────────────
const allFiles = []
for (const dir of [SRC, 'scripts', 'tools']) {
  if (!existsSync(dir)) continue
  for (const p of walk(dir)) {
    if (/\.(ts|vue|mjs|js)$/.test(p)) allFiles.push(p)
  }
}

/** 从一段文本里抽所有模块说明符（静态 / 动态 / 副作用 / re-export / Worker URL） */
function specifiersOf(text) {
  const out = []
  // import ... from 'x' / export ... from 'x'
  for (const m of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  // 动态 import('x') 与副作用 import 'x'
  for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(m[1])
  for (const m of text.matchAll(/(?:^|[\s;{}])import\s*['"]([^'"]+)['"]/g)) out.push(m[1])
  // ⚠️ `new Worker(new URL('./x.ts', import.meta.url))` —— Worker 入口**不是 import**，
  //    第一版没认，于是 `video/convert-worker.ts` 被报成死模块。
  //    Vite 对 URL 里的 .ts 同样会编译，所以它是一条真入边。
  for (const m of text.matchAll(/new\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
    out.push(m[1])
  }
  return out
}

const CANDIDATE_EXT = ['.ts', '.tsx', '.vue', '.mjs', '.js', '/index.ts', '/index.vue']

/** 把说明符解析成磁盘上的真实文件（找得到才返回） */
function resolveSpec(spec, fromFile) {
  let base
  if (spec.startsWith('@/')) base = resolve(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = resolve(dirname(fromFile), spec)
  else return null // 裸包名（vue / pinia / @lucide/vue…）不管
  if (existsSync(base) && statSync(base).isFile()) return rel(base)
  for (const ext of CANDIDATE_EXT) {
    const p = base + ext
    if (existsSync(p) && statSync(p).isFile()) return rel(p)
  }
  return null
}

const isTest = (p) => /__tests__|\.test\.ts$|\.spec\.ts$|\.bench\.ts$/.test(rel(p))

/** 目标：src 下的 .ts，排除测试与 .d.ts */
const targets = walk(SRC).filter(
  (p) => p.endsWith('.ts') && !p.endsWith('.d.ts') && !isTest(p),
)

const importers = new Map() // 目标路径 -> Set(importer 路径)
const testOnly = new Map()
for (const t of targets) {
  importers.set(rel(t), new Set())
  testOnly.set(rel(t), new Set())
}

for (const f of allFiles) {
  const from = rel(f)
  if (isTest(f)) continue // 测试自身的内部 import 不作数（测试不算消费者）
  const text = readFileSync(f, 'utf8')
  for (const spec of specifiersOf(text)) {
    const hit = resolveSpec(spec, f)
    if (!hit || hit === from) continue
    if (!importers.has(hit)) continue
    importers.get(hit).add(from)
  }
}

// 再跑一遍测试文件，单独记「只被测试 import」那一档
for (const f of allFiles) {
  if (!isTest(f)) continue
  const from = rel(f)
  const text = readFileSync(f, 'utf8')
  for (const spec of specifiersOf(text)) {
    const hit = resolveSpec(spec, f)
    if (!hit || hit === from) continue
    if (testOnly.has(hit)) testOnly.get(hit).add(from)
  }
}

const dead = []
const onlyTests = []
for (const t of targets) {
  const r = rel(t)
  if (entries.has(r)) continue
  if (importers.get(r).size > 0) continue
  const lines = readFileSync(t, 'utf8').split(/\r?\n/).length
  if (testOnly.get(r).size > 0) onlyTests.push({ file: r, lines, by: [...testOnly.get(r)] })
  else dead.push({ file: r, lines })
}

dead.sort((a, b) => b.lines - a.lines)
onlyTests.sort((a, b) => b.lines - a.lines)

const deadLines = dead.reduce((a, x) => a + x.lines, 0)

if (dead.length === targets.length) {
  console.error('✗ 自检失败：整棵树都被判为死模块，解析必然坏了。')
  process.exit(1)
}
if (targets.length === 0) {
  console.error('✗ 没扫到任何 .ts 目标 —— --src 路径多半写错了。')
  process.exit(1)
}

console.log(`扫描 ${targets.length} 个 src/**/*.ts（入口 ${entries.size} 个已排除）`)
console.log(`零 import 的模块 ${dead.length} 个，合计约 ${deadLines} 行\n`)
for (const d of dead) console.log(`  ${String(d.lines).padStart(5)} 行  ${d.file}`)

if (onlyTests.length) {
  console.log(`\n⚠️ 只被测试 import（可疑，不一定是死）：${onlyTests.length} 个`)
  for (const d of onlyTests) {
    console.log(`  ${String(d.lines).padStart(5)} 行  ${d.file}`)
    console.log(`              ← ${d.by.join(', ')}`)
  }
}

if (dead.length) process.exitCode = 0 // 只报告，不阻断（清单要人眼过一遍）
