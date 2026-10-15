import http from 'http';
import path from 'path';
import express from 'express';
import dotenv from 'dotenv';
import app from './api/index';

dotenv.config();

// Honor platform-injected PORT (Docker/Cloud Run) while defaulting to 3000 locally.
const PORT = Number(process.env.PORT) || 3000;

async function startServer() {
  const server = http.createServer(app);

  if (process.env.NODE_ENV === 'production') {
    app.use(express.static(path.resolve('dist')));
    // Serve the SPA for every non-API GET; unknown /api/* paths keep their JSON 404.
    app.get(/^\/(?!api\/).*/, (_req, res) => {
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
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

// Standalone server mode (local dev or Docker/Cloud Run)
if (!process.env.VERCEL) {
  startServer().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}

export { app };
export default app;
