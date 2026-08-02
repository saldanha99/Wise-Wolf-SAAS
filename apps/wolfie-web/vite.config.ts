import path from "node:path";
import {
  cpSync,
  copyFileSync,
  createReadStream,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

const appRoot = path.resolve(__dirname);
const repoRoot = path.resolve(__dirname, "../..");
const sharedPublicRoot = path.resolve(repoRoot, "public");
const standaloneOutput = path.resolve(repoRoot, "dist-wolfie");
const standaloneIcons = [
  "apple-touch-icon.png",
  "pwa-192x192.png",
  "pwa-512x512.png",
  "pwa-maskable-512x512.png",
] as const;
const requiredPublicBuildEnv = [
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_ANON_KEY",
] as const;

const standaloneSeoAssets = () => ({
  name: "wolfie-standalone-seo-assets",
  generateBundle(this: { emitFile: (asset: { type: "asset"; fileName: string; source: string }) => void }) {
    this.emitFile({
      type: "asset",
      fileName: "robots.txt",
      source: [
        "User-agent: *",
        "Allow: /",
        "Disallow: /app",
        "Disallow: /entrar",
        "Disallow: /quiz/resultado",
        "Sitemap: https://wolfie.wisewolflanguage.com.br/sitemap.xml",
        "",
      ].join("\n"),
    });
    this.emitFile({
      type: "asset",
      fileName: "sitemap.xml",
      source: `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://wolfie.wisewolflanguage.com.br/</loc></url>
  <url><loc>https://wolfie.wisewolflanguage.com.br/como-funciona</loc></url>
  <url><loc>https://wolfie.wisewolflanguage.com.br/quiz</loc></url>
  <url><loc>https://wolfie.wisewolflanguage.com.br/planos</loc></url>
  <url><loc>https://wolfie.wisewolflanguage.com.br/privacidade</loc></url>
  <url><loc>https://wolfie.wisewolflanguage.com.br/termos</loc></url>
</urlset>
`,
    });
  },
});

const isInside = (base: string, candidate: string) => {
  const relativePath = path.relative(base, candidate);
  return relativePath !== "" && !relativePath.startsWith("..") &&
    !path.isAbsolute(relativePath);
};

const assertTreeHasNoLinks = (directory: string) => {
  const status = lstatSync(directory);
  if (!status.isDirectory() || status.isSymbolicLink()) {
    throw new Error(`[Build Wolfie bloqueado] diretório público inseguro: ${directory}`);
  }
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const entryStatus = lstatSync(entryPath);
    if (entryStatus.isSymbolicLink()) {
      throw new Error(`[Build Wolfie bloqueado] link simbólico em asset: ${entryPath}`);
    }
    if (entryStatus.isDirectory()) assertTreeHasNoLinks(entryPath);
  }
};

const standalonePublicAssets = () => {
  const wolfieSource = path.resolve(sharedPublicRoot, "assets/wolfie");
  const wolfieSourceReal = realpathSync(wolfieSource);

  return {
    name: "wolfie-standalone-public-assets",
    configureServer(server: {
      middlewares: {
        use: (handler: (
          request: { url?: string },
          response: {
            statusCode: number;
            setHeader: (name: string, value: string) => void;
          } & NodeJS.WritableStream,
          next: () => void,
        ) => void) => void;
      };
    }) {
      server.middlewares.use((request, response, next) => {
        let pathname: string;
        try {
          pathname = decodeURIComponent(
            new URL(request.url ?? "/", "http://wolfie.local").pathname,
          );
        } catch {
          response.statusCode = 400;
          response.end();
          return;
        }

        let candidate: string | null = null;
        if (standaloneIcons.some((icon) => pathname === `/${icon}`)) {
          candidate = path.resolve(sharedPublicRoot, pathname.slice(1));
        } else if (pathname.startsWith("/assets/wolfie/")) {
          candidate = path.resolve(sharedPublicRoot, `.${pathname}`);
        }
        if (!candidate) {
          next();
          return;
        }

        try {
          const status = lstatSync(candidate);
          const realCandidate = realpathSync(candidate);
          if (status.isSymbolicLink() || !status.isFile() ||
            (!isInside(wolfieSourceReal, realCandidate) &&
              !standaloneIcons.some((icon) =>
                realCandidate === realpathSync(path.resolve(sharedPublicRoot, icon))
              ))) {
            throw new Error("asset fora da allowlist");
          }
          response.setHeader(
            "Content-Type",
            candidate.endsWith(".webp") ? "image/webp" : "image/png",
          );
          createReadStream(candidate).pipe(response);
        } catch {
          response.statusCode = 404;
          response.end();
        }
      });
    },
    writeBundle(options: { dir?: string }) {
      const outputDirectory = path.resolve(options.dir ?? "");
      if (outputDirectory !== standaloneOutput) {
        throw new Error("[Build Wolfie bloqueado] diretório de saída inesperado.");
      }
      assertTreeHasNoLinks(wolfieSource);
      const wolfieDestination = path.resolve(outputDirectory, "assets/wolfie");
      mkdirSync(path.dirname(wolfieDestination), { recursive: true });
      cpSync(wolfieSource, wolfieDestination, {
        recursive: true,
        dereference: false,
      });
      for (const icon of standaloneIcons) {
        const source = path.resolve(sharedPublicRoot, icon);
        const sourceStatus = lstatSync(source);
        if (!sourceStatus.isFile() || sourceStatus.isSymbolicLink()) {
          throw new Error(`[Build Wolfie bloqueado] ícone inseguro: ${icon}`);
        }
        copyFileSync(source, path.resolve(outputDirectory, icon));
      }
    },
  };
};

