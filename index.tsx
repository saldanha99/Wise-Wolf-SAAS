
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import HubApp from './components/hub/HubApp';
import ResetPassword from './components/ResetPassword';
import { WOLFIE_SCENARIO_UI_V2_ENABLED } from './src/components/wolfie/visuals/featureFlags';
import { installPwaFreshnessGuard } from './src/services/pwaFreshness';

document.documentElement.dataset.wolfieScenarioUi =
  WOLFIE_SCENARIO_UI_V2_ENABLED ? 'v2' : 'legacy';

function ApplicationShell({ children }: React.PropsWithChildren) {
  const [updateReady, setUpdateReady] = React.useState(false);

  React.useEffect(
    () => installPwaFreshnessGuard({
      onUpdateReady: () => setUpdateReady(true),
    }),
    [],
  );

  return (
    <>
      {children}
      {updateReady && (
        <aside
          className="fixed bottom-4 left-1/2 z-[1000] w-[min(92vw,30rem)] -translate-x-1/2 rounded-2xl border border-violet-300/30 bg-slate-950/95 p-4 text-slate-100 shadow-2xl backdrop-blur-xl"
          role="status"
          aria-live="polite"
        >
          <p className="text-sm font-black">Nova versão disponível</p>
          <p className="mt-1 text-xs leading-5 text-slate-300">
            Atualize quando puder para usar as melhorias mais recentes.
          </p>
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setUpdateReady(false)}
              className="min-h-11 rounded-xl px-4 text-xs font-bold text-slate-300 hover:bg-white/5"
            >
              Depois
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="min-h-11 rounded-xl bg-violet-500 px-4 text-xs font-black text-white hover:bg-violet-400"
            >
              Atualizar agora
            </button>
          </div>
        </aside>
      )}
    </>
  );
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
const normalizedPath = window.location.pathname.replace(/\/+$/, '') || '/';
const RootApp = normalizedPath === '/hub' || normalizedPath.startsWith('/hub/')
  ? HubApp
  : normalizedPath === '/reset-password'
    ? ResetPassword
    : App;
root.render(
  <React.StrictMode>
    <ApplicationShell>
      <RootApp />
    </ApplicationShell>
  </React.StrictMode>
);
