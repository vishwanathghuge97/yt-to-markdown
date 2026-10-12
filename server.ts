import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import app from './api/app';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = 3000;

async function startServer() {
  const server = http.createServer(app);

  if (process.env.NODE_ENV === 'production') {
    const express = (await import('express')).default;
    app.use(express.static(path.resolve('dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  } else {
    // Dynamic import to prevent bundling development Vite dependencies into serverless production
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: {
          server,
        },
      },
      appType: 'spa',
    });

    app.use(vite.middlewares);
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

// Standalone server mode (AI Studio dev or Docker/Cloud Run)
if (!process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

export { app };
export default app;
