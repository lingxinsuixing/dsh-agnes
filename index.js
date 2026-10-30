/**
 * @lingxinsuixing/dsh-agnes — Agnes AI 多模态工具（Host-only 插件）
 *
 * 主要功能（默认开启，结果一律纯文本；图片/视频字节绝不进入会话日志）：
 *   agnes_image_generate   图生：文生图/图生图/多图合成 → 下载到本地目录
 *   agnes_video_generate   视频：文生视频/首尾帧/参考生成 → 异步任务 + 轮询 + 下载
 * 可选能力（config.enableRecognition 可关，默认开）：
 *   agnes_image_recognize  识图：本地路径/URL → Agnes 视觉模型 → 纯文字
 *
 * ⚠️ 为什么识图只回文字、为什么不建议用 DSH 自带的 read_image 在主会话里看图：
 *   模型勾上「支持图片」后，read_image 会把图片内容块塞进主会话；Agnes 网关的 /v1/responses
 *   端点不认识 input_image（responses→chat 桥接时兜底成 unknown），下一轮直接 400；
 *   而 400 不重试、每轮请求又会从会话日志重建全部历史 → 一条坏消息钉死整个会话，只能新开。
 *   本插件的识图把图片发给 Agnes 视觉模型、回会话的只有文字，天然绕开这个坑。
 *   复盘全文：docs/2026-10-30-agnes-image-400-postmortem.md
 *
 * 密钥来源（按优先级）：config.apiKey（用户 patch 层 override）
 *   → DSH 凭据库引用 credentialsRef（默认 AGNES_API_KEY，与 DSH 模型页同一份，含其 env/.env 回退）
 *   → 环境变量 AGNES_API_KEY。
 * 本地图片按 magic bytes 嗅探 MIME（不信扩展名），超限/格式不对直接报错。
 *
 * **无常驻**：apply() 只注册三个工具，不起任何定时器/间隔器，不订阅任何事件、不唤醒 agent。
 * 轮询、下载、超时定时器只在 execute() 调用期间存在，调用返回即全部清理——
 * 不调用的时候本插件对主进程零占用（见 scripts/2026-10-30-agnes-unit-test.mjs 第 7 组断言）。
 */
import { mkdir, stat, readFile, writeFile, rename, rm } from 'node:fs/promises'
import { createWriteStream, openSync, readSync, closeSync, mkdirSync, accessSync, existsSync, statSync, constants as fsConstants } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve, basename, isAbsolute, relative } from 'node:path'
import Schema from '@deepseek-ai/schemastery'

/** Config 默认值（与 schema 默认一一对应；Loader 未给 config 时的兜底） */
const DEFAULTS = {
  apiKey: '',
  credentialsRef: 'AGNES_API_KEY',
  baseUrl: 'https://api.agnes-ai.cn/v1',
  enableRecognition: true, // 可选能力开关：关掉就不注册识图工具，只留生图/生视频
  textModel: 'agnes-3.0-flash',
  imageModel: 'agnes-image-2.5-flash',
  videoModel: 'agnes-video-2.5',
  outputDir: '', // 空 = 运行期解析为 <DSH_HOME>/media（不是进程 cwd：cwd 是宿主进程的工作目录，可能是只读系统目录）
  allowedReadRoots: [], // 本地图片读取白名单（绝对路径）；空 = 不限制
  maxImageBytes: 10 * 1024 * 1024,
  maxDownloadBytes: 200 * 1024 * 1024, // 单个产物（图片/视频）下载体积上限
  maxResponseBytes: 32 * 1024 * 1024, // 单次 API 响应体上限（防 b64 图片撑爆内存）
  httpTimeoutMs: 300_000,
  pollIntervalMs: 2000,
  pollTimeoutMs: 1_800_000,
}
const cfgOf = (config) => ({ ...DEFAULTS, ...(config ?? {}) })

// ---------------------------------------------------------------- config

export const Config = Schema.object({
  apiKey: Schema.string().default('').description('Agnes API Key（Bearer，最高优先级）。留空则回退 DSH 凭据库与环境变量。'),
  credentialsRef: Schema.string().default('AGNES_API_KEY').description('DSH 凭据库里存 Agnes Key 的引用名（与 DSH 模型页的 AGNES_API_KEY 同一份）'),
  baseUrl: Schema.string().default('https://api.agnes-ai.cn/v1').description('Agnes API Base URL'),
  enableRecognition: Schema.boolean().default(true).description('可选能力开关：是否注册识图工具 agnes_image_recognize。关掉后只保留生图/生视频两个主要功能。'),
  textModel: Schema.string().default('agnes-3.0-flash').description('可选：识图（视觉理解）模型'),
  imageModel: Schema.string().default('agnes-image-2.5-flash').description('主要：图像生成模型'),
  videoModel: Schema.string().default('agnes-video-2.5').description('主要：视频生成模型（-flash 变体仅 720P/限参考媒体）'),
  outputDir: Schema.string().default('').description('生成产物保存目录（绝对路径）。留空则保存到 DSH 主目录下的 media 子目录（$DSH_HOME/media，未设置则用 ~/.dsh/media）'),
  allowedReadRoots: Schema.array(Schema.string()).default([]).description('本地图片读取白名单（绝对路径列表）。留空 = 不限制；填了就只允许读取这些目录下的文件'),
  maxImageBytes: Schema.number().default(10 * 1024 * 1024).description('识图输入图片字节上限'),
  maxDownloadBytes: Schema.number().default(200 * 1024 * 1024).description('单个产物下载体积上限（字节）'),
  maxResponseBytes: Schema.number().default(32 * 1024 * 1024).description('单次 API 响应体上限（字节）'),
  httpTimeoutMs: Schema.number().default(300_000).description('单次 Agnes HTTP 请求超时（ms）'),
  pollIntervalMs: Schema.number().default(2000).description('视频任务轮询间隔（ms）'),
  pollTimeoutMs: Schema.number().default(1_800_000).description('视频任务轮询总时限（ms）'),
})

