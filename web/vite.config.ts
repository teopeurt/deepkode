// Responsibility: Vite config —— the dev proxy forwards /api and /api/events to the backend service (it sends no CORS headers, so a same-origin proxy is required).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0', // reachable via both localhost(::1) and 127.0.0.1
    port: 5173,
    proxy: {
      // REST + WS (/api/events) are all proxied to the helmsman service; ws:true lets /api/events go through the WebSocket upgrade.
      '/api': {
        target: 'http://127.0.0.1:3081',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});