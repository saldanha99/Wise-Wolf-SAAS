import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(() => {
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['apple-touch-icon.png'],
          manifest: {
            name: 'Wise Wolf — Aprenda Inglês',
            short_name: 'Wise Wolf',
            description: 'Trilhas didáticas, tutor de IA e gamificação para aprender inglês.',
            theme_color: '#8b5cf6',
            background_color: '#0f172a',
            display: 'standalone',
            orientation: 'portrait',
            start_url: '/',
            scope: '/',
            lang: 'pt-BR',
            icons: [
              { src: '/pwa-192x192.png', sizes: '192x192', type: 'image/png' },
              { src: '/pwa-512x512.png', sizes: '512x512', type: 'image/png' },
              { src: '/pwa-maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            ],
          },
          workbox: {
            globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
            navigateFallbackDenylist: [/^\/api/, /supabase/],
            runtimeCaching: [
              {
                urlPattern: ({ url }) => url.hostname.includes('supabase'),
                handler: 'NetworkOnly',
              },
            ],
          },
        }),
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