/** 本地图片读取白名单：config.allowedReadRoots 非空时，只允许读这些根目录下的文件 */
function assertReadablePath(abs, roots, tool) {
  const list = (Array.isArray(roots) ? roots : []).map((r) => String(r ?? '').trim()).filter(Boolean)
  if (!list.length) return
  const ok = list.some((root) => {
    const r = resolve(root)
    const rel = relative(r, abs)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
  if (!ok) {
    throw new Error(`${tool}: 读取路径不在 config.allowedReadRoots 白名单内: ${abs}（白名单：${list.join(', ')}）`)
  }
}

/** 截断式 JSON 摘要：别先把整个响应（可能带 base64 图片）序列化再切——那会白占一遍内存 */
function briefJson(data, max = 300) {
  let s
  try {
    s = JSON.stringify(data, (k, v) => (typeof v === 'string' && v.length > 200 ? v.slice(0, 200) + '…' : v)) ?? String(data)
  } catch {
    s = String(data)
  }
  return s.slice(0, max)
}

/** 实际像素的画幅（归一到常见比例；认不出就给约分结果） */
function ratioOf(width, height) {
  if (!width || !height) return ''
  const gcd = (a, b) => (b ? gcd(b, a % b) : a)
  const d = gcd(width, height) || 1
  const rw = width / d
  const rh = height / d
  for (const k of ['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9']) {
    const [a, b] = k.split(':').map(Number)
    if (Math.abs(rw / a - rh / b) < 0.03) return k
  }
  return rw + ':' + rh
}

// ---------------------------------------------------------------- helpers

const isUrl = (s) => /^https?:\/\//i.test(String(s))

// 允许的枚举值（宿主对手写 ToolDefinition 不校验参数，这里自己校验，别让错误参数白跑一趟 API）
const IMAGE_SIZE_TIERS = new Set(['1K', '2K', '3K', '4K'])
const IMAGE_RATIOS = new Set(['1:1', '3:4', '4:3', '16:9', '9:16', '2:3', '3:2', '21:9'])
const VIDEO_SIZES = new Set(['720P', '1080P', '1K', '2K'])
const VIDEO_RATIOS = new Set(['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'])
const VIDEO_MODES = new Set(['text', 'keyframe', 'reference'])
const EXACT_SIZE_RE = /^\d{2,5}x\d{2,5}$/

/** 数组参数校验：模型把数组传成字符串时要报错，不能静默丢掉（否则图生图悄悄退化成文生图） */
function requireArray(value, field, max) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    throw new Error(`${field} 必须是数组（收到 ${typeof value}）`)
  }
  if (max && value.length > max) throw new Error(`${field} 最多 ${max} 项（收到 ${value.length}）`)
  return value
}

function stamp() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** 图片 magic bytes 嗅探 → 标准 MIME（不信扩展名，安全底线） */
function sniffImageMime(bytes) {
  if (bytes.length < 12) return null
  const b = bytes
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

async function loadLocalImageAsDataUri(image, maxBytes, signal, tool, roots) {
  const abs = resolve(image)
  assertReadablePath(abs, roots, tool)
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) throw new Error(`${tool}: 图片文件不存在或不是文件: ${image}`)
  if (info.size > maxBytes) throw new Error(`${tool}: 图片 ${info.size} 字节超过上限 ${maxBytes}（config.maxImageBytes 可调）`)
  const buf = Buffer.from(await readFile(abs, { signal }))
  const mediaType = sniffImageMime(buf)
  if (!mediaType) throw new Error(`${tool}: 无法识别图片格式（仅支持 png/jpeg/gif/webp，按 magic bytes 嗅探）: ${basename(image)}`)
  return `data:${mediaType};base64,${buf.toString('base64')}`
}

async function requireKey(cfg, credentials) {
  const direct = String(cfg.apiKey || '').trim()
  if (direct) return direct
  const ref = String(cfg.credentialsRef || '').trim()
  // credentials 可以是服务对象，也可以是"取服务的函数"（服务晚到时也能用上）
  let svc = typeof credentials === 'function' ? credentials() : credentials
  if (svc && typeof svc.then === 'function') svc = await svc
  if (svc && ref) {
    let resolved
    try {
      resolved = await svc.resolve(ref)
    } catch {
      resolved = null
    }
    if (resolved?.value) return resolved.value
  }
  const fromEnv = String(process.env.AGNES_API_KEY || '').trim()
  if (fromEnv) return fromEnv
  throw new Error(
    'Agnes API Key 未配置。三种办法（按优先级）：' +
    '① 在 Web 界面「插件 → @lingxinsuixing/dsh-agnes」配置页保存 Key（写入本 profile 的插件配置 config.apiKey，明文存于 profile 的 cordis.patch.yml）；' +
    '② 在 DSH 凭据库（~/.dsh/.credentials.yaml）里配 ' + (ref || 'AGNES_API_KEY') + '，与 DSH 模型页共用同一把；' +
    '③ 设置环境变量 AGNES_API_KEY。',
  )
}

