# yt-to-markdown 🎬 ➡️ 📝

> Zero-hallucination YouTube video and lecture analyzer that generates structured, publication-grade Markdown notes, executive summaries, takeaways, visual OCR logs, and timestamped transcripts.

[![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)](package.json)
[![License](https://img.shields.io/badge/license-Apache--2.0-green.svg)](LICENSE)

---

## ✨ Features

- **Strict Factual Grounding**: Direct multimodal video understanding via Gemini 2.5 (`mimeType: video/*`), eliminating hallucinations.
- **Resource Protection**: Automatically screens and rejects non-YouTube links and private/unavailable videos before making model calls.
- **Duration-Adaptive Chunking**: Smart segmentation tailored from short clips to multi-hour lectures.
- **Markdown Export**: Formatted tables of contents, summaries, key points, and on-screen code extracts.
- **Google Drive Export**: One-click export directly to a dedicated Google Drive folder.
- **Vercel & Production Ready**: Pre-configured with serverless endpoints (`/api/*`) and static Vite bundling.

---

## 🚀 Quick Start

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- [Google AI Studio API Key](https://aistudio.google.com/app/apikey)

### 2. Installation
```bash
git clone https://github.com/vishwanathghuge97/yt-to-markdown.git
cd yt-to-markdown
npm install
```

### 3. Environment Setup
Create a `.env` file from the example:
```bash
cp .env.example .env
```
Add your Gemini API key:
```env
GEMINI_API_KEY="your_actual_gemini_api_key_here"
```

### 4. Run Locally
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) in your browser.

---

## ⚡ Deployment to Vercel

1. Import this repository into [Vercel](https://vercel.com/new).
2. Set the **Framework Preset** to `Vite`.
3. In **Environment Variables**, add:
   - `GEMINI_API_KEY`: Your Gemini API key.
4. Click **Deploy**.

> **Note for Google Drive Export:** In the Firebase Console, add your Vercel URL (e.g. `your-app.vercel.app`) to **Authentication > Settings > Authorized domains** so popup sign-in works in production.

---

## 🛠️ Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS v4, Lucide Icons
- **Backend**: Express (Vercel Serverless Function compatible)
- **AI Engine**: Google Gen AI SDK (`@google/genai`), `gemini-2.5-flash`
- **Auth & Storage**: Firebase Auth, Google Drive REST API v3
