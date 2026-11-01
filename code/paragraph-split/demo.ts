/**
 * 最小使用示例：超长段落按句读切分
 *
 * 运行：npx tsx demo.ts
 */
import { splitParagraphText, splitOversizedParagraphs } from './paragraph-split'

// 造一段 ~1.4 万字的巨型段落
const sentence = '他抬起头看向窗外，风把歌声吹得很远。'
const huge = sentence.repeat(400)

const parts = splitParagraphText(huge)
console.log(`原文: 1 段 / ${huge.length} 字`)
console.log(`切分: ${parts.length} 段 / 各段 ${Math.min(...parts.map(p => p.length))}~${Math.max(...parts.map(p => p.length))} 字`)

// 字符守恒：去掉分隔符后与原文逐字相同
console.log('字符守恒:', parts.join('') === huge)

// 段落质量：每段以句末标点收尾、不以闭合符开头
const endOk = parts.every(p => '。！？；…”』）]'.includes(p[p.length - 1] || '。') || /[.!?;)\]"']$/.test(p))
const headOk = parts.slice(1).every(p => !'"\'）】》)]}』」' .includes(p[0]))
console.log('句末收尾:', endOk, '/ 无悬空闭合符开头:', headOk)

// markdown 口径：只切超长段，空行结构不动
const md = `第一段短文本。\n\n${huge}\n\n结尾一段。`
const fixed = splitOversizedParagraphs(md)
const blocks = fixed.split('\n\n')
console.log(`\nmarkdown: ${blocks.length} 个块（首尾原样、中间被切开）`)
console.log('空行结构保持:', blocks[0] === '第一段短文本。' && blocks[blocks.length - 1] === '结尾一段。')