/** 带超时 + 协作取消的 Agnes JSON 请求；HTTP 非 2xx 抛出带状态码与提示的 Error */
/** 读响应体，带体积上限（防 b64 图片把内存打爆） */
async function readTextCapped(resp, maxBytes, what) {
  const len = Number(resp.headers?.get?.('content-length') || 0)
  if (len && len > maxBytes) throw new Error(`${what} 响应体过大（${len} 字节 > 上限 ${maxBytes}）`)
  if (!resp.body) {
    const t = await resp.text()
    if (t.length > maxBytes) throw new Error(`${what} 响应体过大（超过 ${maxBytes} 字节上限）`)
    return t
  }
  const reader = resp.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new Error(`${what} 响应体过大（超过 ${maxBytes} 字节上限）`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock?.()
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function agnesFetch(cfg, apiKey, { method = 'POST', path, body, signal, timeoutMs, rawUrl }) {
  const url = rawUrl ?? cfg.baseUrl.replace(/\/+$/, '') + path
  const ac = new AbortController()
  let timerFired = false
  const onAbort = () => ac.abort()
  const timer = setTimeout(() => {
    timerFired = true
    ac.abort()
  }, timeoutMs)
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    let resp
    try {
      resp = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      })
    } catch (err) {
      if (ac.signal.aborted) {
        throw new Error(timerFired ? `Agnes 请求超时（>${timeoutMs} ms）: ${method} ${path ?? url}` : '调用已取消，未执行 Agnes 请求')
      }
      throw new Error(`Agnes 网络错误: ${err?.message ?? err}`)
    }
    let text
    try {
      text = await readTextCapped(resp, cfg.maxResponseBytes ?? 32 * 1024 * 1024, 'Agnes')
    } catch (err) {
      // 读 body 期间超时/取消也会走这里：换成友好文案，别让裸 AbortError 冒到界面上
      if (ac.signal.aborted) {
        throw new Error(timerFired ? `Agnes 请求超时（>${timeoutMs} ms）: ${method} ${path ?? url}` : '调用已取消，未执行 Agnes 请求')
      }
      throw err
    }
    let data = null
    try { data = JSON.parse(text) } catch { /* 非 JSON 响应 */ }
    if (!resp.ok) {
      const detail = data?.error?.message || data?.detail || (text && text.slice(0, 300)) || resp.statusText
      let hint = ''
      if (resp.status === 401 || resp.status === 403) hint = '（API Key 无效/过期/无该模型权限）'
      else if (resp.status === 429) hint = '（触发限流，稍后重试）'
      else if (resp.status === 400) hint = '（请求参数问题，检查字段与模式是否匹配）'
      throw new Error(`Agnes HTTP ${resp.status} ${hint}: ${String(detail).slice(0, 500)}`)
    }
    return data
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

async function sleep(ms, signal) {
  if (!ms || ms <= 0) return
  if (signal?.aborted) throw new Error('调用已取消')
  await new Promise((res, rej) => {
    const onAbort = () => {
      clearTimeout(t)
      rej(new Error('调用已取消'))
    }
    const t = setTimeout(() => {
      // 正常醒来就把监听摘掉：否则一次 30 分钟的视频轮询会在同一个 signal 上堆几百个监听器
      signal?.removeEventListener('abort', onAbort)
      res()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function extFromContent(type, url) {
  const m = String(type ?? '').split(';')[0].trim().toLowerCase()
  if (m === 'image/png') return '.png'
  if (m === 'image/jpeg') return '.jpg'
  if (m === 'image/webp') return '.webp'
  if (m === 'image/gif') return '.gif'
  if (m === 'video/mp4' || m === 'video/quicktime') return '.mp4'
  const e = (String(url).split('?')[0].match(/\.([a-zA-Z0-9]{2,5})$/) || [])[1]
  return e ? `.${e}` : '.png'
}

/** 写内存里的字节到产物文件（b64 分支用：图片字节绝不能进工具结果） */
async function writeBufferToFile(dir, buf, ext, kind) {
  await mkdir(dir, { recursive: true })
  const file = join(dir, `agnes-${kind}-${stamp()}-${Math.random().toString(36).slice(2, 6)}${ext}`)
  const tmp = file + '.part'
  await writeFile(tmp, buf)
  await rename(tmp, file)
  return file
}

/** 流式下载到文件：带体积上限 + 失败重试（已计费产物不能因一次抖动就丢了 URL） */
async function downloadToFile(dir, url, signal, timeoutMs, kind, maxBytes) {
  await mkdir(dir, { recursive: true })
  const limit = maxBytes ?? 200 * 1024 * 1024
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {
    const ac = new AbortController()
    let timerFired = false
    const onAbort = () => ac.abort()
    const timer = setTimeout(() => {
      timerFired = true
      ac.abort()
    }, timeoutMs)
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    const tmp = join(dir, `.agnes-${kind}-${stamp()}-${Math.random().toString(36).slice(2, 6)}.part`)
    try {
      const resp = await fetch(url, { signal: ac.signal, redirect: 'follow' })
      if (!resp.ok) {
        const e = new Error(`${kind} 下载失败 HTTP ${resp.status}: ${url}`)
        // 4xx 是确定性错误（URL 过期/403/404），重试只会白等 3 秒并给出误导性的"重试"文案
        if (resp.status < 500 && resp.status !== 429) {
          e.nonRetryable = true
          throw e
        }
        lastErr = e
        throw e
      }
      const len = Number(resp.headers?.get?.('content-length') || 0)
      if (len && len > limit) throw new Error(`${kind} 体积 ${len} 字节超过上限 ${limit}`)
      const ext = extFromContent(resp.headers.get('content-type'), url)
      const file = join(dir, `agnes-${kind}-${stamp()}-${Math.random().toString(36).slice(2, 6)}${ext}`)
      const ws = createWriteStream(tmp)
      let total = 0
      try {
        const reader = resp.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > limit) {
            await reader.cancel().catch(() => {})
            throw new Error(`${kind} 体积超过上限 ${limit} 字节`)
          }
          if (!ws.write(Buffer.from(value))) {
            // 背压：等 drain。注意两个监听都要摘掉——原来每次背压都往 WriteStream 上叠一个
            // never-removed 的 error 监听器，下载大文件会触发 MaxListenersExceededWarning
            // （活体冒烟测试实测：11 error listeners added to [WriteStream]）
            await new Promise((res2, rej) => {
              const onDrain = () => { ws.off('error', onErr); res2() }
              const onErr = (e) => { ws.off('drain', onDrain); rej(e) }
              ws.once('drain', onDrain)
              ws.once('error', onErr)
            })
          }
        }
        await new Promise((res2, rej) => ws.end((err) => (err ? rej(err) : res2())))
      } catch (e) {
        ws.destroy()
        throw e
      }
      await rename(tmp, file)
      return file
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {})
      lastErr = err
      if (err?.nonRetryable) throw err
      if (signal?.aborted) throw err
      if (timerFired) throw new Error(`${kind} 下载超时（>${timeoutMs} ms）: ${url}`)
      if (attempt < 2) await sleep(Math.min(1000 * (attempt + 1), 4000), signal)
      else throw new Error(`${kind} 下载失败（重试 3 次仍失败）: ${err?.message ?? err} | URL: ${url}`)
    } finally {
      clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
    }
  }
  throw lastErr
}

/**
 * 默认产物目录：<DSH_HOME>/media（没设 DSH_HOME 就 ~/.dsh/media），再退 homedir/media、最后临时目录。
 * 为什么不用 process.cwd()：cwd 是**宿主进程**的工作目录，不是用户的工作区——
 * 本机实测宿主 cwd 恰好是工作区根目录（产物会散落在那），从开始菜单/服务方式启动时 cwd 多半是
 * 安装目录或 C:\Windows\System32（只读）→ 落盘这一步 EACCES 失败，
 * 而图/视频**已经生成并计费**了。先探可写性再落盘，别让钱白花。
 */
function defaultOutDir() {
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  const candidates = [join(home, 'media'), join(homedir(), 'media'), join(tmpdir(), 'dsh-agnes-media')]
  for (const dir of candidates) {
    try {
      mkdirSync(dir, { recursive: true })
      accessSync(dir, fsConstants.W_OK)
      return dir
    } catch { /* 试下一个 */ }
  }
  return join(tmpdir(), 'dsh-agnes-media')
}

/**
 * 产物目录：
 *  - config.outputDir：插件自己的目录，自动创建
 *  - saveTo（模型给的）：必须绝对路径、且**必须已存在**——插件不在任意路径自动建目录，
 *    免得被提示注入诱导在机器上到处建目录树；文件名由插件生成（唯一），不会覆盖别人的文件
 *  - 都没给：defaultOutDir()
 */
function resolveOutDir(saveTo, cfg) {
  if (saveTo !== undefined && saveTo !== null && String(saveTo).trim()) {
    const dir = String(saveTo).trim()
    if (!isAbsolute(dir)) throw new Error(`保存目录必须是绝对路径: ${dir}`)
    const abs = resolve(dir)
    if (!existsSync(abs)) {
      throw new Error(`保存目录不存在: ${abs}（插件不会在任意路径自动建目录；请先创建该目录，或改用 config.outputDir）`)
    }
    if (!statSync(abs).isDirectory()) throw new Error(`保存路径不是目录: ${abs}`)
    return abs
  }
  const cfgDir = String(cfg.outputDir ?? '').trim()
  return cfgDir ? resolve(cfgDir) : defaultOutDir()
}

/**
 * 内网/回环/链路本地地址判定。
 * 为什么拦：这些 URL 不是我们自己去取，而是**Agnes 服务端**去取——
 * 指向内网就等于借 Agnes 的手去探用户自己的内网。直接拒掉。
 */
function isPrivateHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!h) return true
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true
  if (h === '::1' || h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true
  return false
}

/** 只查主机：给识图的 URL 输入用（那里本地路径是合法的） */
function assertPublicHost(value, tool, field) {
  let u
  try { u = new URL(String(value)) } catch { throw new Error(`${tool}: ${field} 不是合法 URL: ${value}`) }
  if (isPrivateHost(u.hostname)) {
    throw new Error(`${tool}: ${field} 指向内网/回环地址（${u.hostname}），已拒绝——这类地址会被 Agnes 服务端去取，等于借它的手探内网。请改用公网可访问的地址。`)
  }
}

/** 媒体 URL 校验：Agnes 参考媒体必须公网可访问，本地路径直接拒绝并说明 */
function requirePublicUrl(value, field, tool) {
  if (!isUrl(value)) {
    throw new Error(`${tool}: ${field} 只接受 http(s) 公网 URL（Agnes 服务需要能直接访问参考媒体）；本地文件请先上传到可公开访问的地址。收到: ${value}`)
  }
  assertPublicHost(value, tool, field)
  return value
}

// ---------------------------------------------------------------- tools

function textContent(data) {
  const c = data?.choices?.[0]?.message?.content
  if (typeof c === 'string') return c.trim()
  if (Array.isArray(c)) return c.map((b) => (b?.type === 'text' ? b.text : '')).join('\n').trim()
  return ''
}

export function makeRecognizeTool(cfg, credentials) {
  return {
    name: 'agnes_image_recognize',
    description:
      '【可选能力 · 识图】用 Agnes 视觉模型识别图片，返回文字结果（截图分析、OCR、图表提取、图片描述、图内文字翻译等）。' +
      '图片传本地绝对路径或 http(s) URL（本地文件读盘后转 Data URI 发送），工具结果只有文字。' +
      '务必传明确具体的 prompt（如「把图中表格提取成 CSV」），不要依赖默认描述。',
    parameters: {
      type: 'object',
      properties: {
        image: {
          type: 'string',
          description: '本地图片绝对路径（如 D:\\xx\\a.png）或 http(s) URL（须公网可访问）',
        },
        prompt: {
          type: 'string',
          description: '给视觉模型的精确指令。缺省 = 详细描述图片内容',
        },
      },
      required: ['image'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          model: { type: 'string' },
          image: { type: 'string' },
          via: { type: 'string', enum: ['url', 'data-uri'] },
        },
        required: ['text', 'model', 'image', 'via'],
        additionalProperties: false,
      },
      render: (_args, v) => [{ type: 'text', text: `[Agnes 识图 · ${v.model} · ${v.via === 'url' ? 'URL 输入' : '本地文件(Data URI)'}]\n${v.text}` }],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      const apiKey = await requireKey(cfg, credentials)
      const image = String(args.image ?? '').trim()
      if (!image) throw new Error('agnes_image_recognize: `image` 不能为空')
      let imageUrl
      let via
      if (isUrl(image)) {
        assertPublicHost(image, 'agnes_image_recognize', 'image')
        imageUrl = image
        via = 'url'
      } else {
        imageUrl = await loadLocalImageAsDataUri(image, cfg.maxImageBytes, signal, 'agnes_image_recognize', cfg.allowedReadRoots)
        via = 'data-uri'
      }
      const prompt = String(args.prompt ?? '').trim() || '请详细描述这张图片的内容（主体、场景、图中文字、风格、可能的用途）。'
      const data = await agnesFetch(cfg, apiKey, {
        method: 'POST',
        path: '/chat/completions',
        body: {
          model: cfg.textModel,
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }],
        },
        signal,
        timeoutMs: cfg.httpTimeoutMs,
      })
      const text = textContent(data)
      if (!text) throw new Error('Agnes 未返回有效文本（可能内容被安全策略拦截，或模型异常）。原始响应: ' + JSON.stringify(data)?.slice(0, 300))
      return { text, model: cfg.textModel, image, via }
    },
  }
}

