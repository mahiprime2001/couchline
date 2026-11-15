import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// In dev the Worker (wrangler dev) listens on 8787; Vite proxies API + WebSocket calls to it,
// so only Vite has to be reachable from other devices on the Wi-Fi.
// `vite --mode https` serves a self-signed certificate: needed on phones/other PCs for mic,
// screen share, the file picker and the clipboard (browsers only allow those on https/localhost).
// The rooms backend (apps/server by default, or the Cloudflare worker via dev:cf) listens on 8787.
const apiPort = process.env.API_PORT ?? '8787';

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'https' ? [basicSsl()] : [])],
  server: {
    host: true, // listen on all interfaces (Wi-Fi/LAN)
    port: 5173,
    // lets `pnpm tunnel` (Cloudflare quick tunnel, https://<random>.trycloudflare.com) reach the dev server
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      // xfwd: tell the backend who really asked, so a phone on the Wi-Fi is not mistaken for this computer
      '/api': { target: `http://localhost:${apiPort}`, xfwd: true },
      '/media': `http://localhost:${apiPort}`, // hosted (converted) videos
      '/chat-image': `http://localhost:${apiPort}`, // pictures shared in chat
      '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
    },
  },
}));
