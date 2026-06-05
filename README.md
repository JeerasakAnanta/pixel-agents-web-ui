<h1 align="center">
    <img src="webview-ui/public/banner.png" alt="Pixel Agents Web UI">
</h1>

<h2 align="center">
  Pixel art office สำหรับจัดการ AI agents — ใช้งานผ่าน Web Browser ได้เลย
</h2>

<div align="center">

[![stars](https://img.shields.io/github/stars/JeerasakAnanta/pixel-agents-web-ui?logo=github&color=0183ff&style=flat)](https://github.com/JeerasakAnanta/pixel-agents-web-ui/stargazers)
[![license](https://img.shields.io/github/license/JeerasakAnanta/pixel-agents-web-ui?color=0183ff&style=flat)](https://github.com/JeerasakAnanta/pixel-agents-web-ui/blob/main/LICENSE)
[![issues](https://img.shields.io/github/issues/JeerasakAnanta/pixel-agents-web-ui)](https://github.com/JeerasakAnanta/pixel-agents-web-ui/issues)

</div>

<div align="center">
<a href="https://github.com/JeerasakAnanta/pixel-agents-web-ui/issues">🐛 Issues</a> • <a href="https://github.com/JeerasakAnanta/pixel-agents-web-ui/discussions">💬 Discussions</a> • <a href="CONTRIBUTING.md">🤝 Contributing</a>
</div>

<br/>

**Pixel Agents Web UI** เป็น fork จาก [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) ที่เพิ่มความสามารถ **Standalone Web App** — เปิด browser แล้วใช้งานได้เลย ไม่ต้องติดตั้ง VS Code

แต่ละ agent กลายเป็นตัวละครใน pixel art office เดิน นั่งทำงาน และแสดงสิ่งที่กำลังทำอยู่จริงๆ — พิมพ์โค้ด, อ่านไฟล์, รอ input

![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

## สิ่งที่เพิ่มมาใน Fork นี้

- **🌐 Standalone Web Mode** — `npm start` แล้วเปิด `http://localhost:3100` ในเบราว์เซอร์ใดก็ได้
- **🖥️ Terminal Spawning** — กด "+ Agent" แล้ว terminal window จะเปิดขึ้นมาพร้อม `claude` CLI อัตโนมัติ
- **🗂️ Workspace Flag** — `--workspace /path/to/project` กำหนด working directory สำหรับ agents ทุกตัว
- **💻 WSL2 Support** — เปิด Windows Terminal ใน WSL distro ได้อัตโนมัติ

## เริ่มใช้งาน (Standalone Web Mode)

```bash
git clone https://github.com/JeerasakAnanta/pixel-agents-web-ui.git
cd pixel-agents-web-ui

# ติดตั้ง dependencies
npm install
cd webview-ui && npm install && cd ..
cd server && npm install && cd ..

# Build
npm run build:standalone

# รัน server (browser เปิดอัตโนมัติ)
npm start

# หรือกำหนด workspace directory
npm start -- --workspace /home/projects/my-project
```

Browser จะเปิด `http://127.0.0.1:3100` อัตโนมัติ

## ใช้งานเป็น VS Code Extension (แบบเดิม)

```bash
npm run build
```

กด **F5** ใน VS Code เพื่อเปิด Extension Development Host

## Features

- **One agent, one character** — Claude Code แต่ละตัวมีตัวละครเป็นของตัวเอง
- **Live activity tracking** — ตัวละครแสดง animation ตามสิ่งที่ agent กำลังทำจริงๆ
- **Office layout editor** — ออกแบบ office ด้วย floor, walls, และเฟอร์นิเจอร์
- **Speech bubbles** — แสดงเมื่อ agent รอ input หรือต้องการ permission
- **Sound notifications** — เสียงแจ้งเตือนเมื่อ agent ทำงานเสร็จ
- **Sub-agent visualization** — Task tool sub-agents spawn เป็นตัวละครแยก
- **Persistent layouts** — บันทึก office layout ไว้ใน `~/.pixel-agents/layout.json`

## Requirements

- Node.js 18+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) ติดตั้งและ config แล้ว
- สำหรับ VS Code mode: VS Code 1.105.0+

## CLI Options

```
npm start -- [options]

Options:
  --port, -p <number>      Port (default: 3100)
  --host <string>          Host (default: 127.0.0.1)
  --workspace, -w <path>   Working directory สำหรับ agents ใหม่
  --help                   แสดง help
```

## Tech Stack

- **Backend**: Node.js, Fastify, WebSocket
- **Webview**: React 19, TypeScript, Vite, Canvas 2D
- **Extension**: TypeScript, VS Code Webview API, esbuild

## Based On

Fork จาก [pixel-agents-hq/pixel-agents](https://github.com/pixel-agents-hq/pixel-agents) โดย [Pablo De Lucca](https://github.com/pablodelucca) — ขอบคุณสำหรับ project ที่ยอดเยี่ยมนี้

ตัวละครอ้างอิงจากผลงานของ [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)

## License

[MIT License](LICENSE) — Copyright (c) 2026 Jeerasak Ananta