export function makeImageTool(cfg, credentials) {
  return {
    name: 'agnes_image_generate',
    description:
      '【主要功能 · 图生】用 Agnes 图像模型生成或编辑图片（不传 references = 文生图；传 references = 图生图/多图合成）。' +
      '成图自动下载到本地目录，工具结果只含本地路径与 URL。生成需数秒到数十秒。' +
      'references 可为本地绝对路径或 http(s) URL，最多 8 张；编辑指令写清「改什么 + 保留什么」。' +
      'size 填档位 1K/2K/3K/4K（配 ratio 宽高比）或精确尺寸（如 1920x1080）；返回的 size 是落盘文件的真实像素。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '生成描述或编辑指令。结构建议：[主体]+[场景]+[风格]+[光照]+[构图]+[质量]',
        },
        size: {
          type: 'string',
          description: '输出分辨率档位：1K/2K/3K/4K（agnes-image-2.1/2.5）；2.0 模型用精确尺寸如 1024x768。默认 1K',
        },
        ratio: {
          type: 'string',
          description: '宽高比：1:1(默认)、3:4、4:3、16:9、9:16、2:3、3:2、21:9（仅 2.1/2.5 支持）',
        },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: '参考图数组（本地绝对路径或 http(s) URL），文生图留空；最多 8 张',
        },
        saveTo: { type: 'string', description: '保存目录（绝对路径）。缺省用插件 config.outputDir' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          url: { type: 'string' },
          size: { type: 'string' },
          ratio: { type: 'string' },
          requestedSize: { type: 'string' },
          requestedRatio: { type: 'string' },
          sizeMapped: { type: 'boolean' },
          revisedPrompt: { type: 'string' },
        },
        required: ['path', 'url', 'size', 'ratio'],
        additionalProperties: false,
      },
      render: (_args, v) => [
        {
          type: 'text',
          text: `[Agnes 图生] 已保存到 ${v.path}（实际 ${v.size}${v.ratio ? ' ' + v.ratio : ''}，模型 ${cfg.imageModel}）。` +
            (v.sizeMapped ? `注意：接口把请求的精确尺寸 ${v.requestedSize} 映射成了 ${v.size}。` : '') +
            (v.requestedRatio && v.ratio && v.requestedRatio !== v.ratio ? `（请求画幅 ${v.requestedRatio}，实际按 ${v.ratio} 出图）` : '') +
            (v.url ? `原始 URL: ${v.url}` : '（接口未返回 URL，已直接落盘）') +
            (v.revisedPrompt ? `\n模型改写后的提示词: ${v.revisedPrompt}` : ''),
        },
      ],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      const apiKey = await requireKey(cfg, credentials)
      const prompt = String(args.prompt ?? '').trim()
      if (!prompt) throw new Error('agnes_image_generate: `prompt` 不能为空')
      // 2.0 模型只吃精确尺寸（传档位会 400），所以默认值跟着模型走
      const isLegacyImage = /image-2\.0/.test(cfg.imageModel)
      const size = String(args.size ?? (isLegacyImage ? '1024x768' : '1K'))
      const ratio = String(args.ratio ?? '1:1')
      if (isLegacyImage && IMAGE_SIZE_TIERS.has(size)) {
        throw new Error(`agnes_image_generate: 模型 ${cfg.imageModel} 只接受精确尺寸（如 1024x768），不能填档位 ${size}`)
      }
      if (!IMAGE_SIZE_TIERS.has(size) && !EXACT_SIZE_RE.test(size)) {
        throw new Error(`agnes_image_generate: size 只能是 ${[...IMAGE_SIZE_TIERS].join('/')} 或精确尺寸（如 1024x768），收到 ${JSON.stringify(args.size)}`)
      }
      if (!IMAGE_RATIOS.has(ratio)) {
        throw new Error(`agnes_image_generate: ratio 只能是 ${[...IMAGE_RATIOS].join('/')}，收到 ${JSON.stringify(args.ratio)}`)
      }
      const refs = requireArray(args.references, 'agnes_image_generate: references', 8)
      const resolvedRefs = []
      for (const r of refs) {
        const s = String(r ?? '').trim()
        if (!s) continue
        if (isUrl(s)) {
          assertPublicHost(s, 'agnes_image_generate', 'references[]')
          resolvedRefs.push(s)
        } else {
          resolvedRefs.push(await loadLocalImageAsDataUri(s, cfg.maxImageBytes, signal, 'agnes_image_generate', cfg.allowedReadRoots))
        }
      }
      const body = { model: cfg.imageModel, prompt, size, extra_body: { response_format: 'url' } }
      if (!/image-2\.0/.test(cfg.imageModel)) body.ratio = ratio
      if (resolvedRefs.length) body.extra_body.image = resolvedRefs
      const data = await agnesFetch(cfg, apiKey, {
        method: 'POST',
        path: '/images/generations',
        body,
        signal,
        timeoutMs: cfg.httpTimeoutMs,
      })
      const item = data?.data?.[0]
      const dir = resolveOutDir(args.saveTo, cfg)
      let file
      let url = ''
      if (item?.url) {
        url = item.url
        file = await downloadToFile(dir, url, signal, cfg.httpTimeoutMs, 'image', cfg.maxDownloadBytes)
      } else if (item?.b64_json) {
        // b64 直接落盘：绝不把 data: URL 写进工具结果（那等于把图片字节写进会话日志）
        const buf = Buffer.from(String(item.b64_json), 'base64')
        if (buf.length > (cfg.maxDownloadBytes ?? 200 * 1024 * 1024)) {
          throw new Error(`agnes_image_generate: 返回的图片 ${buf.length} 字节超过上限 ${cfg.maxDownloadBytes}`)
        }
        file = await writeBufferToFile(dir, buf, '.png', 'image')
      } else {
        throw new Error('Agnes 图像生成未返回可用结果。原始响应: ' + briefJson(data))
      }
      // 回报**实际**像素尺寸：接口会把精确尺寸映射到最接近的档位，只报回显值会骗人
      const dim = imageDimensions(file)
      const actual = dim ? dim.width + 'x' + dim.height : ''
      const actualRatio = dim ? ratioOf(dim.width, dim.height) : ''
      const out = { path: file, url, size: actual || size, ratio: actualRatio || ratio, requestedSize: size, requestedRatio: ratio }
      // 只有「请求了精确尺寸、接口却给了别的像素」才叫被映射；
      // 档位请求（2K）本来就会兑现成具体像素，那不是映射，是正常兑现
      // （布尔值始终给出，别让调用方去猜 undefined 是「没映射」还是「没测」）
      out.sizeMapped = !!(actual && EXACT_SIZE_RE.test(size) && actual !== size)
      if (item?.revised_prompt) out.revisedPrompt = item.revised_prompt
      return out
    },
  }
}

