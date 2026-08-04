import React from 'react';
import { NavGroup } from '../lib/adminNav';

/**
 * Abas em volta da tela ativa.
 *
 * O agrupamento do menu não pode custar os links diretos: `DirectorPendingCenter`,
 * os botões "Ver todos" e a allowlist de abas navegam por id. Por isso este
 * componente NÃO controla qual tela renderiza — ele recebe a tela já pronta e só
 * desenha as abas em volta, lendo o id ativo. Abrir `dre` por link direto cai na
 * mesma tela que clicar em Relatórios e escolher a aba.
 *
 * Grupo de uma aba só não desenha nada: barra de abas com um item é ruído.
 */

interface Props {
  group: NavGroup;
  activeTab: string;
  onChange: (id: string) => void;
  pendingCounts?: Record<string, number>;
  children: React.ReactNode;
}

const ScreenTabs: React.FC<Props> = ({ group, activeTab, onChange, pendingCounts = {}, children }) => {
  if (group.tabs.length < 2) return <>{children}</>;

  return (
    <div className="space-y-5">
      <div
        role="tablist"
        aria-label={group.label}
        className="flex items-center gap-1 overflow-x-auto pb-1 -mx-1 px-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {group.tabs.map(t => {
          const ativa = t.id === activeTab;
          const badge = t.badgeKey ? pendingCounts[t.badgeKey] : undefined;
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={ativa}
              onClick={() => onChange(t.id)}
              className={`flex items-center gap-1.5 whitespace-nowrap text-sm font-bold px-3.5 py-2 rounded-xl transition-colors ${
                ativa
                  ? 'bg-brand-surface text-brand-text border border-brand-border shadow-sm'
                  : 'text-brand-muted hover:text-brand-text hover:bg-brand-surface-2 border border-transparent'
              }`}
            >
              {t.label}
              {!!badge && badge > 0 && (
                <span className="text-[10px] font-black px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600">
                  {badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
      {children}
    </div>
  );
};

export default ScreenTabs;
