
import React, { useState, useEffect } from 'react';
import {
  CreditCard,
  CheckCircle,
  AlertCircle,
  RefreshCw,
  DollarSign,
  Calendar,
  ShieldCheck,
  Download,
  Info
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { User as UserType } from '../types';

interface StudentBillingProps {
  user: UserType;
}

const StudentBilling: React.FC<StudentBillingProps> = ({ user }) => {
  const [billingInfo, setBillingInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const fetchBillingData = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, full_name, module, monthly_fee, status')
        .eq('id', user.id)
        .single();

      if (error) throw error;
      setBillingInfo(data);
    } catch (err) {
      console.error('Error fetching billing data:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (user?.id) fetchBillingData();
  }, [user?.id]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-slate-400">
        <RefreshCw className="animate-spin mb-4" size={32} />
        <p className="text-xs font-black uppercase tracking-widest">Carregando dados financeiros...</p>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 pb-20">
      <header>
        <h2 className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter">Meu Financeiro</h2>
        <p className="text-slate-500 dark:text-slate-400 text-sm mt-1">Acompanhe seus planos, pagamentos e histórico de mensalidades.</p>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">

        {/* Main Card: Current Plan */}
        <div className="lg:col-span-2 bg-white dark:bg-slate-900 rounded-[2.5rem] border border-slate-100 dark:border-slate-800 p-8 shadow-xl shadow-slate-200/50 dark:shadow-none relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-8 opacity-5 group-hover:scale-110 transition-transform duration-500">
            <ShieldCheck size={120} className="text-tenant-primary" />
          </div>

          <div className="relative z-10">
            <div className="flex items-center gap-3 mb-8">
              <div className="p-3 bg-tenant-primary/10 text-tenant-primary rounded-2xl">
                <CreditCard size={24} />
              </div>
              <div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest block">Status da Assinatura</span>
                <span className="flex items-center gap-2 text-emerald-500 font-black text-sm uppercase tracking-wide">
                  <CheckCircle size={14} /> Ativo & Regular
                </span>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
              <div>
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Valor Mensal</h4>
                <div className="flex items-baseline gap-1">
                  <span className="text-lg font-bold text-slate-400">R$</span>
                  <span className="text-4xl font-black text-slate-800 dark:text-white tracking-tighter">
                    {(Number(billingInfo?.monthly_fee) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
              <div>
                <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Próximo Vencimento</h4>
                <div className="flex items-center gap-3">
                  <div className="p-2 bg-slate-100 dark:bg-slate-800 rounded-lg text-slate-500">
                    <Calendar size={18} />
                  </div>
                  <span className="text-xl font-black text-slate-700 dark:text-slate-200 tracking-tight">Dia 10 / Prox. Mês</span>
                </div>
              </div>
            </div>

            <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-2xl flex items-center gap-4 text-blue-700 dark:text-blue-400 text-xs font-bold border border-blue-100 dark:border-blue-900/30">
              <Info size={20} className="shrink-0" />
              <p>Seu pagamento é processado mensalmente via boleto ou cartão conforme configurado com a escola.</p>
            </div>
          </div>
        </div>

        {/* Support/Info Card */}
        <div className="bg-slate-900 rounded-[2.5rem] p-8 text-white shadow-2xl relative overflow-hidden group">
          <div className="absolute top-0 right-0 p-8 opacity-10 group-hover:rotate-12 transition-transform duration-500">
            <DollarSign size={100} />
          </div>

          <div className="relative z-10 h-full flex flex-col justify-between">
            <div>
              <h3 className="text-2xl font-black tracking-tight mb-4">Dúvidas com Pagamento?</h3>
              <p className="text-slate-300 text-sm leading-relaxed mb-6">
                Caso precise alterar sua forma de pagamento ou tenha dúvidas sobre cobranças, entre em contato direto com a secretaria da escola.
              </p>
            </div>

            <button className="w-full py-4 bg-white text-slate-900 rounded-2xl font-black text-xs uppercase tracking-widest hover:scale-105 active:scale-95 transition-all">
              Falar com Suporte
            </button>
          </div>
        </div>

      </div>

      {/* History Table (Mocked since we don't have a payments table yet) */}
      <div className="bg-white dark:bg-slate-900 rounded-[3rem] border border-slate-100 dark:border-slate-800 shadow-xl shadow-slate-200/50 dark:shadow-none overflow-hidden">
        <div className="p-8 border-b dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/30">
          <h3 className="font-black text-slate-700 dark:text-slate-200 text-sm uppercase tracking-widest">Histórico de Mensalidades</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-[10px] text-slate-400 uppercase font-black border-b dark:border-slate-700">
              <tr>
                <th className="px-10 py-5">Período</th>
                <th className="px-10 py-5">Vencimento</th>
                <th className="px-10 py-5">Valor</th>
                <th className="px-10 py-5">Status</th>
                <th className="px-10 py-5 text-right">Comprovante</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50 dark:divide-slate-800">
              <tr className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                <td className="px-10 py-6">
                  <span className="font-black text-slate-700 dark:text-slate-200">Janeiro / 2024</span>
                </td>
                <td className="px-10 py-6 text-slate-500 dark:text-slate-400 font-bold text-xs">10/01/2024</td>
                <td className="px-10 py-6 font-black text-slate-800 dark:text-white">
                  R$ {(Number(billingInfo?.monthly_fee) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </td>
                <td className="px-10 py-6 text-emerald-500 font-black text-[10px] uppercase tracking-widest">PAGO</td>
                <td className="px-10 py-6 text-right">
                  <button className="p-2 text-slate-400 hover:text-tenant-primary transition-colors">
                    <Download size={18} />
                  </button>
                </td>
              </tr>
              <tr className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors">
                <td className="px-10 py-6">
                  <span className="font-black text-slate-700 dark:text-slate-200">Dezembro / 2023</span>
                </td>
                <td className="px-10 py-6 text-slate-500 dark:text-slate-400 font-bold text-xs">10/12/2023</td>
                <td className="px-10 py-6 font-black text-slate-800 dark:text-white">
                  R$ {(Number(billingInfo?.monthly_fee) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </td>
                <td className="px-10 py-6 text-emerald-500 font-black text-[10px] uppercase tracking-widest">PAGO</td>
                <td className="px-10 py-6 text-right">
                  <button className="p-2 text-slate-400 hover:text-tenant-primary transition-colors">
                    <Download size={18} />
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

export default StudentBilling;