/**
 * 读图片文件头，拿**真实像素尺寸**。
 * 为什么需要：Agnes 会把「精确尺寸」映射到最接近的档位——传 1920x1080 可能只出 1312x736，
 * 而接口回显的 size 字段仍是原样传上去的值。只报回显值会骗人，所以这里读实际文件。
 * 只解析 PNG / JPEG；认不出来就返回 null（调用方回退到接口回显值）。
 */
export function imageDimensions(filePath) {
  let fd
  try {
    fd = openSync(filePath, 'r')
    // 256KB：有些 JPEG 前面塞了很大的 EXIF/ICC 段，64KB 窗口会读不到 SOFn
    const head = Buffer.alloc(256 * 1024)
    const n = readSync(fd, head, 0, head.length, 0)
    if (n >= 24 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      // PNG: IHDR 的宽高在偏移 16/20（大端）
      return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) }
    }
    if (n >= 4 && head[0] === 0xff && head[1] === 0xd8) {
      // JPEG: 逐段找 SOFn
      let i = 2
      while (i + 9 < n) {
        if (head[i] !== 0xff) { i++; continue }
        const marker = head[i + 1]
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
        const len = head.readUInt16BE(i + 2)
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: head.readUInt16BE(i + 5), width: head.readUInt16BE(i + 7) }
        }
        i += 2 + len
      }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* ignore */ } }
  }
}

