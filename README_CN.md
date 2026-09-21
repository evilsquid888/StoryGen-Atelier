# StoryGen Atelier
[English](README_EN.md) | [中文](README_CN.md)

AI 辅助的分镜与视频生成工具。使用 xAI Grok 生成分镜文本，Grok Imagine 生成帧图与过渡片段，并用 ffmpeg 拼接成全片，内置日志与画廊管理。一个 `XAI_API_KEY` 即可驱动全部功能。

![All Styles](exampleImg/all.png)

## 功能
- **分镜生成**：Grok（Responses API）生成分镜脚本，Grok Imagine 生成每帧图；支持自定义风格和镜头数。
- **视频生成**：基于分镜的插帧链（Interpolation Chain），调用 Grok Imagine Video 生成片段并用 ffmpeg 拼接成整片。
- **日志面板**：视频日志 + 分镜日志（SQLite 持久化），支持查看/导出/清空。
- **画廊**：保存、载入、删除已生成的分镜 + 视频。
- **提示指南**：内置 `guide/VideoGenerationPromptGuide.md` 供模型提示参考。

## 核心技术：视频生成与拼接算法
本项目采用 **"插值链" (Interpolation Chain / Sliding Window)** 策略，将静态的分镜图片转化为连贯的视频故事。该过程完全自动化，主要包含以下三个阶段：

### 1. 过渡分析 (Transition Analysis) - Grok
系统首先遍历分镜列表，使用滑动窗口处理每一对相邻镜头（Shot A → Shot B）。
- **智能分析**：调用 **Grok**（视觉输入）分析 Shot A 和 Shot B 的视觉内容。
- **生成指令**：Grok 输出一段特定的 **过渡提示词 (Transition Prompt)** 和建议的 **持续时间**，详细描述如何从第一个画面平滑运镜过渡到第二个画面（例如："Slow dolly zoom in while panning right..."）。

### 2. 独立片段生成 (Clip Generation) - Grok Imagine Video
基于第一步的分析结果，并行调用 **Grok Imagine Video** 生成视频片段。
- **中间过渡**：对于每一对镜头 (A, B)，将 Grok 生成的提示词 + Shot A (起始帧) + Shot B (固定为 `last_frame`) 发送给 Grok Imagine，生成一段连接两者的视频片段。
- **结尾**：对于最后一个镜头 (Shot N)，系统会单独生成一个 "Closing Shot" 片段（通常为 4-12秒），通过 "Hold on the final frame with a gentle cinematic finish" 等提示词，让故事有一个优雅的静止或微动结尾。

### 3. 最终拼接 (Final Assembly) - FFmpeg
当所有片段（过渡片段 + 结尾片段）生成完毕后，后端使用 **FFmpeg** 进行无损拼接。
- **序列组合**：将所有生成的 `.mp4` 片段按时间顺序写入列表。
- **流式拷贝**：使用 `concat` 协议和 copy 模式 (`-c copy`) 快速合并视频流，避免二次编码导致的画质损失，最终输出完整的 `full_story_xxx.mp4` 文件。

## 技术栈
- **前端**: React, Vite, Mantine UI (组件库)
- **后端**: Node.js (Express), better-sqlite3 (高性能数据存储), fluent-ffmpeg (视频拼接)
- **AI 服务**: xAI Grok（文本），Grok Imagine（图像 + 视频）

## 目录结构
```
backend/    Node.js + Express API，调用 xAI Grok API，管理日志与数据
frontend/   React + Vite + Mantine UI
guide/      提示词指南
exampleImg/ README 用的示例分镜帧图（从本地数据导出）
backend.log / frontend.log 运行期日志
```

## 运行要求
- Node.js 18+，npm
- ffmpeg
- **xAI API Key**：在 https://console.x.ai 创建，用于分镜文本、帧图与视频片段

## 环境变量
在 `backend/.env`（可复制 `.env.example`）配置：
```
PORT=3005
# xAI Grok — one key covers text, image, and video
XAI_API_KEY=your_xai_api_key
XAI_TEXT_MODEL=grok-4.6                    # storyboard scripts + transition analysis
XAI_IMAGE_MODEL=grok-imagine-image-2.0     # storyboard frames
XAI_IMAGE_RESOLUTION=1k                    # 1k or 2k
XAI_VIDEO_MODEL=grok-imagine-video-1.5     # transition clips
XAI_VIDEO_RESOLUTION=720p                  # 480p / 720p / 1080p
XAI_VIDEO_ASPECT_RATIO=16:9
XAI_VIDEO_GENERATE_AUDIO=true
IMAGE_STYLE=                               # optional default look when the UI passes no style
```

只有 `XAI_API_KEY` 是必填项，其余变量都有可用默认值。未配置 Key 时后端返回内置示例分镜与占位帧图，视频生成不可用。

## 快速启动 (推荐)
无需分别启动前后端，直接在根目录运行：
```bash
# 赋予执行权限（仅需一次）
chmod +x start_servers.sh
# 启动服务
./start_servers.sh
```
macOS 也可以直接双击 **`start_macos.command`**（首次可能需要 `chmod +x`）。脚本会：
1. 检查 Node.js 18+ / npm（缺 ffmpeg 时给出提醒）
2. 首次运行时自动安装前后端依赖
3. 在端口 **3005** 启动后端 API、**5180** 启动前端界面
4. 等两个端口都能响应后才提示访问地址；日志分别写入 `backend.log` / `frontend.log`

启动失败时会打印错误原因和对应日志的末尾几行，并保持窗口不关闭——旧版脚本把服务丢到后台就退出，依赖没装好时只会看到窗口闪退，真实报错（如 `Cannot find module 'express'`）藏在日志里。

## 手动安装与启动
后端：
```bash
cd backend
npm install
cp .env.example .env  # 并填入真实 key
npm run dev           # 或 npm start
```
前端（默认 5180 端口）：
```bash
cd frontend
npm install
npm run dev
```
打包：
```bash
cd frontend && npm run build
```

## 示例
- 分镜风格示例：
  - 动漫风格示例：![Anime](exampleImg/Anime.png)

https://github.com/user-attachments/assets/a70279b0-80f7-4b9a-96fb-173e5912d43a

 - <img width="1198" height="1242" alt="image" src="https://github.com/user-attachments/assets/f78a1b54-2490-4d51-80c9-6bb8d41b0b49" />

https://github.com/user-attachments/assets/66bbe81e-34f1-44dd-b648-2a8cb84e5eba
  
  - 赛博朋克示例：![Cyberpunk](exampleImg/Cyberpunk.png)
  - 
https://github.com/user-attachments/assets/ad56e3c8-c14e-48fb-8366-ad22c4e8ea60

  - 吉卜力风示例：![Ghibli Style](exampleImg/GhibliStyle.png)
  - 
https://github.com/user-attachments/assets/fe6c57fa-0bb5-4c81-8efb-1c7c52011948

  - 写实示例：![Realism](exampleImg/Realism.png)
  - 
https://github.com/user-attachments/assets/2ca41cbf-2765-4e6b-8e85-8ba0e8e191f5

  - 国风水墨示例：![Chinese Ink](exampleImg/ChineseInk.png)
  - 
https://github.com/user-attachments/assets/99305353-a348-45ca-add7-f9692bccdc95
    