export default defineConfig(({ command, mode }) => {
  const fileEnv = loadEnv(mode, repoRoot, "");
  const buildEnv: Record<string, string | undefined> = {
    ...fileEnv,
    ...process.env,
  };

  if (command === "build") {
    for (const name of requiredPublicBuildEnv) {
      const value = buildEnv[name]?.trim();
      if (!value || value.startsWith("replace-with-")) {
        throw new Error(
          `[Build Wolfie bloqueado] ${name} precisa estar configurada antes da publicação.`,
        );
      }
    }

    try {
      const apiUrl = new URL(buildEnv.VITE_SUPABASE_URL!);
      const localHttp = apiUrl.protocol === "http:" &&
        ["localhost", "127.0.0.1", "::1"].includes(apiUrl.hostname);
      if ((apiUrl.protocol !== "https:" && !localHttp) ||
        apiUrl.hostname.endsWith(".supabase.co")) {
        throw new Error("destino não permitido");
      }
    } catch {
      throw new Error(
        "[Build Wolfie bloqueado] VITE_SUPABASE_URL deve apontar para a API própria da VPS.",
      );
    }
  }

  return {
    root: appRoot,
    envDir: repoRoot,
    publicDir: false,
    server: {
      host: "0.0.0.0",
      port: 3001,
    },
    preview: {
      host: "0.0.0.0",
      port: 4301,
    },
    css: {
      postcss: repoRoot,
    },
    plugins: [
      react(),
      standalonePublicAssets(),
      standaloneSeoAssets(),
      VitePWA({
        registerType: "autoUpdate",
        manifest: {
          name: "Wolfie AI Tutor — Wise Wolf",
          short_name: "Wolfie Tutor",
          description:
            "Pratique inglês em cenários reais com um tutor de IA por voz e texto.",
          theme_color: "#07111f",
          background_color: "#07111f",
          display: "standalone",
          orientation: "any",
          start_url: "/app",
          scope: "/",
          lang: "pt-BR",
          icons: [
            { src: "/pwa-192x192.png", sizes: "192x192", type: "image/png" },
            { src: "/pwa-512x512.png", sizes: "512x512", type: "image/png" },
            {
              src: "/pwa-maskable-512x512.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          // As cenas WebP continuam disponíveis e cacheáveis pelo servidor,
          // mas não entram todas no precache inicial do PWA.
          globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
          navigateFallback: null,
          runtimeCaching: [
            {
              urlPattern: ({ request }) => request.mode === "navigate",
              handler: "NetworkOnly",
              options: {
                precacheFallback: { fallbackURL: "index.html" },
              },
            },
            {
              urlPattern: ({ url }) =>
                url.pathname.startsWith("/auth/v1/") ||
                url.pathname.startsWith("/rest/v1/") ||
                url.pathname.startsWith("/functions/v1/"),
              handler: "NetworkOnly",
            },
          ],
        },
      }),
    ],
    resolve: {
      alias: {
        "@": repoRoot,
      },
    },
    build: {
      outDir: path.resolve(repoRoot, "dist-wolfie"),
      emptyOutDir: true,
      sourcemap: false,
      rollupOptions: {
        output: {
          manualChunks: {
            "react-vendor": ["react", "react-dom"],
            "motion-vendor": ["framer-motion"],
            "supabase-vendor": ["@supabase/supabase-js"],
          },
        },
      },
    },
  };
});