export function makeVideoTool(cfg, credentials) {
  const flash = () => /-flash$/.test(cfg.videoModel)
  return {
    name: 'agnes_video_generate',
    description:
      '【主要功能 · 视频】用 Agnes 视频模型生成视频（异步任务：创建后轮询到完成，自动把 mp4 下载到本地目录）。' +
      'mode=text 纯文生视频；mode=keyframe 首帧/尾帧控制（firstFrame/lastFrame，至少一个）；' +
      'mode=reference 参考生成（images/audios/videos 至少一类非空，prompt 里用 <Picture N>、<Audio N>、<Video N> 指代素材，N 各自从 1 起）。' +
      '所有参考媒体只接受 http(s) 公网 URL（本地文件不行）。' +
      'seconds 为字符串 "4"–"12"（默认 "5"）；size：720P/1080P/1K/2K（flash 模型仅 720P）。结果只含本地路径与 URL。',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '视频内容描述。结构：[主体与场景]+[动作与变化]+[镜头语言]+[视觉风格]+[声音与节奏]+[一致性要求]' },
        mode: { type: 'string', enum: ['text', 'keyframe', 'reference'], description: '生成模式，默认 text' },
        seconds: { type: 'string', enum: ['4', '5', '6', '7', '8', '9', '10', '11', '12'], description: '视频时长（秒，字符串），默认 "5"' },
        size: { type: 'string', enum: ['720P', '1080P', '1K', '2K'], description: '输出分辨率档位，默认 720P（flash 模型强制 720P）' },
        aspectRatio: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'], description: '画幅比例，默认 16:9；不支持 auto/像素尺寸' },
        seed: { type: 'integer', description: '随机种子（相同种子提高可复现性）' },
        firstFrame: { type: 'string', description: 'keyframe 模式：首帧 http(s) URL。与 lastFrame 至少一个' },
        lastFrame: { type: 'string', description: 'keyframe 模式：尾帧 http(s) URL。与 firstFrame 至少一个' },
        images: { type: 'array', items: { type: 'string' }, description: 'reference 模式：参考图 http(s) URL 列表（flash 最多 5 张，标准最多 8 张）' },
        audios: { type: 'array', items: { type: 'string' }, description: 'reference 模式：参考音频 http(s) URL 列表（最多 3 段）' },
        videos: {
          type: 'array',
          description: 'reference 模式：参考视频（仅标准版 agnes-video-2.5，flash 不支持）',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string', description: '可公开访问的视频 URL' },
              startSeconds: { type: 'number', description: '从参考视频第 N 秒开始读取，默认 0' },
              requireAudio: { type: 'boolean', description: '要求参考视频必须含音轨，默认 false' },
            },
            required: ['url'],
            additionalProperties: false,
          },
        },
        saveTo: { type: 'string', description: '保存目录（绝对路径）。缺省用插件 config.outputDir' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          videoUrl: { type: 'string' },
          videoId: { type: 'string' },
          status: { type: 'string', enum: ['completed'] },
          seconds: { type: 'string' },
          size: { type: 'string' },
          elapsedMs: { type: 'integer' },
        },
        required: ['path', 'videoUrl', 'videoId', 'status', 'seconds', 'size', 'elapsedMs'],
        additionalProperties: false,
      },
      render: (_args, v) => [
        {
          type: 'text',
          text: `[Agnes 视频] 已保存到 ${v.path}（${v.seconds}s ${v.size}，模型 ${cfg.videoModel}，轮询耗时约 ${(v.elapsedMs / 1000).toFixed(0)}s，videoId=${v.videoId}）。原始 URL: ${v.videoUrl}`,
        },
      ],
    },
    async execute(args, exec) {
      const signal = exec?.signal
      const apiKey = await requireKey(cfg, credentials)
      const mode = String(args.mode ?? 'text')
      const seconds = String(args.seconds ?? '5')
      if (!['4', '5', '6', '7', '8', '9', '10', '11', '12'].includes(seconds)) {
        throw new Error(`agnes_video_generate: seconds 必须是 "4"–"12" 的字符串（收到 ${JSON.stringify(args.seconds)}）`)
      }
      const size = String(args.size ?? '720P')
      const aspectRatio = String(args.aspectRatio ?? '16:9')
      if (!VIDEO_MODES.has(mode)) {
        throw new Error(`agnes_video_generate: mode 只能是 ${[...VIDEO_MODES].join('/')}，收到 ${JSON.stringify(args.mode)}`)
      }
      if (!VIDEO_SIZES.has(size)) {
        throw new Error(`agnes_video_generate: size 只能是 ${[...VIDEO_SIZES].join('/')}，收到 ${JSON.stringify(args.size)}`)
      }
      if (!VIDEO_RATIOS.has(aspectRatio)) {
        throw new Error(`agnes_video_generate: aspectRatio 只能是 ${[...VIDEO_RATIOS].join('/')}，收到 ${JSON.stringify(args.aspectRatio)}`)
      }
      const imgUrls = requireArray(args.images, 'agnes_video_generate: images').map((u) => requirePublicUrl(u, 'images[]', 'agnes_video_generate'))
      const audioUrls = requireArray(args.audios, 'agnes_video_generate: audios').map((u) => requirePublicUrl(u, 'audios[]', 'agnes_video_generate'))
      const videoRefs = requireArray(args.videos, 'agnes_video_generate: videos')
        .map((v) => ({
            url: requirePublicUrl(v?.url, 'videos[].url', 'agnes_video_generate'),
            start_seconds: typeof v?.startSeconds === 'number' ? v.startSeconds : 0,
            require_audio: Boolean(v?.requireAudio),
          }))
      const firstFrame = args.firstFrame ? requirePublicUrl(args.firstFrame, 'firstFrame', 'agnes_video_generate') : undefined
      const lastFrame = args.lastFrame ? requirePublicUrl(args.lastFrame, 'lastFrame', 'agnes_video_generate') : undefined

      // 模式与媒体字段一致性（对应 Agnes 400 规则，提前报错省一次往返）
      if (mode === 'text' && (firstFrame || lastFrame || imgUrls.length || audioUrls.length || videoRefs.length)) {
        throw new Error('agnes_video_generate: mode=text 不允许携带任何媒体字段（firstFrame/lastFrame/images/audios/videos）')
      }
      if (mode === 'keyframe') {
        if (!firstFrame && !lastFrame) throw new Error('agnes_video_generate: mode=keyframe 需要 firstFrame 或 lastFrame 至少一个')
        if (imgUrls.length || audioUrls.length || videoRefs.length) throw new Error('agnes_video_generate: mode=keyframe 不允许 images/audios/videos')
      }
      if (mode === 'reference') {
        if (!imgUrls.length && !audioUrls.length && !videoRefs.length) {
          throw new Error('agnes_video_generate: mode=reference 需要 images、audios、videos 至少一类非空')
        }
        if (firstFrame || lastFrame) throw new Error('agnes_video_generate: mode=reference 不允许 firstFrame/lastFrame')
      }
      if (flash()) {
        if (size !== '720P') throw new Error(`agnes_video_generate: 当前视频模型 ${cfg.videoModel} 仅支持 size="720P"` )
        if (imgUrls.length > 5) throw new Error('agnes_video_generate: flash 模型参考图最多 5 张')
        if (audioUrls.length > 3) throw new Error('agnes_video_generate: flash 模型参考音频最多 3 段')
        if (videoRefs.length) throw new Error(`agnes_video_generate: flash 模型 ${cfg.videoModel} 不支持参考视频（videos）`)
      } else {
        // 标准模型的上限（Agnes 文档）：参考图 ≤8、参考音频 ≤3、参考视频 ≤1、媒体合计 ≤12
        if (imgUrls.length > 8) throw new Error('agnes_video_generate: 参考图最多 8 张')
        if (audioUrls.length > 3) throw new Error('agnes_video_generate: 参考音频最多 3 段')
        if (videoRefs.length > 1) throw new Error('agnes_video_generate: 参考视频最多 1 段')
        const mediaTotal = imgUrls.length + audioUrls.length + videoRefs.length
        if (mediaTotal > 12) throw new Error(`agnes_video_generate: 参考媒体合计最多 12 个（收到 ${mediaTotal}）`)
      }

      const body = {
        model: cfg.videoModel,
        prompt: String(args.prompt ?? '').trim(),
        mode,
        seconds,
        size,
        aspect_ratio: aspectRatio,
      }
      if (typeof args.seed === 'number') body.seed = args.seed
      if (firstFrame) body.first_frame = firstFrame
      if (lastFrame) body.last_frame = lastFrame
      if (mode === 'reference') {
        if (imgUrls.length) body.images = imgUrls
        if (audioUrls.length) body.audios = audioUrls
        if (videoRefs.length) body.videos = videoRefs
      }

      // 1) 创建任务
      const created = await agnesFetch(cfg, apiKey, {
        method: 'POST',
        path: '/videos',
        body,
        signal,
        timeoutMs: 60_000,
      })
      const videoId = created?.video_id || created?.id
      if (!videoId) throw new Error('Agnes 创建视频任务未返回 video_id。原始响应: ' + briefJson(created))

      // 2) 轮询（video_id + model_name，全部模式适用；429 指数退避）
      // 轮询端点在 baseUrl 的根级路径上（见 Agnes 文档），但要保留 baseUrl 的路径前缀，
      // 否则把 baseUrl 换成带前缀的部署地址时会打到错误的接口。
      const pollBase = cfg.baseUrl.replace(/\/+$/, '').replace(/\/v\d+(\.\d+)?$/, '')
      const query = () =>
        agnesFetch(cfg, apiKey, {
          method: 'GET',
          rawUrl: `${pollBase}/agnesapi?video_id=${encodeURIComponent(videoId)}&model_name=${encodeURIComponent(cfg.videoModel)}`,
          signal,
          timeoutMs: 60_000,
        })
      const startedAt = Date.now()
      const deadline = startedAt + cfg.pollTimeoutMs
      let interval = cfg.pollIntervalMs
      let consecutiveErrors = 0
      for (;;) {
        let q
        try {
          q = await query()
          consecutiveErrors = 0
        } catch (err) {
          // 限流 / 服务端故障 / 网络抖动：退避重试，别让已计费的任务因为一次抖动就废掉
          const msg = String(err?.message ?? err)
          const retryable = msg.includes('HTTP 429') || msg.includes('HTTP 5') ||
            msg.includes('网络错误') || msg.includes('请求超时')
          if (!retryable) throw err
          consecutiveErrors++
          if (consecutiveErrors > 20) {
            throw new Error(`agnes_video_generate: 连续 ${consecutiveErrors} 次查询失败，放弃轮询: ${msg}`)
          }
          interval = Math.min(interval * 2, 15_000)
        }
        const status = q?.status
        if (status === 'completed') {
          const videoUrl = q.url
          if (!videoUrl) throw new Error('Agnes 视频任务 completed 但未返回 url。原始响应: ' + briefJson(q))
          const dir = resolveOutDir(args.saveTo, cfg)
          const file = await downloadToFile(dir, videoUrl, signal, cfg.httpTimeoutMs, 'video', cfg.maxDownloadBytes)
          return {
            path: file,
            videoUrl,
            videoId,
            status: 'completed',
            seconds,
            size,
            elapsedMs: Date.now() - startedAt,
          }
        }
        if (status === 'failed') {
          throw new Error(`Agnes 视频任务失败: ${q?.error?.message ?? JSON.stringify(q?.error ?? {})}`)
        }
        if (Date.now() > deadline) {
          throw new Error(`agnes_video_generate: 轮询超时（>${cfg.pollTimeoutMs} ms），任务可能仍在排队/生成。video_id=${videoId}，可稍后手动查询: ${pollBase}/agnesapi?video_id=${videoId}&model_name=${cfg.videoModel}`)
        }
        if (q) interval = cfg.pollIntervalMs // 成功查询恢复默认间隔（429 退避过期）
        await sleep(interval, signal)
      }
    },
  }
}

