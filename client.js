/**
 * @lingxinsuixing/dsh-agnes — Client 半边（Web UI 配置页）
 *
 * 在 `plugins.bundle.config` 槽注册（key = 本包名 @lingxinsuixing/dsh-agnes）：
 * Web 界面「插件 → @lingxinsuixing/dsh-agnes」页的描述与行之间显示中文配置面板，包含：
 *   1. 功能说明（主要功能 2 个 + 可选能力 1 个，分组列出）+ 免费模型提示与官方模型文档链接
 *   2. API Key 配置（经 configForms 写回本 profile 的 config.apiKey，HMR 热生效）
 *   3. 模型选择（config.textModel / imageModel / videoModel，默认值写在文案里）
 *   4. 产物目录与读取白名单（config.outputDir / config.allowedReadRoots）
 *   5. 可选能力开关（config.enableRecognition；**改完要重启 DSH** 才重新注册工具）
 *   6. 权限说明（网络 / 本地文件 / 密钥 / 会话隐私 / 参考媒体）
 *
 * 工具分层：
 *   主要功能（永远注册）：agnes_image_generate（生图）、agnes_video_generate（生视频）
 *   可选能力（带开关）：  agnes_image_recognize（识图）——由 config.enableRecognition 控制，
 *                        面板上的复选框直接写这个字段；**改完要重启一次 DSH** 才生效（工具在加载时注册）
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
        optGroup: 'Optional feature',
        optTitle: 'Optional feature: image recognition',
        optBody:
          'Recognition sends the image to the Agnes vision model and brings back text only — no image bytes ' +
          'ever enter the conversation. Switch it off to keep only image and video generation.',
        optRestart:
          'After switching, restart DSH once to apply it: tools are registered while the plugin loads, so a ' +
          'config change does not re-register them.',
        optDeclare:
          'Statement: recognition works without changing the provider — it is independent of whether DSH uses ' +
          'openai-responses or openai-completions. Only DSH\u2019s own read_image needs the provider switched to ' +
          'openai-completions; without that switch, do not give the model image input, because one read_image ' +
          'bricks the whole conversation (400 is not retried and every turn rebuilds the full history).',
        optOkOn: 'Recognition is enabled. Restart DSH once to apply it.',
        optOkOff: 'Recognition is disabled. Restart DSH once to apply it.',
        optFail: 'The change was not accepted. Try again or edit the profile\u2019s cordis.patch.yml manually.',
        pathsTitle: 'Output folder and read scope',
        pathsBody:
          'outputDir: where generated images and videos are written (empty = the media folder under the DSH home ' +
          'directory, $DSH_HOME/media or ~/.dsh/media). allowedReadRoots: only these folders may be read for ' +
          'recognition (empty = no restriction). Both apply from the next call on.',
        outDirLabel: 'Output folder (outputDir)',
        outDirPlaceholder: 'empty = $DSH_HOME/media',
        rootsLabel: 'Local read allowlist (allowedReadRoots)',
        rootsPlaceholder: 'comma-separated absolute paths; empty = no restriction',
        pathsSave: 'Save',
        pathsSaving: 'Saving\u2026',
        pathsOk: 'Saved. The new settings apply from the next call on.',
        pathsFail: 'The change was not accepted. Try again or edit the profile\u2019s cordis.patch.yml manually.',
        modelTitle: 'Models',
        modelBody:
          'Defaults: recognition uses agnes-3.0-flash, image generation uses agnes-image-2.5-flash, video uses ' +
          'agnes-video-2.5. The whole image model line is currently free; the video line also has a free tier ' +
          '(agnes-video-2.5-flash) that outputs 720P only and cannot take a reference video. Model list:',
        modelsLink: 'https://www.agnes-ai.cn/zh-Hans/docs/overview',
        textModelLabel: 'Recognition model (textModel)',
        textModelPlaceholder: 'agnes-3.0-flash / agnes-2.5-flash / agnes-3.0-pro',
        imageModelLabel: 'Image model (imageModel)',
        imageModelPlaceholder: 'agnes-image-2.5-flash / 2.1-flash / 2.0-flash (2.0 takes exact sizes only)',
        videoModelLabel: 'Video model (videoModel)',
        videoModelPlaceholder: 'agnes-video-2.5 (standard) / 2.5-flash (free tier, 720P only)',
        modelSave: 'Save models',
        modelSaving: 'Saving\u2026',
        modelOk: 'Saved. The new models are used by the next call.',
        modelFail: 'The change was not accepted. Try again or edit the profile\u2019s cordis.patch.yml manually.',
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
          'Local files: writes generated images/videos to a local directory (default: the media folder under the DSH home directory — $DSH_HOME/media, or ~/.dsh/media; configurable via config.outputDir). A saveTo argument must point to an existing directory.',
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
        optGroup: '可选能力',
        optTitle: '可选能力：图片识别',
        optBody:
          '识图把图片发给 Agnes 视觉模型，回来的只有文字，图片字节不会进对话。关掉它就只剩生图与生视频。',
        optRestart:
          '切换后需要重启一次 DSH 才生效：工具是在插件加载时注册的，改配置不会重新注册工具。',
        optDeclare:
          '声明：识图功能不需要改 provider 就能用——它跟 DSH 的 openai-responses / openai-completions 无关。' +
          '只有 DSH 原生的 read_image 要在主会话里看图时，provider 才必须改成 openai-completions；' +
          '不改就别给模型勾图片输入能力，否则一次 read_image 就会把整个会话钉死（400 不重试 + 每轮重建全部历史）。',
        optOkOn: '已启用识图。重启一次 DSH 后生效。',
        optOkOff: '已关闭识图。重启一次 DSH 后生效。',
        optFail: '改动未被接受，请重试或手改 profile 的 cordis.patch.yml。',
        pathsTitle: '产物目录与读取范围',
        pathsBody:
          'outputDir：生成的图片与视频写到哪个目录（留空 = DSH 主目录下的 media 子目录，即 $DSH_HOME/media，没设则 ~/.dsh/media）。' +
          'allowedReadRoots：识图只允许读这些目录里的文件（留空 = 不限制）。两项都从下一次调用起生效。',
        outDirLabel: '产物目录（outputDir）',
        outDirPlaceholder: '留空 = $DSH_HOME/media',
        rootsLabel: '本地读取白名单（allowedReadRoots）',
        rootsPlaceholder: '逗号分隔的绝对路径；留空 = 不限制',
        pathsSave: '保存',
        pathsSaving: '保存中…',
        pathsOk: '已保存，从下一次调用起生效。',
        pathsFail: '改动未被接受，请重试或手改 profile 的 cordis.patch.yml。',
        modelsLink: 'https://www.agnes-ai.cn/zh-Hans/docs/overview',
        modelTitle: '模型',
        modelBody:
          '默认：识图用 agnes-3.0-flash，生图用 agnes-image-2.5-flash，生视频用 agnes-video-2.5。' +
          '生图全系当前免费；视频也有免费档（agnes-video-2.5-flash），但只出 720P，且不能带参考视频。模型清单：',
        textModelLabel: '识图模型（textModel）',
        textModelPlaceholder: 'agnes-3.0-flash / agnes-2.5-flash / agnes-3.0-pro',
        imageModelLabel: '生图模型（imageModel）',
        imageModelPlaceholder: 'agnes-image-2.5-flash / 2.1-flash / 2.0-flash（2.0 只接精确尺寸）',
        videoModelLabel: '生视频模型（videoModel）',
        videoModelPlaceholder: 'agnes-video-2.5（标准版）/ 2.5-flash（免费档，仅 720P）',
        modelSave: '保存模型',
        modelSaving: '保存中…',
        modelOk: '已保存，下一次调用起使用新模型。',
        modelFail: '改动未被接受，请重试或手改 profile 的 cordis.patch.yml。',
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
          '本地文件：把生成的图片/视频写入本地目录（默认 DSH 主目录下的 media 子目录，即 $DSH_HOME/media，没设则用 ~/.dsh/media，可用 config.outputDir 改）。saveTo 必须指向已存在的目录。',
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
.agn-tag.ok{color:var(--dsw-alias-state-success-primary,#1a7f37);border-color:currentColor}
.agn-status{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary,#57606a)}
.agn-status-ok{color:var(--dsw-alias-state-success-primary,#1a7f37)}
.agn-status-err{color:var(--dsw-alias-state-error-primary,#c0392b)}
.agn-mono{font-family:ui-monospace,Consolas,monospace;font-size:12px}
.agn-sub{margin:10px 0 2px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}
.agn-warn{border-left:3px solid var(--dsw-alias-state-warn-primary,#d29922);background:var(--dsw-alias-state-warn-tertiary,rgba(210,153,34,.08));padding:8px 10px;border-radius:0 6px 6px 0;margin:0}
.agn-warn h3{margin:0 0 4px;color:var(--dsw-alias-state-warn-primary,inherit)}
.agn-warn p{margin:0;color:var(--dsw-alias-label-secondary,#57606a)}
.agn-check{display:flex;gap:8px;align-items:center;margin-top:8px;cursor:pointer}
.agn-check input{width:15px;height:15px;margin:0;cursor:pointer}
.agn-panel a{color:var(--dsw-alias-state-info-primary,#0969da);text-decoration:underline}
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
      const [savingKey, setSavingKey] = useState(false) // 只管 Key 保存
      const [savingOpt, setSavingOpt] = useState(false) // 只管识图开关，两者互不影响
      const [msg, setMsg] = useState(null) // { kind: 'ok' | 'err', text }
      const [optMsg, setOptMsg] = useState(null) // 可选能力开关自己的提示
      // 可选能力开关：enableRecognition 默认 true（=注册识图工具）
      const recogEnabled = value.enableRecognition !== false
      const [recogDraft, setRecogDraft] = useState(recogEnabled)

      // 产物目录（outputDir）与本地读取白名单（allowedReadRoots：数组或逗号分隔字符串都认）
      const outDirValue = typeof value.outputDir === 'string' ? value.outputDir : ''
      const rootsValue = Array.isArray(value.allowedReadRoots)
        ? value.allowedReadRoots.join(', ')
        : typeof value.allowedReadRoots === 'string'
          ? value.allowedReadRoots
          : ''
      const [outDirDraft, setOutDirDraft] = useState(outDirValue)
      const [rootsDraft, setRootsDraft] = useState(rootsValue)
      const [savingPaths, setSavingPaths] = useState(false)
      const [pathsMsg, setPathsMsg] = useState(null)

      // 三个模型：识图（对话模型）/ 生图 / 生视频
      const textModelValue = typeof value.textModel === 'string' ? value.textModel : ''
      const imageModelValue = typeof value.imageModel === 'string' ? value.imageModel : ''
      const videoModelValue = typeof value.videoModel === 'string' ? value.videoModel : ''
      const [textModelDraft, setTextModelDraft] = useState(textModelValue)
      const [imageModelDraft, setImageModelDraft] = useState(imageModelValue)
      const [videoModelDraft, setVideoModelDraft] = useState(videoModelValue)
      const [savingModels, setSavingModels] = useState(false)
      const [modelsMsg, setModelsMsg] = useState(null)

      useEffect(() => {
        setDraft(currentKey)
      }, [currentKey])

      useEffect(() => {
        setRecogDraft(recogEnabled)
      }, [recogEnabled])

      useEffect(() => {
        setOutDirDraft(outDirValue)
      }, [outDirValue])

      useEffect(() => {
        setRootsDraft(rootsValue)
      }, [rootsValue])

      useEffect(() => {
        setTextModelDraft(textModelValue)
      }, [textModelValue])

      useEffect(() => {
        setImageModelDraft(imageModelValue)
      }, [imageModelValue])

      useEffect(() => {
        setVideoModelDraft(videoModelValue)
      }, [videoModelValue])

      async function save() {
        if (!form || !writable || savingKey) return
        setSavingKey(true)
        setMsg(null)
        try {
          const ok = await form.set('apiKey', draft.trim())
          setMsg(ok ? { kind: 'ok', text: t('saveOk') } : { kind: 'err', text: t('saveFail') })
        } catch {
          // 不回显原始异常信息（可能带出密钥内容），只给通用失败文案
          setMsg({ kind: 'err', text: t('saveFail') })
        } finally {
          setSavingKey(false)
        }
      }

      async function savePaths() {
        if (!form || !writable || savingPaths) return
        setSavingPaths(true)
        setPathsMsg(null)
        try {
          // 白名单写逗号分隔字符串：YAML 里一个标量最稳，不会把 patch 写坏；
          // 插件侧 normalizeReadRoots 会把它拆回数组（schema 也接受数组）
          const roots = rootsDraft.split(',').map((s) => s.trim()).filter(Boolean).join(', ')
          const okDir = await form.set('outputDir', outDirDraft.trim())
          const okRoots = await form.set('allowedReadRoots', roots)
          setPathsMsg(okDir && okRoots ? { kind: 'ok', text: t('pathsOk') } : { kind: 'err', text: t('pathsFail') })
        } catch {
          setPathsMsg({ kind: 'err', text: t('pathsFail') })
        } finally {
          setSavingPaths(false)
        }
      }

      async function saveModels() {
        if (!form || !writable || savingModels) return
        setSavingModels(true)
        setModelsMsg(null)
        try {
          const ok1 = await form.set('textModel', textModelDraft.trim())
          const ok2 = await form.set('imageModel', imageModelDraft.trim())
          const ok3 = await form.set('videoModel', videoModelDraft.trim())
          setModelsMsg(ok1 && ok2 && ok3 ? { kind: 'ok', text: t('modelOk') } : { kind: 'err', text: t('modelFail') })
        } catch {
          setModelsMsg({ kind: 'err', text: t('modelFail') })
        } finally {
          setSavingModels(false)
        }
      }

      async function toggleRecognition(next) {
        if (!form || !writable || savingOpt) return
        setSavingOpt(true)
        setOptMsg(null)
        // 乐观更新：先把开关拨到目标状态，别让用户等一次往返才看到反应；
        // 服务端拒绝或抛错时回滚到已知状态（recogEnabled 来自配置快照）。
        setRecogDraft(next)
        try {
          const ok = await form.set('enableRecognition', next)
          if (ok) {
            setOptMsg({ kind: 'ok', text: next ? t('optOkOn') : t('optOkOff') })
          } else {
            setRecogDraft(recogEnabled)
            setOptMsg({ kind: 'err', text: t('optFail') })
          }
        } catch {
          setRecogDraft(recogEnabled)
          setOptMsg({ kind: 'err', text: t('optFail') })
        } finally {
          setSavingOpt(false)
        }
      }

      return h('div', { className: 'agn-panel' },
        h('style', { key: 'agn-css' }, CSS),

        // 1) 功能说明（主要功能在前，可选能力在后）
        h('section', null,
          h('h3', null, t('aboutTitle')),
          h('p', null, t('aboutBody')),
          h('h4', { className: 'agn-sub' }, t('mainTitle')),
          h('ul', null,
            h('li', null, h('b', { className: 'agn-mono' }, 'agnes_image_generate'), '：', t('toolGenerate')),
            h('li', null, h('b', { className: 'agn-mono' }, 'agnes_video_generate'), '：', t('toolVideo')),
          ),
          h('h4', { className: 'agn-sub' }, t('optGroup')),
          h('ul', null,
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
                    disabled: !writable || savingKey,
                    onChange: (e) => setDraft(e.target.value),
                    'aria-label': t('keyLabel'),
                  }),
                  h('button', {
                    className: 'agn-btn',
                    type: 'button',
                    onClick: () => setShow((s) => !s),
                    disabled: !writable || savingKey,
                  }, show ? t('hide') : t('show')),
                ),
                h('div', { className: 'agn-krow' },
                  h('button', {
                    className: 'agn-btn agn-btn-primary',
                    type: 'button',
                    onClick: save,
                    disabled: !writable || savingKey || draft === currentKey,
                  }, savingKey ? t('saving') : t('save')),
                ),
                msg && h('p', { className: 'agn-status ' + (msg.kind === 'ok' ? 'agn-status-ok' : 'agn-status-err'), role: 'status' }, msg.text),
                !writable && h('p', { className: 'agn-status-err agn-status', role: 'status' }, t('readonly')),
                status === 'unavailable' && h('p', { className: 'agn-status', role: 'status' }, t('statusUnavailable')),
              )
            : h('p', { className: 'agn-status', role: 'status' }, t('formMissing')),
        ),

        // 3) 模型（识图 / 生图 / 生视频）
        h('section', null,
          h('h3', null, t('modelTitle')),
          h('p', null, t('modelBody'), ' ',
            h('a', {
              href: 'https://www.agnes-ai.cn/zh-Hans/docs/overview',
              target: '_blank',
              rel: 'noreferrer',
            }, t('modelsLink')),
          ),
          form
            ? h('div', null,
                h('div', { className: 'agn-krow' },
                  h('span', { className: 'agn-klabel' }, t('textModelLabel')),
                  h('input', {
                    className: 'agn-input',
                    type: 'text',
                    value: textModelDraft,
                    placeholder: t('textModelPlaceholder'),
                    disabled: !writable || savingModels,
                    onChange: (e) => setTextModelDraft(e.target.value),
                    'aria-label': t('textModelLabel'),
                  }),
                ),
                h('div', { className: 'agn-krow' },
                  h('span', { className: 'agn-klabel' }, t('imageModelLabel')),
                  h('input', {
                    className: 'agn-input',
                    type: 'text',
                    value: imageModelDraft,
                    placeholder: t('imageModelPlaceholder'),
                    disabled: !writable || savingModels,
                    onChange: (e) => setImageModelDraft(e.target.value),
                    'aria-label': t('imageModelLabel'),
                  }),
                ),
                h('div', { className: 'agn-krow' },
                  h('span', { className: 'agn-klabel' }, t('videoModelLabel')),
                  h('input', {
                    className: 'agn-input',
                    type: 'text',
                    value: videoModelDraft,
                    placeholder: t('videoModelPlaceholder'),
                    disabled: !writable || savingModels,
                    onChange: (e) => setVideoModelDraft(e.target.value),
                    'aria-label': t('videoModelLabel'),
                  }),
                ),
                h('div', { className: 'agn-krow' },
                  h('button', {
                    className: 'agn-btn agn-btn-primary',
                    type: 'button',
                    onClick: saveModels,
                    disabled: !writable || savingModels,
                  }, savingModels ? t('modelSaving') : t('modelSave')),
                ),
                modelsMsg && h('p', { className: 'agn-status ' + (modelsMsg.kind === 'ok' ? 'agn-status-ok' : 'agn-status-err'), role: 'status' }, modelsMsg.text),
              )
            : h('p', { className: 'agn-status', role: 'status' }, t('formMissing')),
        ),

        // 3.5) 产物目录与读取白名单
        h('section', null,
          h('h3', null, t('pathsTitle')),
          h('p', null, t('pathsBody')),
          form
            ? h('div', null,
                h('div', { className: 'agn-krow' },
                  h('span', { className: 'agn-klabel' }, t('outDirLabel')),
                  h('input', {
                    className: 'agn-input',
                    type: 'text',
                    value: outDirDraft,
                    placeholder: t('outDirPlaceholder'),
                    disabled: !writable || savingPaths,
                    onChange: (e) => setOutDirDraft(e.target.value),
                    'aria-label': t('outDirLabel'),
                  }),
                ),
                h('div', { className: 'agn-krow' },
                  h('span', { className: 'agn-klabel' }, t('rootsLabel')),
                  h('input', {
                    className: 'agn-input',
                    type: 'text',
                    value: rootsDraft,
                    placeholder: t('rootsPlaceholder'),
                    disabled: !writable || savingPaths,
                    onChange: (e) => setRootsDraft(e.target.value),
                    'aria-label': t('rootsLabel'),
                  }),
                ),
                h('div', { className: 'agn-krow' },
                  h('button', {
                    className: 'agn-btn agn-btn-primary',
                    type: 'button',
                    onClick: savePaths,
                    disabled: !writable || savingPaths,
                  }, savingPaths ? t('pathsSaving') : t('pathsSave')),
                ),
                pathsMsg && h('p', { className: 'agn-status ' + (pathsMsg.kind === 'ok' ? 'agn-status-ok' : 'agn-status-err'), role: 'status' }, pathsMsg.text),
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
                  disabled: !writable || savingOpt,
                  onChange: (e) => toggleRecognition(e.target.checked),
                }),
                h('span', null, t('enableLabel')),
              )
            : h('p', { className: 'agn-status', role: 'status' }, t('formMissing')),
          h('p', { className: 'agn-status' }, t('optRestart')),
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
