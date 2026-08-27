import express from 'express';
import http from 'http';
import path from 'path';
import { initDb } from './db';
import { attachWebSocket } from './broadcast';
import ingestRouter from './routes/ingest';
import apiRouter from './routes/api';
import { register, startPollers } from './collectors/registry';
import { config } from './config';

const PORT = Number(process.env.PORT ?? 4317);

async function main() {
  await initDb();

  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.use('/ingest', ingestRouter);
  app.use('/api', apiRouter);
  app.use(express.static(path.join(__dirname, '..', 'public')));

  const server = http.createServer(app);
  attachWebSocket(server);

  server.listen(PORT, '127.0.0.1', async () => {
    console.log(`Agent Monitor listening on http://127.0.0.1:${PORT}`);
    console.log(`  Health:   http://127.0.0.1:${PORT}/health`);
    console.log(`  Sessions: http://127.0.0.1:${PORT}/api/sessions`);
    console.log(`  UI:       http://127.0.0.1:${PORT}/`);

    // Register optional polling collectors based on environment config
    if (config.foundry.enabled) {
      const { foundryCollector } = await import('./collectors/foundry');
      register(foundryCollector);
      console.log('[collector] Azure AI Foundry enabled');
    }

    if (config.copilotStudio.enabled) {
      const { copilotStudioCollector } = await import('./collectors/copilot-studio');
      register(copilotStudioCollector);
      console.log('[collector] Copilot Studio enabled');
    }

    startPollers();
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
