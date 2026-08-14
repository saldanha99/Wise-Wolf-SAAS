import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const REQUIRED_PUBLIC_BUILD_ENV = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY',
] as const;

export default defineConfig(({ command, mode }) => {
    if (command === 'build') {
      const fileEnv = loadEnv(mode, process.cwd(), '');
      const buildEnv: Record<string, string | undefined> = {
        ...fileEnv,
        ...process.env,
      };

      for (const name of REQUIRED_PUBLIC_BUILD_ENV) {
        const value = buildEnv[name]?.trim();
        if (!value || value.startsWith('replace-with-')) {
          throw new Error(
            `[Build bloqueado] ${name} precisa estar configurada antes de publicar o frontend.`,
          );
        }
      }

      try {
        const supabaseUrl = new URL(buildEnv.VITE_SUPABASE_URL!);
        const isSecure = supabaseUrl.protocol === 'https:';
        const isLocalHttp = supabaseUrl.protocol === 'http:'
          && ['localhost', '127.0.0.1', '::1'].includes(supabaseUrl.hostname);
        if (!isSecure && !isLocalHttp) {
          throw new Error('protocolo inseguro');
        }
        if (supabaseUrl.hostname.endsWith('.supabase.co')) {
          throw new Error('Supabase hospedado não é um destino permitido');
        }
        if (supabaseUrl.pathname !== '/' || supabaseUrl.search || supabaseUrl.hash) {
          throw new Error('a URL deve conter somente a origem da API');
        }
      } catch {
        throw new Error(
          '[Build bloqueado] VITE_SUPABASE_URL deve apontar para a API própria da VPS.',
        );
      }
    }

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
            // Navigations must try the network first so online tabs receive the
            // current shell; the precached index remains an offline-only fallback.
            globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
            navigateFallback: null,
            runtimeCaching: [
              {
                urlPattern: ({ request }) => request.mode === 'navigate',
                handler: 'NetworkOnly',
                options: {
                  precacheFallback: { fallbackURL: 'index.html' },
                },
              },
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
