import express from 'express';
import compression from 'compression';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { initDb, flushDb } from './db';
import { attachWebSocket } from './broadcast';
import ingestRouter from './routes/ingest';
import apiRouter from './routes/api';
import { register, startPollers } from './collectors/registry';
import { config } from './config';
import { startAnalysisBackfill } from './pipeline';
import { watchRules } from './analytics/rules';
import { initGovernance } from './governance';
import { govConfig } from './governance/config';
import { authenticate, localRequestGuard, requireRole } from './governance/auth';
import { adminLoginUrl } from './governance/local-admin';

const PORT = Number(process.env.PORT ?? 4317);
// Local enforcers stay on loopback; the cloud control plane listens on all interfaces inside its container.
const HOST = process.env.HOST ?? (govConfig.mode === 'cloud' ? '0.0.0.0' : '127.0.0.1');

/**
 * Locate the built web UI. Order: AGENT_MONITOR_PUBLIC, <root>/public next to src/ or dist/
 * (dev, `npm start`, packaged Electron app), then ./public in the working directory.
 */
function resolvePublicDir(): string {
  const candidates = [
    process.env.AGENT_MONITOR_PUBLIC,
    path.join(__dirname, '..', 'public'),
    path.join(process.cwd(), 'public'),
  ].filter((p): p is string => !!p);
  const found = candidates.find(p => fs.existsSync(path.join(p, 'index.html')));
  if (!found) console.warn(`[ui] no built UI found (looked in ${candidates.join(', ')}); run "npm run build:web"`);
  return found ?? candidates[0];
}

async function main() {
  await initDb({ backgroundCheckpoints: true });

  const app = express();
  app.use(compression());
  app.use(['/api', '/v1', '/hooks', '/mcp', '/ingest'], localRequestGuard(PORT));
  app.use(express.json({ limit: '4mb' }));

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
  app.use('/ingest', ...(govConfig.mode === 'cloud' ? [authenticate, requireRole('Agent')] : []), ingestRouter);
  await initGovernance(app);
  app.use('/api', ...(govConfig.mode === 'cloud' ? [authenticate, requireRole('Viewer')] : []), apiRouter);

  const publicDir = resolvePublicDir();
  app.use(express.static(publicDir, { index: 'index.html', maxAge: 0 }));
  // Client-side routes (/overview, /conversations/:id, …) fall back to the SPA shell.
  app.get(/^\/(?!api|ingest|live|health|v1|hooks|mcp)(?!.*\.\w+$).*/, (_req, res, next) => {
    const index = path.join(publicDir, 'index.html');
    if (fs.existsSync(index)) res.sendFile(index);
    else next();
  });

  const server = http.createServer(app);
  attachWebSocket(server);

  server.listen(PORT, HOST, async () => {
    console.log(`Agent Monitor listening on http://${HOST}:${PORT}`);
    console.log(`  Health:   http://127.0.0.1:${PORT}/health`);
    console.log(`  Sessions: http://127.0.0.1:${PORT}/api/sessions`);
    console.log(`  UI:       http://127.0.0.1:${PORT}/`);
    if (govConfig.mode === 'local') {
      const url = adminLoginUrl(PORT);
      console.log(`  Local admin: ${url}`);
      console.log(`AGENTGOV_ADMIN_LOGIN_URL=${url}`);
    }

    startAnalysisBackfill();
    watchRules(() => startAnalysisBackfill());

    // Register optional polling collectors based on environment config
    if (config.copilotCli.enabled) {
      const { createCopilotCliCollector, copilotCliAvailable } = await import('./collectors/copilot-cli');
      if (copilotCliAvailable(config.copilotCli.home)) {
        register(createCopilotCliCollector(config.copilotCli));
        console.log('[collector] GitHub Copilot CLI enabled');
      }
    }

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

  const shutdown = () => {
    try { flushDb(); } catch (err) { console.error('[db] flush on exit failed:', err); }
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