// ---------------------------------------------------------------- apply

// 声明依赖：tools 服务就绪后才 apply（否则服务晚到会一个工具都注册不上）
export const inject = ['tools']

export function apply(ctx, config) {
  const cfg = cfgOf(config)
  const tools = ctx?.get?.('tools')
  if (!tools?.register) {
    console.warn('[dsh-agnes] tools 服务不可用，Agnes 工具未注册')
    return undefined
  }
  // 凭据服务按需现取（服务晚到时也能用上，而不是永久退回环境变量）
  const credentials = () => ctx?.get?.('credentials')
  // 主要功能（图生/视频）永远注册；识图是可选能力，enableRecognition=false 就不注册
  const offs = []
  if (cfg.enableRecognition !== false) offs.push(tools.register(makeRecognizeTool(cfg, credentials)))
  offs.push(tools.register(makeImageTool(cfg, credentials)))
  offs.push(tools.register(makeVideoTool(cfg, credentials)))
  console.info(
    `[dsh-agnes] 已注册 ${offs.length} 个 Agnes 工具（主要功能：图生/视频；可选：${cfg.enableRecognition === false ? '识图已关闭' : '识图'}；image=${cfg.imageModel} video=${cfg.videoModel}）`,
  )
  return () => {
    for (const off of offs) off?.()
  }
}
