/**
 * 适配器隔离守卫（2026-10-27 重构）。
 *
 * 用户红线：**改豆包不能牵扯 DeepSeek**。这条测试把架构约束钉死：
 * · 抓取内核里不许出现任何站点名/站点选择器（注释除外）；
 * · 每站模块只 import 共享内核 + 自己的解析器，绝不互相 import；
 * · 每站入口只带自己那一个站点；
 * · 构建清单（根构建 + 独立壳）与 `sites/catalog.ts` 的站点列表一致。
 *
 * 读文件用 `import.meta.glob(..., { query: '?raw' })`：Vite 原生，不需要
 * node 类型（本仓库没装 @types/node，用 node:fs 会让构建 preflight 挂掉）。
 */
import { describe, expect, it } from 'vitest'
import { WEB_SITES } from '../sites/catalog'

// @ts-expect-error vite 在转换期替换 import.meta.glob；本项目 tsconfig 未引入 vite/client 类型
const coreSources = import.meta.glob('../capture/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
// @ts-expect-error 同上
const siteSources = import.meta.glob('../sites/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
// @ts-expect-error 同上
const entrySources = import.meta.glob('../content-script/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
// @ts-expect-error 同上
const rootSources = import.meta.glob('../../../../scripts/build.mjs', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
// @ts-expect-error 同上
const appSources = import.meta.glob('../../../../apps/brainstorm/scripts/build-extension.mjs', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
// @ts-expect-error 同上
const appViteSources = import.meta.glob('../../../../apps/brainstorm/vite.config.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>

const SITE_IDS = ['deepseek', 'doubao', 'chatgpt', 'gemini'] as const

function sourceOf(sources: Record<string, string>, suffix: string): string {
  const entry = Object.entries(sources).find(([key]) => key.endsWith(suffix))
  return entry?.[1] ?? ''
}

/** 去注释（保留代码里的字符串，足够抓「站点名/选择器写进内核」） */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

describe('web-chat 适配器隔离', () => {
  it('读到了核心与构建清单（否则后面的断言会空转）', () => {
    expect(sourceOf(coreSources, 'hook-core.ts').length).toBeGreaterThan(500)
    expect(sourceOf(coreSources, 'bridge-core.ts').length).toBeGreaterThan(500)
    expect(sourceOf(rootSources, 'build.mjs').length).toBeGreaterThan(1000)
    expect(sourceOf(appSources, 'build-extension.mjs').length).toBeGreaterThan(500)
  })

  it('内核代码里没有站点名 / 站点选择器（注释除外）', () => {
    for (const name of ['hook-core.ts', 'bridge-core.ts', 'media.ts', 'replay.ts', 'shape.ts', 'types.ts']) {
      const code = stripComments(sourceOf(coreSources, name))
      expect(code, name).not.toMatch(/deepseek|doubao|chatgpt|gemini|qwen|openai/i)
      expect(code, name).not.toMatch(
        /message_image_content|mdbox_image|prompt-textarea|rich-textarea|backend-api|streamgenerate|gen_image|data-message-author-role/i,
      )
    }
  })

  it('内核不 import 任何站点模块', () => {
    for (const name of ['hook-core.ts', 'bridge-core.ts']) {
      expect(sourceOf(coreSources, name)).not.toMatch(/from\s+'[^']*sites\//)
    }
  })

  it('每站模块只 import 共享内核 + 自己的解析器，不互相 import', () => {
    for (const id of SITE_IDS) {
      const src = sourceOf(siteSources, `${id}.ts`)
      expect(src.length, `${id}.ts 没读到`).toBeGreaterThan(100)
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
      for (const spec of imports) {
        for (const other of SITE_IDS) {
          if (other === id) continue
          expect(spec, `${id} 不应 import 另一站 ${spec}`).not.toContain(`./${other}`)
        }
      }
      // 至少引到了共享抓取层（profile 的机制来源）
      expect(imports.some(s => s.includes('capture/') || s === './types' || s === '../types')).toBe(true)
    }
  })

  it('每站入口只带自己那一个站点', () => {
    const expected = SITE_IDS.flatMap(id => [`${id}-hook.ts`, `${id}-bridge.ts`]).sort()
    const actual = Object.keys(entrySources)
      .map(key => key.split('/').pop() ?? '')
      .filter(Boolean)
      .sort()
    expect(actual).toEqual(expected)
    for (const id of SITE_IDS) {
      for (const kind of ['hook', 'bridge']) {
        const src = sourceOf(entrySources, `${id}-${kind}.ts`)
        const siteImports = [...src.matchAll(/sites\/([a-z]+)/g)].map(m => m[1])
        expect(new Set(siteImports), `${id}-${kind}.ts`).toEqual(new Set([id]))
      }
    }
  })

  it('站点声明的独立 bundle 名与命名约定一致', () => {
    for (const site of WEB_SITES) {
      expect(site.spec.hookScript).toBe(`web-chat-hook--${site.id}.js`)
      expect(site.spec.bridgeScript).toBe(`web-chat-bridge--${site.id}.js`)
    }
  })

  it('根构建清单与站点目录一致', () => {
    const build = sourceOf(rootSources, 'build.mjs')
    const match = /const WEB_CHAT_SITE_IDS = \[([^\]]+)\]/.exec(build)
    expect(match, 'build.mjs 缺少 WEB_CHAT_SITE_IDS').not.toBeNull()
    const ids = [...match![1].matchAll(/'([^']+)'/g)].map(m => m[1])
    expect(ids).toEqual(WEB_SITES.map(site => site.id))
    expect(build).toContain('packages/web-chat/src/content-script/${siteId}-${kind}.ts')
    expect(build).toContain('web-chat-${kind}--${siteId}')
  })

  it('独立壳构建清单与站点目录一致（每站单独 IIFE）', () => {
    const script = sourceOf(appSources, 'build-extension.mjs')
    const match = /const SITE_IDS = \[([^\]]+)\]/.exec(script)
    expect(match, '独立壳缺少 SITE_IDS').not.toBeNull()
    const ids = [...match![1].matchAll(/'([^']+)'/g)].map(m => m[1])
    expect(ids).toEqual(WEB_SITES.map(site => site.id))
    expect(script).toContain('inlineDynamicImports: true')
    expect(script).toContain('format: \'iife\'')
    // 主构建只出页面/SW；内容脚本必须走独立构建（否则会切共享 chunk）
    const mainVite = sourceOf(appViteSources, 'vite.config.ts')
    expect(mainVite).not.toContain('web-chat-hook--')
    expect(mainVite).not.toContain('web-chat-bridge--')
  })
})
