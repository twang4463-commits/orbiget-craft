/**
 * MAIN world 网页聊天钩子 —— **站点无关内核**。
 *
 * 职责是哑管道：tee 页面自己发往补全接口的流式响应，把原始文本块
 * postMessage 给隔离世界。它不知道 DeepSeek / 豆包 / ChatGPT / Gemini 的
 * 任何端点、事件名或页面结构 —— 这些全部由 `sites/<site>.ts` 的
 * `HookSiteProfile` 提供，每站打成**独立 bundle**。
 *
 * 2026-10-24 真机定案：DeepSeek 业务接口（含补全）走 XHR ⇒ fetch 与 XHR
 * 两通道都拦（fetch 走 tee，XHR 只读 responseText 增量，不改请求/响应）。
 *
 * 为什么在网络层而不是 DOM：补全接口带自家风控签名，自己发请求走不通；
 * 页面 DOM 类名每次构建都变。搭页面自己的车是唯一稳定位。
 *
 * 铁律：钩子**绝不能弄坏页面** —— 任何 tee/读取失败都静默退回原始 response。
 */

import type { HookSiteProfile } from './types'
import { WEB_CHAT_LAYER_VERSION } from '../version'

export function installWebChatHook(profile: HookSiteProfile): void {
  const w = window as Window & { __occWebChatHooked?: boolean }
  if (w.__occWebChatHooked) return
  w.__occWebChatHooked = true

  const MSG_SOURCE = 'occ-web-chat'
  /** 桥 → 钩子的控制通道(与数据通道分开,免得自己的帧喂给自己的监听) */
  const CTL_SOURCE = 'occ-web-chat-ctl'
  const TAG = '[occ-web-chat]'
  /** 三方版本来自唯一真身（`version.ts`）；hello 里带出去供驱动自愈判定 */
  const LAYER_VERSION = WEB_CHAT_LAYER_VERSION

  function emit(message: Record<string, unknown>): void {
    try {
      window.postMessage({ source: MSG_SOURCE, ...message }, '*')
    } catch {
      /* ignore */
    }
  }

  function sayHello(): void {
    emit({ kind: 'hello', at: Date.now(), version: LAYER_VERSION })
  }

  /**
   * 诊断帧（2026-10-27）：把钩子在**页面内部**看到的响应头/首块/流结尾
   * 同步一份给隔离世界 → 驱动 → App 控制台。排查时不用再开专窗 DevTools。
   * 只发短文本，不发正文；带 requestId 便于和驱动匹配日志对账。
   */
  function diag(text: string, requestId?: string): void {
    console.info(TAG, 'diag:', text)
    emit({ kind: 'diag', requestId, text })
  }

  /**
   * 把 tee 出来的页面分支包成 Response 还回去 —— 保留原响应的
   * url/type/redirected。页面代码若拿 `response.url`/`response.type`
   * 做判断，只换 body 的裸 Response 会露馅（2026-10-27）。
   * 铁律不变：包装失败就退回原响应，绝不弄坏页面。
   */
  function wrapFetchedResponse(original: Response, pageBody: ReadableStream<Uint8Array>): Response {
    const wrapped = new Response(pageBody, {
      status: original.status,
      statusText: original.statusText,
      headers: original.headers,
    })
    try {
      Object.defineProperty(wrapped, 'url', { value: original.url })
      Object.defineProperty(wrapped, 'redirected', { value: original.redirected })
      Object.defineProperty(wrapped, 'type', { value: original.type })
    } catch {
      /* 属性锁死等罕见情形：保持裸 Response，body 仍然可用 */
    }
    return wrapped
  }

  // 装好即报声:桥用它向驱动器证明钩子在位(document_start 先于页面与隔离脚本)。
  // readyState 一并记下:complete = 晚注入(页面脚本可能已私藏 fetch 引用)。
  sayHello()
  console.info(TAG, `hook installed (readyState=${document.readyState}), fetch wrapped`)

  /** URL 足迹:每个唯一「通道 METHOD 路径」只记一行(info 级默认可见)—— 端点漂移/绕过通道一眼可辨 */
  const seenPaths = new Set<string>()
  function trailPath(channel: 'fetch' | 'xhr', method: string, pathname: string): void {
    const key = `${channel} ${method.toUpperCase()} ${pathname}`
    if (!seenPaths.has(key) && seenPaths.size < 100) {
      seenPaths.add(key)
      console.info(TAG, key)
    }
  }

  function pathOf(rawUrl: string): string {
    try {
      return new URL(rawUrl, location.href).pathname
    } catch {
      return rawUrl
    }
  }

  /**
   * 产物动向：页面拉取「AI 生成媒体」CDN 资源 = 在出/出完，发 activity 帧给桥
   * （再转驱动器 → 脑洞活动行）。**路径判定是站点答案**（profile 提供），
   * 内核只负责节流与发帧。节流 2s —— 拼图阶段页面会连发多张缩略。
   * ⚠️ 只发帧，不碰请求。
   */
  let lastGenImageSignalAt = 0
  function trailGenMedia(channel: 'fetch' | 'xhr', pathname: string): void {
    let label: 'gen-image' | 'gen-video' | null = null
    try {
      label = profile.activityForPath?.(pathname) ?? null
    } catch {
      label = null
    }
    if (label == null) return
    const now = Date.now()
    if (now - lastGenImageSignalAt < 2000) return
    lastGenImageSignalAt = now
    emit({ kind: 'activity', label })
    console.info(TAG, `gen-media activity (${channel})`, pathname.slice(0, 80))
  }

  /** 补全端点判定 —— 站点答案，走 profile（内核不认识任何家的路径） */
  function isCompletionPath(pathname: string, rawUrl: string): boolean {
    try {
      return profile.isCompletionUrl(pathname, rawUrl)
    } catch {
      return false
    }
  }
  /** 网关路径复判（2026-10-31）：rpcid 在 POST body 里的补全形态。
   *  URL 判不出 ⇒ 命中网关路径的请求先取 body，再用站点答案复判。 */
  function isGatewayPath(pathname: string): boolean {
    try {
      return profile.gatewayPaths?.some(re => re.test(pathname)) ?? false
    } catch {
      return false
    }
  }
  function isCompletionBody(body: string): boolean {
    try {
      return profile.isCompletionBody?.(body) ?? false
    } catch {
      return false
    }
  }
  /** 非 SSE 的流形态 —— 站点答案（缺省 false） */
  function isExtraStream(contentType: string, head: string): boolean {
    try {
      return profile.isExtraStream?.(contentType, head) === true
    } catch {
      return false
    }
  }

  // 桥的探针:装载期 hello 丢失时按需重发在位证明;发送窗口的可见性谎报开关(见下)
  window.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { source?: string; kind?: string; on?: boolean } | null
    if (event.source !== window || !data || data.source !== CTL_SOURCE) return
    if (data.kind === 'probe') sayHello()
    if (data.kind === 'visibility-lie' && profile.needsVisibilityLie) setVisibilityLie(data.on === true)
  })

  /**
   * 发送窗口的可见性谎报(2026-10-25 —— 本文件唯一的非管道行为,桥经 ctl
   * 通道控制):豆包这类站点对不可见文档挂起交互 —— 编辑器框架看到
   * hidden/失焦就不给输入落账,后台静默发送因此失败(真机日志:round 1
   * not consumed,文本随后被编辑器回滚)。只在「页面消费输入」的短窗口内
   * 对页面 JS 谎报 visible/focused,窗口结束**全部还原**(铁律不变:绝不
   * 弄坏页面;谎报只骗页面 JS,不碰浏览器内部的定时器节流/事件派发)。
   */
  let lieOn = false
  /** 原始 focus/blur 的引用(lie OFF 时还原;并给 window.focus 留好备份) */
  const origFocus = HTMLElement.prototype.focus
  const origBlur = HTMLElement.prototype.blur
  function setVisibilityLie(on: boolean): void {
    if (on === lieOn) return
    const doc = document
    if (on) {
      try {
        Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' })
        Object.defineProperty(doc, 'webkitVisibilityState', { configurable: true, get: () => 'visible' })
        Object.defineProperty(doc, 'hidden', { configurable: true, get: () => false })
        Object.defineProperty(doc, 'webkitHidden', { configurable: true, get: () => false })
        doc.hasFocus = () => true
        // 完整前台扮装(2026-10-25 深夜,用户点名「禁掉 focus 的 api」):
        // 除可见性外,把「当前正在聚焦」也谎报掉 —— 站点若按前台/焦点
        // 挂起交互或抢焦点,看到的是一直有焦点的页面。
        HTMLElement.prototype.focus = function (this: HTMLElement) {
          try {
            this.dispatchEvent(new FocusEvent('focus', { bubbles: true }))
            this.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
          } catch { /* ignore */ }
        }
        HTMLElement.prototype.blur = function (this: HTMLElement) {
          try {
            this.dispatchEvent(new FocusEvent('blur', { bubbles: true }))
            this.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
          } catch { /* ignore */ }
        }
        ;(window as Window & { focus?: () => void }).focus = () => {}
        doc.dispatchEvent(new Event('visibilitychange'))
        window.dispatchEvent(new Event('focus'))
        lieOn = true
        console.info(TAG, 'visibility lie ON (send window)')
      } catch {
        /* 属性被页面锁死等罕见情形:静默放弃,后台发送交回退路径 */
      }
    } else {
      try {
        for (const key of ['visibilityState', 'webkitVisibilityState', 'hidden', 'webkitHidden'] as const) {
          Reflect.deleteProperty(doc, key)
        }
        Reflect.deleteProperty(doc, 'hasFocus')
        HTMLElement.prototype.focus = origFocus
        HTMLElement.prototype.blur = origBlur
        Reflect.deleteProperty(window, 'focus')
        lieOn = false
        console.info(TAG, 'visibility lie OFF (restored)')
      } catch {
        /* ignore */
      }
    }
  }

  function nextRequestId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  }

  const originalFetch = window.fetch?.bind(window)
  if (!originalFetch) return

  /** 不消费地取请求体:字符串直接用,Request 克隆后读,Blob/二进制解码 */
  async function extractBody(input: RequestInfo | URL, init?: RequestInit): Promise<string> {
    try {
      const b = init?.body
      if (typeof b === 'string') return b
      if (b instanceof Blob) return await b.text()
      if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return new TextDecoder().decode(b as BufferSource)
      if (typeof Request !== 'undefined' && input instanceof Request) return await input.clone().text()
    } catch {
      /* 取不到就发空串,驱动器按「证据不足」记诊断 */
    }
    return ''
  }

  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    // 目标判定与请求体先证在 fetch 之前:响应失败/非流/正常流三种情形,
    // 驱动器都能先凭 request 帧 + 指纹把「这就是我触发的这轮」对上号。
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method
      || (typeof input !== 'string' && !(input instanceof URL) && typeof Request !== 'undefined' && input instanceof Request ? input.method : '')
      || 'GET').toUpperCase()
    const pathname = pathOf(rawUrl)
    trailPath('fetch', method, pathname)
    trailGenMedia('fetch', pathname)
    let isCompletion = isCompletionPath(pathname, rawUrl)
    /** 网关形态下提前取到的请求体（fetch 主路径用它发 request 帧,免二次读） */
    let gatewayBody: string | null = null
    if (!isCompletion && isGatewayPath(pathname)) {
      gatewayBody = await extractBody(input, init)
      isCompletion = isCompletionBody(gatewayBody)
      if (isCompletion) {
        console.info(TAG, 'gateway completion (rpcid in body)', pathname.slice(0, 80))
      }
    }
    if (!isCompletion) {
      return await originalFetch(input as RequestInfo, init)
    }

    const requestId = nextRequestId()
    // 请求体(用户提问)先带出去:驱动侧用它做「这是不是我触发的那条补全」关联
    void Promise.resolve(gatewayBody ?? extractBody(input, init)).then(bodyText => {
      emit({ kind: 'request', requestId, body: bodyText })
    }).catch(() => {
      emit({ kind: 'request', requestId, body: '' })
    })

    let response: Response
    try {
      response = await originalFetch(input as RequestInfo, init)
    } catch (err) {
      emit({ kind: 'error', requestId, message: `fetch rejected: ${err instanceof Error ? err.message : String(err)}` })
      diag(`completion fetch rejected ${requestId}: ${err instanceof Error ? err.message : String(err)}`, requestId)
      throw err
    }

    try {
      const body = response.body
      const contentType = response.headers.get('content-type') || ''
      // 打点(2026-10-27):响应头一到就报 —— 没有这一行 = 页面自己都还没拿到响应
      diag(`completion response ${requestId} status=${response.status} ct=${contentType || '-'} body=${body != null}`, requestId)

      if (body == null) {
        // 非流响应(无 body,风控/限流/参数错):克隆取一小段当证据发回去,原 response 原样还给页面
        diag(`completion non-SSE(no body) status=${response.status} ct=${contentType || '-'}`, requestId)
        try {
          const clone = response.clone()
          void clone.text().then(preview => {
            emit({ kind: 'response-error', requestId, status: response.status, contentType, preview: preview.slice(0, 400) })
          }).catch(() => {
            emit({ kind: 'response-error', requestId, status: response.status, contentType, preview: '' })
          })
        } catch {
          emit({ kind: 'response-error', requestId, status: response.status, contentType, preview: '' })
        }
        return response
      }

      /** 后台读流：逐块原文转发，读失败对页面零影响。首块样本/事件名在这里打点。 */
      const pumpStream = (forUs: ReadableStream<Uint8Array>, label: string): void => {
        void (async () => {
          const reader = forUs.getReader()
          const decoder = new TextDecoder()
          let chars = 0
          /** 本轮 SSE 事件名清单 + 首块样本 —— 协议漂移一眼可辨 */
          const streamEvents = new Set<string>()
          let firstSample = ''
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              const text = decoder.decode(value, { stream: true })
              if (text) {
                if (!firstSample) {
                  firstSample = text.slice(0, 200)
                  diag(`completion head ${requestId} ${JSON.stringify(text.slice(0, 120))} (${label})`, requestId)
                }
                chars += text.length
                for (const match of text.matchAll(/(?:^|\n)event:\s*([^\r\n]+)/g)) {
                  const name = match[1].trim()
                  if (name) streamEvents.add(name)
                }
                emit({ kind: 'chunk', requestId, text })
              }
            }
            emit({ kind: 'done', requestId })
            diag(`stream ended ${requestId} ${chars} chars events=${streamEvents.size ? [...streamEvents].join(',') : '(none)'}`, requestId)
          } catch (err) {
            emit({ kind: 'error', requestId, message: err instanceof Error ? err.message : String(err) })
            diag(`stream read failed ${requestId}: ${err instanceof Error ? err.message : String(err)}`, requestId)
          } finally {
            try {
              reader.releaseLock()
            } catch {
              /* ignore */
            }
          }
        })()
      }

      const isSse = contentType.includes('text/event-stream')

      // ── 已知 SSE：**不偷看首块**，立即 tee 还把页面 ──────────────────
      // 2026-10-27 豆包真机：服务端可能迟迟不吐首块（排队/思考/空流），
      // 旧实现 await peekReader.read() 把页面响应扣在钩子里，同时
      // response.clone() 的未读分支又多出一个 tee —— 表现就是
      // `completion response` 之后永远没有 `completion head`，页面与 App
      // 一起拿不到任何正文。SSE 的 Content-Type 已经足够可信，直接分流。
      if (isSse) {
        const [forPage, forUs] = body.tee()
        console.info(TAG, 'tee completion stream', requestId, response.status, '(sse, direct)')
        pumpStream(forUs, 'sse')
        return wrapFetchedResponse(response, forPage)
      }

      // ── 非 SSE：必须看首块才能分辨 Gemini 的 JSON 流 ──────────────
      // StreamGenerate 是 `application/json` 的流式 body（`)]}'` 哨兵）。
      // 这里才需要 clone + peek；窥走的块会并入重组流，体不能坏。
      const previewClone = response.clone()
      const peekReader = body.getReader()
      const first = await peekReader.read().catch(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>)
      const headText = first.done || !first.value ? '' : new TextDecoder().decode(first.value, { stream: true })
      const isExtra = isExtraStream(contentType, headText)
      diag(`completion head ${requestId} ${JSON.stringify(headText.slice(0, 120)) || '(empty)'} sse=false extra=${isExtra}`, requestId)

      if (!isExtra) {
        // 真·非流（风控/限流/参数错）：克隆取一小段当证据，窥走的块重组还页面
        diag(`completion non-SSE status=${response.status} ct=${contentType || '-'}`, requestId)
        try {
          void previewClone.text().then(preview => {
            emit({ kind: 'response-error', requestId, status: response.status, contentType, preview: preview.slice(0, 400) })
          }).catch(() => {
            emit({ kind: 'response-error', requestId, status: response.status, contentType, preview: '' })
          })
        } catch {
          emit({ kind: 'response-error', requestId, status: response.status, contentType, preview: '' })
        }
        const requeued = new ReadableStream<Uint8Array>({
          start(controller) {
            if (!first.done && first.value) controller.enqueue(first.value)
          },
          async pull(controller) {
            try {
              const next = await peekReader.read()
              if (next.done) controller.close()
              else controller.enqueue(next.value)
            } catch (err) {
              controller.error(err)
            }
          },
          cancel() {
            try {
              peekReader.cancel()
            } catch {
              /* ignore */
            }
          },
        })
        return wrapFetchedResponse(response, requeued)
      }

      // JSON 流：释放预览分支（不读它只会白占一份 tee），窥走的块并回源流
      try {
        void previewClone.body?.cancel().catch(() => undefined)
      } catch {
        /* ignore */
      }
      const source = new ReadableStream<Uint8Array>({
        start(controller) {
          if (!first.done && first.value) controller.enqueue(first.value)
        },
        async pull(controller) {
          try {
            const next = await peekReader.read()
            if (next.done) controller.close()
            else controller.enqueue(next.value)
          } catch (err) {
            controller.error(err)
          }
        },
        cancel() {
          try {
            peekReader.cancel()
          } catch {
            /* ignore */
          }
        },
      })
      const [forPage, forUs] = source.tee()
      console.info(TAG, 'tee completion stream', requestId, response.status, '(json stream)')
      pumpStream(forUs, profile.streamLabel?.(contentType, headText) ?? 'json')
      return wrapFetchedResponse(response, forPage)
    } catch {
      // tee/包装失败:原样返回,绝不弄坏页面
      return response
    }
  }) as typeof window.fetch

  // ── XHR 拦截(2026-10-24 真机定案:DeepSeek 业务接口走 XHR,fetch 足迹里只有
  //    telemetry/静态资源 —— 补全请求必须两通道都拦)。只读 responseText 增量,
  //    不改任何请求/响应对象,对页面零侵入。
  interface OccXhr extends XMLHttpRequest {
    __occMethod?: string
    __occUrl?: string
  }
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

  XMLHttpRequest.prototype.open = function (this: OccXhr, method: string, url: string | URL, ...rest: unknown[]) {
    this.__occMethod = String(method)
    this.__occUrl = String(url)
    return originalOpen.apply(this, [method, url, ...rest] as Parameters<typeof originalOpen>)
  }

  XMLHttpRequest.prototype.send = function (this: OccXhr, body?: Document | XMLHttpRequestBodyInit | null) {
    const method = this.__occMethod ?? 'GET'
    const rawUrl = this.__occUrl ?? ''
    const pathname = pathOf(rawUrl)
    trailPath('xhr', method, pathname)
    trailGenMedia('xhr', pathname)
    let isCompletion = isCompletionPath(pathname, rawUrl)
    // 网关形态:rpcid 在 body 里(XHR 的 body 就是字符串,同步判,零成本)
    if (!isCompletion && isGatewayPath(pathname)) {
      isCompletion = typeof body === 'string' && isCompletionBody(body)
      if (isCompletion) {
        console.info(TAG, 'gateway xhr completion (rpcid in body)', pathname.slice(0, 80))
      }
    }
    if (!isCompletion) {
      return originalSend.call(this, body)
    }

    const requestId = nextRequestId()
    diag(`xhr completion ${requestId} ${method} ${pathname}`, requestId)
    // 请求体先证(XHR 的 body 就是字符串/表单,直接用)
    const bodyText = typeof body === 'string' ? body : ''
    emit({ kind: 'request', requestId, body: bodyText })

    const self = this
    let lastLen = 0
    let sawAny = false
    const read = (): void => {
      try {
        const text = self.responseText // responseType 非 text(或跨域)会 throw,静默放弃
        if (text.length > lastLen) {
          sawAny = true
          emit({ kind: 'chunk', requestId, text: text.slice(lastLen) })
          lastLen = text.length
        }
      } catch {
        /* ignore */
      }
    }
    // SSE-over-XHR 不一定触发 progress,readystatechange 一起挂;lastLen 去重
    self.addEventListener('progress', read)
    self.addEventListener('readystatechange', read)
    self.addEventListener('loadend', () => {
      read()
      if (sawAny) {
        emit({ kind: 'done', requestId })
        diag(`xhr completion ended ${requestId} status=${self.status} ${lastLen} chars`, requestId)
      } else {
        let preview = ''
        try {
          preview = (self.responseText || '').slice(0, 400)
        } catch {
          /* ignore */
        }
        const contentType = self.getResponseHeader('content-type') || ''
        emit({ kind: 'response-error', requestId, status: self.status, contentType, preview })
        diag(`xhr completion ended without body ${requestId} status=${self.status} ct=${contentType || '-'}`, requestId)
      }
    })
    return originalSend.call(this, body)
  }
  console.info(TAG, 'xhr wrapped', `(site=${profile.id})`)
}
