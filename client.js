/**
 * @lingxinsuixing/dsh-agnes — Client 半边（Web UI 配置页）
 *
 * 在 `plugins.bundle.config` 槽注册（key = 本包名 @lingxinsuixing/dsh-agnes）：
 * Web 界面「插件 → @lingxinsuixing/dsh-agnes」页的描述与行之间显示中文配置面板，包含：
 *   1. 功能说明（三个工具做什么）
 *   2. API Key 配置（经 configForms 写回本 profile 的 config.apiKey，HMR 热生效）
 *   3. 权限说明（网络 / 本地文件 / 密钥 / 会话隐私 / 参考媒体）
 *
 * 纯 JS client 模块：只 require('react')（浏览器模块表），不引用宿主 client 包；
 * 样式用主题 token（var 带回退），控件自绘。
 * 模块级 inject = ['slots','locale','configForms']（硬依赖）：宿主 ui-settings 提供 configForms，
 * 服务就绪后 apply 才跑；面板里 configForms.get(ENTRY_ID) 拿不到表单时降级为"手改 patch"提示。
 */
window.__ModuleLoader__.load({
  id: '@lingxinsuixing/dsh-agnes',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useSyncExternalStore } = React

    const NS = 'dshAgnes'
    const ENTRY_ID = 'agnes-multimodal' // 本 bundle 在 patch 里的条目 id

    const EMPTY_SNAP = {
      status: 'unavailable',
      value: {},
      base: {},
      user: {},
      revision: 0,
      writable: false,
    }

    // 中文为主，en 作回退
    const dict = {
      en: {
        aboutTitle: 'What this plugin does',
        aboutBody:
          'Main features: Agnes image generation and video generation. Optional extra: image recognition, ' +
          'which can be switched off below. Generated images and videos are saved to a local folder and ' +
          'tool results are text-only — image and video bytes never enter the session log.',
        mainTitle: 'Main features',
        toolGenerate:
          '(main) Text-to-image / image-to-image / multi-image composition; the result is downloaded to a local directory, returning only the path and URL.',
        toolVideo:
          '(main) Text-to-video / first-last frame / reference generation; when the async task finishes, the mp4 is downloaded to a local directory, returning only the path and URL.',
        toolRecognize:
          '(optional, switchable below) Image recognition — screenshot analysis, OCR, chart/table extraction, in-image text translation. Local files are read and sent as Data URI, so image bytes stay out of the session log; the result is text only.',
        optTitle: 'Optional feature: image recognition',
        optBody:
          'Recognition sends the image to the Agnes vision model and brings back text only — no image bytes ' +
          'ever enter the conversation. Switch it off to keep only image and video generation. If the tool list ' +
          'does not change right away, restart DSH once.',
        optDeclare:
          'Statement: recognition works without changing the provider — it is independent of whether DSH uses ' +
          'openai-responses or openai-completions. Only DSH\u2019s own read_image needs the provider switched to ' +
          'openai-completions; without that switch, do not give the model image input, because one read_image ' +
          'bricks the whole conversation (400 is not retried and every turn rebuilds the full history).',
        enableLabel: 'Enable image recognition (agnes_image_recognize)',
        warnTitle: 'Do not use read_image inside the main conversation',
        warnBody:
          'Once a model is marked as supporting images, DSH’s own read_image puts an image content block into ' +
          'the conversation. The Agnes gateway’s /v1/responses endpoint does not understand input_image (its ' +
          'responses→chat bridge falls back to unknown), so the next request fails with a 400. A 400 is not retried, ' +
          'and every turn rebuilds the whole history from the session log — one bad message bricks the entire ' +
          'conversation and you have to start a new one. Use agnes_image_recognize instead: the image goes to the ' +
          'Agnes vision model and only text comes back.',
        keyTitle: 'API Key',
        keyBody:
          'Stored in this profile\u2019s plugin config (config.apiKey in cordis.patch.yml, in plain text) and applied live (no restart). Fallback order: this value \u2192 DSH credential store AGNES_API_KEY \u2192 env AGNES_API_KEY.',
        keyLabel: 'Agnes API Key',
        keyPlaceholder: 'cpk-\u2026',
        configured: 'Configured',
        notConfigured: 'Not configured',
        overridden: 'Set in this profile',
        save: 'Save',
        saving: 'Saving\u2026',
        saveOk: 'Saved. The tools will use the new key immediately.',
        saveFail: 'Save was not accepted. Try again or edit the profile\u2019s cordis.patch.yml manually.',
        readonly: 'Config is read-only in this deployment; edit the profile\u2019s cordis.patch.yml manually.',
        formMissing:
          'The config form is unavailable here. Set the key in the profile\u2019s cordis.patch.yml (agnes-multimodal \u2192 config.apiKey) or the AGNES_API_KEY env var.',
        show: 'Show',
        hide: 'Hide',
        statusUnavailable: 'Config status is unavailable.',
        permTitle: 'Permissions',
        permNetwork: 'Network: calls only the Agnes API (https://api.agnes-ai.cn) for recognition, image and video generation. No other outbound calls.',
        permFiles:
          'Local files: writes generated images/videos to a local directory (default: the media folder under the current working directory; configurable via config.outputDir).',
        permKey:
          'Key: the API key is kept in this profile\u2019s config / DSH credential store / env; it is never logged into the session.',
        permPrivacy:
          'Session privacy: image bytes and video files are not written to the session log; tool results contain text and local paths only.',
        permMedia:
          'Reference media: video reference generation and image references need publicly reachable http(s) URLs (the Agnes server must reach them). Local files are used only for recognition (Data URI).',
      },
      zh: {
        aboutTitle: '功能说明',
        aboutBody:
          '主要功能：Agnes 图片生成与视频生成。可选能力：图片识别，可在下面关掉。生成的图片与视频自动保存到本地文件夹，' +
          '工具结果只有文字——图片与视频字节不会进入会话日志。',
        mainTitle: '主要功能',
        toolGenerate:
          '（主要）文生图 / 图生图 / 多图合成，成图下载到本地目录，只回路径与 URL。',
        toolVideo:
          '（主要）文生视频 / 首尾帧 / 参考生成，异步任务完成后把 mp4 下载到本地目录，只回路径与 URL。',
        toolRecognize:
          '（可选，可在下关闭）识别图片——截图分析、OCR、图表/表格提取、图内文字翻译。本地图片读盘后转 Data URI 发送，图片字节不进会话日志，只回文字。',
        optTitle: '可选能力：图片识别',
        optBody:
          '识图把图片发给 Agnes 视觉模型，回来的只有文字，图片字节不会进对话。关掉它就只剩生图与生视频。' +
          '如果工具列表没有立刻变化，重启一次 DSH 即可。',
        optDeclare:
          '声明：识图功能不需要改 provider 就能用——它跟 DSH 的 openai-responses / openai-completions 无关。' +
          '只有 DSH 原生的 read_image 要在主会话里看图时，provider 才必须改成 openai-completions；' +
          '不改就别给模型勾图片输入能力，否则一次 read_image 就会把整个会话钉死（400 不重试 + 每轮重建全部历史）。',
        enableLabel: '启用识图（agnes_image_recognize）',
        warnTitle: '不要在主会话里用 read_image 看图',
        warnBody:
          '模型一旦勾上「支持图片」，DSH 自带的 read_image 就会把图片内容块塞进主会话；而 Agnes 网关的 ' +
          '/v1/responses 端点不认识 input_image（responses→chat 桥接时兜底成 unknown），下一轮直接 400。' +
          '400 不重试，且每轮请求都会从会话日志重建全部历史——一条坏消息就能钉死整个会话，只能新开。' +
          '要看图请用下面的 agnes_image_recognize：图片发给 Agnes 视觉模型，回会话的只有文字。',
        keyTitle: 'API Key 配置',
        keyBody:
          '保存后写入本 profile 的插件配置（cordis.patch.yml 里的 config.apiKey，明文）并立即热生效（无需重启）。回退顺序：此处保存的值 → DSH 凭据库 AGNES_API_KEY → 环境变量 AGNES_API_KEY。',
        keyLabel: 'Agnes API Key',
        keyPlaceholder: 'cpk-…',
        configured: '已配置',
        notConfigured: '未配置',
        overridden: '本 profile 已设置',
        save: '保存',
        saving: '保存中…',
        saveOk: '已保存，工具将立即使用新 Key。',
        saveFail: '保存未被接受，请重试或手改 profile 的 cordis.patch.yml。',
        readonly: '本部署的配置为只读，无法在此保存；请手改 profile 的 cordis.patch.yml。',
        formMissing:
          '此处无法获取配置表单。请在 profile 的 cordis.patch.yml 设置 agnes-multimodal → config.apiKey，或设环境变量 AGNES_API_KEY。',
        show: '显示',
        hide: '隐藏',
        statusUnavailable: '配置状态读取不可用。',
        permTitle: '权限说明',
        permNetwork: '网络：仅调用 Agnes API（https://api.agnes-ai.cn）做识图、图生、视频生成；不做其他外呼。',
        permFiles:
          '本地文件：把生成的图片/视频写入本地目录（默认当前工作目录下的 media 子目录，可用 config.outputDir 改）。',
        permKey: '密钥：API Key 保存在本 profile 配置（明文）/ DSH 凭据库 / 环境变量，不会进入会话日志。',
        permPrivacy: '会话隐私：图片字节与视频文件不写入会话记录；工具结果只有文字与本地路径。',
        permMedia:
          '参考媒体：视频参考生成与图生参考图需要可公网访问的 http(s) URL（Agnes 服务端要能直接访问）；本地文件仅用于识图（Data URI）。',
      },
    }

    const CSS = `
.agn-panel{display:flex;flex-direction:column;gap:16px;font-size:13px;line-height:1.6}
.agn-panel h3{margin:0 0 6px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.agn-panel p{margin:0;color:var(--dsw-alias-label-secondary,#57606a)}
.agn-panel ul{margin:4px 0 0;padding-left:18px;color:var(--dsw-alias-label-secondary,#57606a)}
.agn-panel li{margin:2px 0}
.agn-krow{display:flex;gap:8px;align-items:center;margin-top:8px;flex-wrap:wrap}
.agn-klabel{min-width:110px}
.agn-input{flex:1;min-width:220px;min-height:30px;padding:4px 8px;border:1px solid var(--dsw-alias-border,#d0d7de);border-radius:6px;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);font:inherit}
.agn-btn{min-height:30px;padding:4px 12px;border:1px solid var(--dsw-alias-border,#d0d7de);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font:inherit;cursor:pointer}
.agn-btn:disabled{opacity:.5;cursor:default}
.agn-btn-primary{background:var(--dsw-alias-bg-emphasis,#0b6ea8);color:#fff;border-color:transparent}
.agn-tag{font-size:11px;padding:1px 6px;border-radius:9999px;border:1px solid var(--dsw-alias-border,#d0d7de);color:var(--dsw-alias-label-secondary,#57606a)}
.agn-tag.ok{color:#1a7f37;border-color:currentColor}
.agn-status{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}
.agn-status-ok{color:#1a7f37}
.agn-status-err{color:#c0392b}
.agn-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.agn-warn{border-left:3px solid #d29922;background:rgba(210,153,34,.08);padding:8px 10px;border-radius:0 6px 6px 0;margin:0}
.agn-warn h3{margin:0 0 4px;color:var(--dsw-alias-label-primary,inherit)}
.agn-warn p{margin:0}
.agn-check{display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer}
.agn-check input{width:15px;height:15px;margin:0;cursor:pointer}
`

    function AgnesPanel(props) {
      const { form, t } = props
      const snap = useSyncExternalStore(
        form ? (cb) => form.subscribe(cb) : () => {},
        () => (form ? form.getSnapshot() : EMPTY_SNAP),
        () => EMPTY_SNAP,
      )
      const writable = snap.writable === true
      const status = snap.status || 'unavailable'
      const value = snap.value || {}
      const user = snap.user || {}
      const currentKey = typeof value.apiKey === 'string' ? value.apiKey : ''
      const configured = currentKey.length > 0
      const overridden = Object.prototype.hasOwnProperty.call(user, 'apiKey')

      const [draft, setDraft] = useState(currentKey)
      const [show, setShow] = useState(false)
      const [saving, setSaving] = useState(false)
      const [msg, setMsg] = useState(null) // { kind: 'ok' | 'err', text }
      const [optMsg, setOptMsg] = useState(null) // 可选能力开关自己的提示
      // 可选能力开关：enableRecognition 默认 true（=注册识图工具）
      const recogEnabled = value.enableRecognition !== false
      const [recogDraft, setRecogDraft] = useState(recogEnabled)

      useEffect(() => {
        setDraft(currentKey)
      }, [currentKey])

      useEffect(() => {
        setRecogDraft(recogEnabled)
      }, [recogEnabled])

      async function save() {
        if (!form || !writable || saving) return
        setSaving(true)
        setMsg(null)
        try {
          const ok = await form.set('apiKey', draft.trim())
          setMsg(ok ? { kind: 'ok', text: t('saveOk') } : { kind: 'err', text: t('saveFail') })
        } catch (e) {
          setMsg({ kind: 'err', text: t('saveFail') + '（' + (e && e.message ? e.message : e) + '）' })
        } finally {
          setSaving(false)
        }
      }

      async function toggleRecognition(next) {
        if (!form || !writable || saving) return
        setSaving(true)
        setOptMsg(null)
        try {
          const ok = await form.set('enableRecognition', next)
          if (ok) setRecogDraft(next)
          setOptMsg(ok ? { kind: 'ok', text: t('saveOk') } : { kind: 'err', text: t('saveFail') })
        } catch (e) {
          setOptMsg({ kind: 'err', text: t('saveFail') + '（' + (e && e.message ? e.message : e) + '）' })
        } finally {
          setSaving(false)
        }
      }

      return h('div', { className: 'agn-panel' },
        h('style', { key: 'agn-css' }, CSS),

        // 1) 功能说明（主要功能在前，可选能力在后）
        h('section', null,
          h('h3', null, t('aboutTitle')),
          h('p', null, t('aboutBody')),
          h('ul', null,
            h('li', null, h('b', { className: 'agn-mono' }, 'agnes_image_generate'), '：', t('toolGenerate')),
            h('li', null, h('b', { className: 'agn-mono' }, 'agnes_video_generate'), '：', t('toolVideo')),
            h('li', null, h('b', { className: 'agn-mono' }, 'agnes_image_recognize'), '：', t('toolRecognize')),
          ),
        ),

        // 2) ⚠️ 警告：别在主会话里用 read_image 看图
        h('section', null,
          h('div', { className: 'agn-warn' },
            h('h3', null, t('warnTitle')),
            h('p', null, t('warnBody')),
          ),
        ),

        // 3) API Key 配置
        h('section', null,
          h('h3', null, t('keyTitle')),
          h('p', null, t('keyBody')),
          form
            ? h('div', null,
                h('div', { className: 'agn-krow' },
                  h('span', { className: 'agn-klabel' }, t('keyLabel')),
                  h('span', { className: 'agn-tag ' + (configured ? 'ok' : '') },
                    configured ? t('configured') : t('notConfigured')),
                  overridden && h('span', { className: 'agn-tag' }, t('overridden')),
                ),
                h('div', { className: 'agn-krow' },
                  h('input', {
                    className: 'agn-input',
                    type: show ? 'text' : 'password',
                    value: draft,
                    placeholder: t('keyPlaceholder'),
                    disabled: !writable || saving,
                    onChange: (e) => setDraft(e.target.value),
                    'aria-label': t('keyLabel'),
                  }),
                  h('button', {
                    className: 'agn-btn',
                    type: 'button',
                    onClick: () => setShow((s) => !s),
                    disabled: !writable || saving,
                  }, show ? t('hide') : t('show')),
                ),
                h('div', { className: 'agn-krow' },
                  h('button', {
                    className: 'agn-btn agn-btn-primary',
                    type: 'button',
                    onClick: save,
                    disabled: !writable || saving || draft === currentKey,
                  }, saving ? t('saving') : t('save')),
                ),
                msg && h('p', { className: 'agn-status ' + (msg.kind === 'ok' ? 'agn-status-ok' : 'agn-status-err'), role: 'status' }, msg.text),
                !writable && h('p', { className: 'agn-status-err agn-status', role: 'status' }, t('readonly')),
                status === 'unavailable' && h('p', { className: 'agn-status', role: 'status' }, t('statusUnavailable')),
              )
            : h('p', { className: 'agn-status', role: 'status' }, t('formMissing')),
        ),

        // 4) 可选能力开关：识图
        h('section', null,
          h('h3', null, t('optTitle')),
          h('p', null, t('optBody')),
          h('p', { className: 'agn-status' }, t('optDeclare')),
          form
            ? h('label', { className: 'agn-check' },
                h('input', {
                  type: 'checkbox',
                  checked: recogDraft,
                  disabled: !writable || saving,
                  onChange: (e) => toggleRecognition(e.target.checked),
                }),
                h('span', null, t('enableLabel')),
              )
            : h('p', { className: 'agn-status', role: 'status' }, t('formMissing')),
          optMsg && h('p', { className: 'agn-status ' + (optMsg.kind === 'ok' ? 'agn-status-ok' : 'agn-status-err'), role: 'status' }, optMsg.text),
        ),

        // 5) 权限说明
        h('section', null,
          h('h3', null, t('permTitle')),
          h('ul', null,
            h('li', null, t('permNetwork')),
            h('li', null, t('permFiles')),
            h('li', null, t('permKey')),
            h('li', null, t('permPrivacy')),
            h('li', null, t('permMedia')),
          ),
        ),
      )
    }

    return {
      // 模块级硬依赖：apply 等服务就绪后才跑（configForms 由宿主 ui-settings 提供）
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        const offLocale = ctx.locale
          ? ctx.locale.register(NS, dict)
          : undefined
        const t = ctx.locale
          ? ctx.locale.bind(NS)
          : (k) => dict.zh[k] ?? dict.en[k] ?? k
        const form = ctx.configForms ? ctx.configForms.get(ENTRY_ID) : undefined
        const offSlot = ctx.slots.inject('plugins.bundle.config', () =>
          ctx.slots.register(
            {
              name: 'plugins.bundle.config',
              key: '@lingxinsuixing/dsh-agnes',
              locale: NS,
              inject: () => ({ form, t }),
            },
            AgnesPanel,
          ),
        )
        return () => {
          offSlot && offSlot()
          offLocale && offLocale()
        }
      },
    }
  },
})
