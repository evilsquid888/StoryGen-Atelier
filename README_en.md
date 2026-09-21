# StoryGen Atelier
[English](README_EN.md) | [中文](README_CN.md)

AI-assisted storyboard and video generation tool. Uses xAI Grok for storyboard text, Grok Imagine for frames and transition clips, and ffmpeg for stitching the final video. One `XAI_API_KEY` covers everything. Built-in logs and gallery management.

![All Styles](exampleImg/all.png)

## Features
- **Storyboard Generation**: Grok (Responses API) writes the storyboard script, and Grok Imagine renders each frame; supports custom styles and shot counts.
- **Video Generation**: Based on the Interpolation Chain of the storyboard, calls Grok Imagine Video to generate clips and stitches them into a full video using ffmpeg.
- **Logs Dashboard**: Video logs + Storyboard logs (SQLite persistence), supports viewing, exporting, and clearing.
- **Gallery**: Save, load, and delete generated storyboards + videos.
- **Prompt Guide**: Built-in `guide/VideoGenerationPromptGuide.md` for model prompting reference.

## Core Technology: Video Generation & Stitching Algorithm
This project uses an **"Interpolation Chain" (Sliding Window)** strategy to transform static storyboard images into a coherent video story. The process is fully automated and consists of three main phases:

### 1. Transition Analysis - Grok
The system first iterates through the storyboard list using a sliding window to process each pair of adjacent shots (Shot A → Shot B).
- **Intelligent Analysis**: Calls **Grok** (vision input) to analyze the visual content of Shot A and Shot B.
- **Instruction Generation**: Grok outputs a specific **Transition Prompt** and a suggested **Duration**, detailing how to smoothly transition from the first frame to the second (e.g., "Slow dolly zoom in while panning right...").

### 2. Clip Generation - Grok Imagine Video
Based on the analysis from step 1, **Grok Imagine Video** is called in parallel to generate video clips.
- **Intermediate Transitions**: For each pair of shots (A, B), the Grok-generated prompt + Shot A (start frame) + Shot B (pinned `last_frame`) are sent to Grok Imagine to generate a connecting video clip.
- **Closing Shot**: For the final shot (Shot N), the system generates a separate "Closing Shot" clip, using prompts like "Hold on the final frame with a gentle cinematic finish" to give the story an elegant static or subtle ending.

### 3. Final Assembly - FFmpeg
Once all clips (transition clips + closing clip) are generated, the backend uses **FFmpeg** for lossless stitching.
- **Sequence Assembly**: All generated `.mp4` clips are written to a list in chronological order.
- **Stream Copy**: Uses the `concat` protocol and copy mode (`-c copy`) to quickly merge video streams, avoiding quality loss from re-encoding, and finally outputs the complete `full_story_xxx.mp4` file.

## Tech Stack
- **Frontend**: React, Vite, Mantine UI (Component Library)
- **Backend**: Node.js (Express), better-sqlite3 (High-performance data storage), fluent-ffmpeg (Video stitching)
- **AI Services**: xAI Grok (Text), Grok Imagine (Image + Video)

## Directory Structure
```
backend/    Node.js + Express API, calls the xAI Grok API, manages logs & data
frontend/   React + Vite + Mantine UI
guide/      Prompt guides
exampleImg/ Example storyboard frames for README (exported from local data)
backend.log / frontend.log Runtime logs
```

## Requirements
- Node.js 18+, npm
- ffmpeg
- **xAI API Key**: Create one at https://console.x.ai. Used for storyboard text, frames, and video clips.

## Environment Variables
Configure in `backend/.env` (copy from `.env.example`):
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

Only `XAI_API_KEY` is required; every other variable has a working default. Without a key the backend serves the built-in sample storyboard with placeholder frames, and video generation is disabled.

## Quick Start (Recommended)
No need to start backend and frontend separately. Run from the root directory:
```bash
# Grant execution permission (only needed once)
chmod +x start_servers.sh
# Start servers
./start_servers.sh
```
On macOS you can also double-click **`start_macos.command`** (run `chmod +x` once). The script will:
1. Check Node.js 18+ / npm (and warn when ffmpeg is missing)
2. Install backend + frontend dependencies automatically on the first run
3. Start the backend API on port **3005** and the frontend on port **5180**
4. Wait until both ports answer before printing the URL; logs go to `backend.log` / `frontend.log`

On failure it prints the reason plus the tail of the failing log and keeps the window open — the old script backgrounded both servers and exited, so a missing dependency surfaced only as a window that flashed and closed (`Cannot find module 'express'` stayed hidden in the log).

## Manual Install & Start
Backend:
```bash
cd backend
npm install
cp .env.example .env  # And fill in real keys
npm run dev           # Or npm start
```
Frontend (Default port 5180):
```bash
cd frontend
npm install
npm run dev
```
Build:
```bash
cd frontend && npm run build
```

## Examples
- Storyboard Style Examples:
  - Anime Style Example：![Anime](exampleImg/Anime.png)

https://github.com/user-attachments/assets/a70279b0-80f7-4b9a-96fb-173e5912d43a

  - <img width="1198" height="1242" alt="image" src="https://github.com/user-attachments/assets/f78a1b54-2490-4d51-80c9-6bb8d41b0b49" />

https://github.com/user-attachments/assets/66bbe81e-34f1-44dd-b648-2a8cb84e5eba 
  - Cyberpunk Example：![Cyberpunk](exampleImg/Cyberpunk.png)  

https://github.com/user-attachments/assets/ad56e3c8-c14e-48fb-8366-ad22c4e8ea60


  - Ghibli Style Example：![Ghibli Style](exampleImg/GhibliStyle.png)  

https://github.com/user-attachments/assets/fe6c57fa-0bb5-4c81-8efb-1c7c52011948



  - Realism Example：![Realism](exampleImg/Realism.png)

https://github.com/user-attachments/assets/2ca41cbf-2765-4e6b-8e85-8ba0e8e191f5


  - Chinese Ink Example：![Chinese Ink](exampleImg/ChineseInk.png)  

https://github.com/user-attachments/assets/99305353-a348-45ca-add7-f9692bccdc95
