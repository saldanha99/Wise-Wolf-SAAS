import React from 'react';
import { reloadStaleClient } from '../lib/staleClient';

interface AppLoadBoundaryProps {
  children: React.ReactNode;
  reload?: () => boolean;
}

interface AppLoadBoundaryState {
  failed: boolean;
}

const isMissingChunk = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return /failed to fetch dynamically imported module|importing a module script failed|loading chunk .* failed|preloaderror/i.test(error.message);
};

/** Recupera uma aba antiga quando uma publicação removeu seu chunk lazy. */
export class AppLoadBoundary extends React.Component<AppLoadBoundaryProps, AppLoadBoundaryState> {
  declare readonly props: AppLoadBoundaryProps;
  state: AppLoadBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppLoadBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    if (isMissingChunk(error)) {
      (this.props.reload ?? reloadStaleClient)();
    }
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;

    return (
      <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
        <div role="alert" className="max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 text-center shadow-xl">
          <h1 className="text-xl font-bold">Não foi possível abrir esta área</h1>
          <p className="mt-3 text-sm text-slate-300">
            Seu aplicativo pode estar com uma versão antiga. Atualize a página para continuar.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-5 rounded-xl bg-violet-500 px-5 py-3 text-sm font-bold text-white hover:bg-violet-400"
          >
            Atualizar agora
          </button>
        </div>
      </main>
    );
  }
}
