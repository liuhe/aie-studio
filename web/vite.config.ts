import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const devAllowedHosts = (process.env.REMOTE_IDE_DEV_ALLOWED_HOSTS ?? '')
  .split(',')
  .map((host) => host.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    ...(devAllowedHosts.length > 0 ? { allowedHosts: devAllowedHosts } : {}),
    // Behind an HTTPS reverse proxy: tell the HMR client to connect via wss on
    // port 443. Leaving host undefined lets the client use `location.host`.
    hmr: {
      protocol: 'wss',
      clientPort: 443,
    },
    proxy: {
      '/api': 'http://localhost:9991',
      '/ws': { target: 'ws://localhost:9991', ws: true },
    },
  },
});
