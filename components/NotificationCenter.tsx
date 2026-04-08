
import React from 'react';
import { Bell, X, CheckCircle, Info, AlertTriangle, Zap, Clock } from 'lucide-react';

export interface Notification {
  id: string;
  title: string;
  description: string;
  type: 'info' | 'success' | 'warning' | 'urgent';
  timestamp: string;
  isRead: boolean;
}

interface NotificationCenterProps {
  notifications: Notification[];
  onClose: () => void;
  onMarkAsRead: (id: string) => void;
  onClearAll: () => void;
}

const NotificationCenter: React.FC<NotificationCenterProps> = ({ 
  notifications, 
  onClose, 
  onMarkAsRead, 
  onClearAll 
}) => {
  return (
    <div className="absolute top-14 right-0 w-[400px] bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl border border-slate-100 dark:border-slate-800 z-50 overflow-hidden animate-in fade-in slide-in-from-top-4 duration-300">
      {/* Header */}
      <div className="p-6 border-b border-slate-50 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-800/50">
        <div>
          <h3 className="text-lg font-black text-slate-900 dark:text-white flex items-center gap-2">
            <Zap size={18} className="text-tenant-primary fill-tenant-primary" />
            Trilhas de Notificações
          </h3>
          <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mt-0.5">
            {notifications.filter(n => !n.isRead).length} Pendentes agora
          </p>
        </div>
        <button 
          onClick={onClose}
          className="p-2 hover:bg-white dark:hover:bg-slate-700 rounded-xl text-slate-400 dark:text-slate-500 transition-all"
        >
          <X size={20} />
        </button>
      </div>

      {/* List */}
      <div className="max-h-[450px] overflow-y-auto custom-scrollbar">
        {notifications.length > 0 ? (
          <div className="divide-y divide-slate-50 dark:divide-slate-800">
            {notifications.map((n) => (
              <div 
                key={n.id} 
                onClick={() => onMarkAsRead(n.id)}
                className={`p-6 hover:bg-slate-50/80 dark:hover:bg-slate-800/50 transition-all cursor-pointer relative group ${!n.isRead ? 'bg-indigo-50/30 dark:bg-indigo-900/10' : ''}`}
              >
                {!n.isRead && (
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-tenant-primary" />
                )}
                
                <div className="flex gap-4">
                  <div className={`shrink-0 w-10 h-10 rounded-xl flex items-center justify-center transition-transform group-hover:scale-110 ${
                    n.type === 'success' ? 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400' :
                    n.type === 'warning' ? 'bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400' :
                    n.type === 'urgent' ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' :
                    'bg-indigo-100 text-indigo-600 dark:bg-indigo-900/30 dark:text-indigo-400'
                  }`}>
                    {n.type === 'success' ? <CheckCircle size={20} /> :
                     n.type === 'warning' ? <AlertTriangle size={20} /> :
                     n.type === 'urgent' ? <Zap size={20} /> :
                     <Info size={20} />}
                  </div>

                  <div className="flex-1 min-w-0">
                    <div className="flex justify-between items-start mb-1">
                      <h4 className={`text-sm font-bold truncate ${!n.isRead ? 'text-slate-900 dark:text-white' : 'text-slate-600 dark:text-slate-400'}`}>
                        {n.title}
                      </h4>
                      <span className="text-[10px] text-slate-400 dark:text-slate-500 flex items-center gap-1 shrink-0 ml-2">
                        <Clock size={10} /> {n.timestamp}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed line-clamp-2">
                      {n.description}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-12 text-center">
            <div className="w-16 h-16 bg-slate-50 dark:bg-slate-800 rounded-full flex items-center justify-center mx-auto mb-4">
              <Bell size={24} className="text-slate-300" />
            </div>
            <p className="text-xs font-black text-slate-400 uppercase tracking-widest">Nada por aqui ainda</p>
            <p className="text-[11px] text-slate-500 mt-1 font-medium">Você será avisado sobre novidades importantes.</p>
          </div>
        )}
      </div>

      {/* Footer */}
      {notifications.length > 0 && (
        <div className="p-4 bg-slate-50/50 dark:bg-slate-800/50 border-t border-slate-100 dark:border-slate-800 flex justify-center">
          <button 
            onClick={onClearAll}
            className="text-[10px] font-black text-slate-400 hover:text-tenant-primary uppercase tracking-widest transition-colors"
          >
            Limpar Todas as Trilhas
          </button>
        </div>
      )}
    </div>
  );
};

export default NotificationCenter;
