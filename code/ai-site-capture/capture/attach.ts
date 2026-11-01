/**
 * 附件投递（2026-10-31 真机）—— **站点无关内核**（隔离世界跑）。
 *
 * ## 为什么网页端点也要有附件通道
 *
 * 网页端点的请求体是**我们拍平出来的一段文字**（`flattenMessagesForWebChat`），
 * 图片塞不进去。以前这条通道的结构性结论是「网页端点传不了图」，于是
 * 脑洞的视觉闸门把带图的请求全拦掉。
 *
 * 真机把这条路走通了：**把 File 合成进页面自己的剪贴板/拖拽事件**，
 * 页面认出它、把它交给自己的上传管线，模型随后就能读到图/文档：
 *
 * | 站点 | 上传管线 | 真机结果 |
 * |---|---|---|
 * | chat.deepseek.com | `/api/v0/file/upload_file` | 红方块 → 回答「红色」；txt → 读出正文暗号 |
 * | www.doubao.com | `/alice/resource/prepare_upload` → TOS → `CommitImageUpload`（文档再走 `/samantha/aireader/document_info/get` 解析） | 三张图 → 回答「红色、绿色、蓝色」；txt/PDF → 读出正文暗号 |
 *
 * ⚠️ 为什么不直接调页面的上传接口：DeepSeek 的补全接口带 wasm 工作量证明
 *   （`X-Ds-Pow-Response`），页面自己发才是唯一正路 ⇒ 我们只负责把字节
 *   **塞进页面上它认的那条管线**。
 *
 * ## 两种手法
 *
 * · `paste`：合成 `ClipboardEvent`，`clipboardData` 里带 File ——
 *   **DeepSeek / 豆包都收**（豆包的拖拽只对「创作素材」功能开放，
 *   要 materialEnabled + 账号；普通附件的入口就是粘贴）。
 * · `drop`：合成 `dragenter/dragover/drop` + `DataTransfer` ——
 *   DeepSeek 额外收（document 级捕获，坐标要落在输入坞里）。
 *
 * 手法是**站点答案**（`sites/<site>.ts` 的 `bridge.attachments.mode`），
 * 本模块不猜。
 */

/** 驱动 → 桥的附件载荷（base64，不含 data: 前缀） */
export interface WebAttachPayload {
  name: string
  mime: string
  base64: string
}

/** 投递结果 */
export interface AttachDeliveryResult {
  ok: boolean
  /** 失败原因（ok=false 时） */
  reason?: 'attachments-unsupported' | 'no-input' | 'bad-file' | 'not-landed'
  /** 实际投出去几件 */
  delivered?: number
}

/** 投递所需的外部能力（桥提供） */
export interface AttachDeliveryOptions {
  /** 投递手法（站点答案） */
  mode: 'paste' | 'drop'
  /** 落地判据（站点答案）：返回 true = 芯片已出现 */
  detect?(doc: Document): boolean
  /** 落地等待上限（ms）；缺省 8000 */
  settleMs?: number
  /** 找输入框（桥提供） */
  findInput(): HTMLElement | null
  /** 等待（桥提供） */
  sleep(ms: number): Promise<void>
}

/**
 * base64 载荷 → File（字节级还原）。
 *
 * 扩展名/类型照站点要求给 —— DeepSeek 按**扩展名**过滤（.png/.jpg/.pdf/
 * .txt…），扩展名不对它直接拒收。
 */
export function fileFromBase64(file: WebAttachPayload): File | null {
  try {
    const bin = atob(file.base64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
    return new File([bytes], file.name, { type: file.mime })
  } catch {
    return null
  }
}

/**
 * 输入坞容器：输入框往上找几层。
 *
 * 附件芯片与输入框是「同一个盒子里的邻居」（芯片渲染在输入框上方），
 * 所以判据要在盒子里数 —— 不能数全页（页面别处也有图，一多就误判落地）。
 */
export function composerContainer(input: HTMLElement): HTMLElement {
  let el: HTMLElement = input
  for (let i = 0; i < 3; i += 1) {
    const parent = el.parentElement
    if (!parent || parent === document.body || parent === document.documentElement) break
    const pw = parent.getBoundingClientRect().width
    const cw = el.getBoundingClientRect().width
    // 只往上收「宽度相当」的祖先（输入坞盒子），避免收到整页容器
    if (pw > 0 && cw > 0 && pw <= cw * 1.8) {
      el = parent
      continue
    }
    break
  }
  return el
}

/** 输入坞的「体型」：图的数量 + 文字长度 —— 芯片出现会让其中之一变大 */
export function attachmentFootprint(input: HTMLElement): { imgs: number; chars: number } {
  const box = composerContainer(input)
  return {
    imgs: box.querySelectorAll('img').length,
    chars: (box.textContent || '').length,
  }
}

/**
 * 等附件落地：**芯片出现**才算送到了（真机：投递后 1~3s 芯片才出现）。
 *
 * 不等就发 ⇒ 文字先到、图后到 ⇒ 模型可能压根没看见图 —— 这是「图发出去了
 * 但模型没理」的隐蔽坑，宁可多等几秒。
 */
export async function waitForAttachments(
  options: AttachDeliveryOptions,
  before: { imgs: number; chars: number },
): Promise<boolean> {
  const deadline = Date.now() + (options.settleMs ?? 8000)
  for (;;) {
    await options.sleep(200)
    if (options.detect) {
      try {
        if (options.detect(document)) return true
      } catch {
        /* 判据读挂了 ⇒ 继续等，最后按超时处理 */
      }
    } else {
      const input = options.findInput()
      if (input) {
        const now = attachmentFootprint(input)
        if (now.imgs > before.imgs || now.chars > before.chars + 4) return true
      }
    }
    if (Date.now() > deadline) return false
  }
}

/**
 * 把附件投进页面（站点无关内核）。
 *
 * 顺序：**先附件 → 再文本 → 再发送**（真机两站都验过这个顺序）——
 * 反过来的话文字先到、图后到，模型可能压根没看见图。
 */
export async function deliverAttachments(
  files: WebAttachPayload[],
  options: AttachDeliveryOptions,
): Promise<AttachDeliveryResult> {
  if (!files.length) return { ok: true, delivered: 0 }
  const input = options.findInput()
  if (!input) return { ok: false, reason: 'no-input' }
  const dt = new DataTransfer()
  let made = 0
  for (const file of files) {
    const built = fileFromBase64(file)
    if (!built) continue
    dt.items.add(built)
    made += 1
  }
  if (!made) return { ok: false, reason: 'bad-file' }
  /** 投递前的输入坞「体型」—— 落地判据靠它（芯片出现 ⇒ 体型变了） */
  const before = attachmentFootprint(input)
  if (options.mode === 'drop') {
    const rect = input.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const mk = (type: string): DragEvent =>
      new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy })
    input.dispatchEvent(mk('dragenter'))
    input.dispatchEvent(mk('dragover'))
    input.dispatchEvent(mk('drop'))
  } else {
    input.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }))
  }
  const landed = await waitForAttachments(options, before)
  return landed ? { ok: true, delivered: made } : { ok: false, reason: 'not-landed' }
}
