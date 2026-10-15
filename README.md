# yt-to-markdown 🎬 ➡️ 📝

> Zero-hallucination YouTube video and lecture analyzer that generates structured, publication-grade Markdown notes, executive summaries, takeaways, visual OCR logs, and timestamped transcripts.

🌐 **Live Website:** [https://yt-to-markdown.vercel.app](https://yt-to-markdown.vercel.app)

[![Live Demo](https://img.shields.io/badge/Live%20Demo-yt--to--markdown.vercel.app-000000?style=for-the-badge&logo=vercel&logoColor=white)](https://yt-to-markdown.vercel.app)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue?style=for-the-badge)](LICENSE)
[![Mobile Optimized](https://img.shields.io/badge/Mobile-Optimized-emerald?style=for-the-badge&logo=apple)](https://yt-to-markdown.vercel.app)

---

## ✨ Features

- 🌐 **Live Web App**: Use directly at [yt-to-markdown.vercel.app](https://yt-to-markdown.vercel.app) on desktop, tablet, or phone.
- 🔑 **Bring Your Own Key (BYOK)**: Free Gemini API key usage with sandboxed client-side session security.
- 📱 **Mobile & Tablet Optimized**: Responsive touch layout and table rendering on all viewports.
- 🎯 **Strict Factual Grounding**: Direct multimodal video understanding via Gemini (`mimeType: video/*`), eliminating hallucinations.
- 🛡️ **Resource Protection**: Automatically screens and rejects non-YouTube links and private/unavailable videos before making model calls.
- ⏱️ **Duration-Adaptive Chunking**: Smart zero-skip segmentation tailored from short clips to multi-hour lectures.
- 📝 **Markdown Export**: Formatted tables of contents, summaries, key takeaways, and code blocks.
- 📁 **Google Drive Export**: One-click direct export to your Google Drive folder.
- ⚡ **Vercel & Production Ready**: Pre-configured with serverless endpoints (`/api/*`) and static Vite bundling.

---

## 🚀 Quick Start

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v20+)
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
- **AI Engine**: Google Gen AI SDK (`@google/genai`), `gemini-flash-latest` with `gemini-3.8-flash` / `gemini-3.1-flash-lite` fallbacks
- **Auth & Storage**: Firebase Auth, Google Drive REST API v3
