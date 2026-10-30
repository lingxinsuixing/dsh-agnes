# @lingxinsuixing/dsh-agnes

给 [DeepSeek Harness](https://github.com/DeepSeek-Harness) 用的 Agnes AI 插件：**图片生成、视频生成**是主要功能，另有一个**可关闭**的图片识别。

> **工具结果只有文字。** 生成的图片与视频会下载到本地目录，工具返回文件路径和 URL，图片字节不会进对话。

## 安装

~~~sh
dsh plugin add github:lingxinsuixing/dsh-agnes
~~~

（和插件市场页面给出的命令一致。本插件没有构建步骤，安装前不需要额外授权。）

## 配置

在 Web 界面打开 **插件 → @lingxinsuixing/dsh-agnes** 粘贴 Agnes API Key，或者用 DSH 凭据库：

~~~yaml
# ~/.dsh/credentials.yaml（或 Web 界面的凭据库）
AGNES_API_KEY: your-key
~~~

取值顺序：插件配置（`config.apiKey`）→ 凭据库里的 `AGNES_API_KEY` → 环境变量 `AGNES_API_KEY`。

> 在配置页填的 Key 会以明文写进**你自己的 profile**（`config.apiKey`）。它不会被写进插件包，插件包本身不含任何凭据。

## 工具

| 工具 | 作用 | 主要参数 |
|---|---|---|
| `agnes_image_generate`（主要） | 文生图 / 图生图 / 多图合成 | `prompt`、`size`、`ratio`、`references`、`saveTo` |
| `agnes_video_generate`（主要） | 文生视频 / 首尾帧 / 参考生成 | `prompt`、`mode`、`seconds`、`size`、`aspectRatio`、`images`、`saveTo` |
| `agnes_image_recognize`（可选） | 看图并回答问题 | `image`（本地路径或 http(s) URL）、`prompt` |

工具都只返回文字：路径、URL 和一句摘要，不往对话里塞二进制。

关于 `size`：接口会把 `1920x1080` 这类精确尺寸映射到最近档位，所以结果里的 `size` 是**落盘文件的真实像素**，
不一定等于你请求的值。

## 样例

下面都是用本插件的 `agnes_image_generate` 生成的真实产物（2K，16:9）：

| | |
|---|---|
| ![窗台上熟睡的白猫](assets/wallpapers/01-white-cat-on-windowsill.png) | ![晨雾湖边亮着灯的木屋](assets/wallpapers/02-cabin-by-misty-lake.png) |
| ![樱花树下的小径](assets/wallpapers/03-cherry-blossom-path.png) | ![玻璃温室里的藤椅与绿植](assets/wallpapers/04-greenhouse-plants.png) |
| ![黄昏海边的白色灯塔](assets/wallpapers/05-lighthouse-at-dusk.png) | ![雨夜窗边的书桌与台灯](assets/wallpapers/06-desk-by-rainy-window.png) |
| ![林间溪流与穿过树叶的光束](assets/wallpapers/07-forest-stream.png) | ![薰衣草田边的复古自行车](assets/wallpapers/08-bicycle-by-lavender.png) |
| ![阳台藤椅上睡着的橘猫](assets/wallpapers/09-ginger-cat-on-balcony.png) | ![星夜湖面上停泊的小木船](assets/wallpapers/10-rowboat-under-stars.png) |

## 可选功能：图片识别

识图是可选项。在插件配置里设 `enableRecognition: false`，`agnes_image_recognize` 就**完全不注册**，
只留生图与生视频两个主要功能。

> **声明：识图功能不需要改 provider 就能用**——它跟 DSH 用 `openai-responses` 还是 `openai-completions` 无关。
> 只有 DSH 原生的 `read_image` 要在主会话里看图时，provider 才必须改成 `openai-completions`；
> 不改就别给模型勾图片输入能力，否则一次 `read_image` 就会把整个会话钉死（400 不重试 + 每轮重建全部历史）。

### 不要在主会话里用 `read_image` 看图

> 模型一旦勾上「支持图片」，DSH 自带的 `read_image` 就会把图片内容块塞进主会话；而 Agnes 网关的
> `/v1/responses` 端点不认识 `input_image`（responses→chat 桥接时兜底成 `unknown`），下一轮直接 400。
> 400 不重试，且每轮请求都会从会话日志重建全部历史——一条坏消息就能钉死整个会话，只能新开。
> 要看图请用 `agnes_image_recognize`：图片发给 Agnes 视觉模型，回会话的只有文字。

## 产物放在哪

生成的媒体文件写入 `outputDir` 指定的目录（默认：DSH 主目录下的 `media/`，即 `$DSH_HOME/media`；没设 `$DSH_HOME` 就用 `~/.dsh/media`），每次调用会返回写入的绝对路径。

`saveTo` 必须指向**已存在**的目录：插件不会在任意路径自动建目录，文件名也由插件生成，不会覆盖你已有的文件。

识图要读的本地图片可以用 `allowedReadRoots`（绝对路径目录列表）限制；留空 = 任何可读的图片都接受。

## 环境要求

- DeepSeek Harness，`@deepseek-ai/schemastery` `>=3.18.1`
- 一把 Agnes API Key
- Agnes 生图目前免费；生视频由 Agnes 按生成秒数计费（`-flash` 变体目前限 720P）

## 许可

MIT
