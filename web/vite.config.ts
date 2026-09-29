/// <reference types="vitest/config" />
import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// The project-wide .env lives in the repo root; unit tests stay isolated from it.
const rootDir = path.resolve(__dirname, '..');

export default defineConfig(({ mode }) => {
  const isTest = mode === 'test' || !!process.env.VITEST;
  const env: Record<string, string> = isTest ? {} : loadEnv(mode, rootDir, '');
  const target = env.AGENT_MONITOR_URL || 'http://127.0.0.1:4317';

  return {
    envDir: isTest ? __dirname : rootDir,
    plugins: [react()],
    build: {
      outDir: '../public',
      emptyOutDir: true,
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          manualChunks: {
            react: ['react', 'react-dom', 'react-router-dom'],
            mui: ['@mui/material', '@emotion/react', '@emotion/styled'],
            grid: ['@mui/x-data-grid'],
            charts: ['@mui/x-charts'],
            markdown: ['react-markdown', 'remark-gfm', 'rehype-sanitize'],
          },
        },
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': target,
        '/ingest': target,
        '/health': target,
        '/live': { target: target.replace(/^http/, 'ws'), ws: true },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  };
});
