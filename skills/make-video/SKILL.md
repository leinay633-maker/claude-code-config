---
name: make-video
description: 做视频的入口。用户要做或改视频、短片、动画、动态图形、片头、宣传片、讲解片、MV、带字幕的视频，或把网页、文字、数据、代码改动做成 MP4 时使用。画面全程序生成的 MV 走本目录 mv.md（mv-engine 引擎），有旁白的讲解片先读 explainer.md，无旁白的知识短片先读 vibe.md；其余按需从磁盘加载 HyperFrames 的子 skill（平时禁用、不占列表）。只用 ffmpeg 做一步转码、剪切、抽帧，或下载、分析别人的视频时不用。
---

# 做视频：先分流，再按需加载 HyperFrames

## 分流

- 给一首歌做 MV 或歌词视频，画面全部由代码生成：读本目录 `mv.md` 照做，不加载 HyperFrames。
- 有旁白的科普或知识讲解片：先读本目录 `explainer.md`，再照下面加载 HyperFrames。
- 无旁白、以字幕讲故事的 2–3 分钟知识短片：先读本目录 `vibe.md`，再照下面加载 HyperFrames。
- 其余视频（宣传片、讲解片、拿现成图片或视频卡点的音乐视频……）照下面加载 HyperFrames。

HyperFrames 插件已装，但在用户级禁用，免得一堆子 skill 常驻列表。不要 `claude plugin enable` 它，也不要 `npx skills add`、`hyperframes skills update` 另装一份。

## 加载

- `PLUGIN_ROOT` = `~/.claude/plugins/marketplaces/hyperframes`，只读。
- 先 Read `<PLUGIN_ROOT>/skills/hyperframes/SKILL.md`（路由入口）和同目录 `references/plugin-installation.md`，按插件模式执行：
  - 文中写 `/xxx` 或要求加载某个 skill 时，Read `<PLUGIN_ROOT>/skills/xxx/SKILL.md`，不调用 Skill 工具；`<SKILL_DIR>` 换成该子 skill 的绝对目录。
  - 命令里的 `npx hyperframes` 换成 `node "<PLUGIN_ROOT>/skills/hyperframes/scripts/plugin-cli.mjs"`，在视频工程目录里运行。
- 子 skill 和 references 用到哪个读哪个，不一次读全。

## 约定

- 讲解片和无旁白知识短片的画面、声音和验收分别按 `explainer.md`、`vibe.md`，和通用的视觉偏好冲突时以它们为准。
- HyperFrames 的意图访谈和 pitch round 要压缩：能从用户的话推出来的直接定，只问题材、时长这类推不出的。
- 中文旁白不用 HyperFrames 自带 TTS（要登录或付费，自带的本地模型中文效果差）。用本地中文 TTS 或 Edge 语音出 wav，再按 `media-use`、`hyperframes-audio` 放进工程、对字幕。
- 场景分工：主会话先定风格。公共工具（kit、HUD、卡片）、开场和一两段样板场景由主会话写，截图给用户看；用户认可后，剩下的场景可以交给子代理，主会话写任务说明、看拼图验收、拷回原工程。
  - 子代理在工程副本里写，原工程只由主会话改。长活拆成几轮，每轮新开上下文。
  - 任务说明要写全：写法约定、颜色语义、字号下限、逐句画什么、踩过的坑、check 和截帧自查、报告格式。
  - 看图只看拼图 JPG，每轮 30 张以内；逐张看 PNG 原帧太占上下文。
  - 验收重点查空半屏、窄栏字小发挤、细节偏少。

## 更新

`claude plugin marketplace update hyperframes` 拉新版本，插件保持禁用。
