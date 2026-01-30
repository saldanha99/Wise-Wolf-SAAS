
import React, { useState, useEffect } from 'react';
import {
  CheckCircle,
  XCircle,
  Eye,
  DollarSign,
  FileText,
  RefreshCw,
  Search,
  Filter
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { PaymentStatus } from '../types';

const AdminFinancialApproval: React.FC<{ tenantId?: string }> = ({ tenantId }) => {
  const [loading, setLoading] = useState(true);
  const [isProcessing, setIsProcessing] = useState<string | null>(null);
  const [requests, setRequests] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState('');

  const fetchRequests = async () => {
    if (!tenantId) return;
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('teacher_closings')
        .select(`
          *,
          teacher:teacher_id(full_name, avatar_url, pix_key)
        `)
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });

      if (error) throw error;
      setRequests(data || []);
    } catch (err) {
      console.error('Error fetching approval requests:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, [tenantId]);

  const handleAction = async (id: string, approve: boolean) => {
    setIsProcessing(id);
    try {
      const { error } = await supabase
        .from('teacher_closings')
        .update({
          status: approve ? 'PAGO' : 'REJEITADO',
          updated_at: new Date().toISOString()
        })
        .eq('id', id);

      if (error) throw error;

      setRequests(prev => prev.map(req =>
        req.id === id
          ? { ...req, status: approve ? 'PAGO' : 'REJEITADO' }
          : req
      ));

      if (approve) {
        alert("Sucesso! Pagamento marcado como Liquidado. O repasse será processado via Split EduCore.");
      } else {
        alert("Solicitação recusada. O professor será notificado para conferência de dados.");
      }
    } catch (err) {
      alert("Erro ao processar ação financeira.");
    } finally {
      setIsProcessing(null);
    }
  };

  const handleViewDetails = (req: any) => {
    alert(`Detalhes do Fechamento: ${req.month_year}\nProfessor: ${req.teacher?.full_name}\nAulas: ${req.total_lessons}\nValor: R$ ${req.total_amount}`);
  };

  const filteredRequests = requests.filter(r =>
    r.teacher?.full_name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    r.month_year.includes(searchTerm)
  );

  return (
    <div className="space-y-6 md:space-y-8 animate-in fade-in duration-500">
      <header className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-2xl md:text-3xl font-black text-gray-800 dark:text-slate-100 tracking-tight flex items-center gap-3">
            <CheckCircle className="text-tenant-primary" size={28} /> Aprovação Financeira
          </h2>
          <p className="text-gray-500 dark:text-slate-400 text-sm">Valide os fechamentos mensais enviados pelos professores.</p>
        </div>
        <div className="bg-white dark:bg-slate-900 px-6 py-4 rounded-3xl border border-gray-100 dark:border-slate-800 flex items-center gap-4 shadow-sm w-full md:w-auto overflow-hidden">
          <div className="p-3 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 rounded-2xl">
            <DollarSign size={24} />
          </div>
          <div>
            <p className="text-[10px] text-gray-400 font-black uppercase tracking-widest leading-tight">Total Aguardando</p>
            <p className="text-xl font-black text-gray-800 dark:text-slate-100 tracking-tight">
              R$ {requests.filter(r => r.status === 'CONFIRMADO' || r.status === 'PENDENTE').reduce((acc, r) => acc + r.total_amount, 0).toLocaleString('pt-BR')}
            </p>
          </div>
        </div>
      </header>

      <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] border border-gray-100 dark:border-slate-800 overflow-hidden shadow-sm">
        <div className="p-6 border-b dark:border-slate-800 flex flex-col sm:flex-row justify-between items-center gap-4">
          <div className="flex gap-4">
            <button
              onClick={() => fetchRequests()}
              className="p-2 text-slate-400 hover:text-tenant-primary transition-all"
            >
              <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
            </button>
            <h3 className="font-black text-gray-800 dark:text-slate-200 text-xs uppercase tracking-widest flex items-center">Relatórios Enviados</h3>
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input
              type="text"
              placeholder="Buscar professor ou mês..."
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="w-full pl-12 pr-4 py-3 bg-gray-50 dark:bg-slate-800 border border-transparent focus:border-tenant-primary rounded-xl text-xs outline-none transition-all uppercase font-black"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left min-w-[900px]">
            <thead className="bg-gray-50/50 dark:bg-slate-800/50 text-[10px] text-gray-500 dark:text-slate-400 uppercase font-black border-b dark:border-slate-700">
              <tr>
                <th className="px-8 py-6">Professor / Ciclo</th>
                <th className="px-8 py-6">Valor Transposto</th>
                <th className="px-8 py-6">Status Interno</th>
                <th className="px-8 py-6 text-right">Controle de Saque</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 dark:divide-slate-800">
              {filteredRequests.map((req) => (
                <tr key={req.id} className="hover:bg-gray-50/50 dark:hover:bg-slate-800/30 transition-colors group">
                  <td className="px-8 py-6">
                    <div className="flex items-center gap-4">
                      <img src={req.teacher?.avatar_url || `https://ui-avatars.com/api/?name=${req.teacher?.full_name}`} className="w-10 h-10 rounded-xl" />
                      <div>
                        <span className="font-bold text-gray-800 dark:text-slate-200 block">{req.teacher?.full_name}</span>
                        <span className="text-[10px] font-black text-slate-400 uppercase">Mês Ref: {req.month_year}</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-8 py-6">
                    <span className="font-black text-gray-800 dark:text-slate-100 text-lg uppercase tracking-tighter">R$ {req.total_amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                    <p className="text-[9px] text-slate-400 font-bold">{req.total_lessons} aulas computadas</p>
                  </td>
                  <td className="px-8 py-6">
                    <span className={`text-[9px] px-3 py-1.5 rounded-full font-black uppercase tracking-widest border shadow-sm ${req.status === 'PAGO' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' :
                        req.status === 'CONTESTADO' ? 'bg-orange-50 text-orange-600 border-orange-100' :
                          'bg-blue-50 text-blue-600 border-blue-100'
                      }`}>
                      {req.status}
                    </span>
                  </td>
                  <td className="px-8 py-6">
                    {req.status === 'CONFIRMADO' || req.status === 'PENDENTE' || req.status === 'CONTESTADO' ? (
                      <div className="flex justify-end gap-3">
                        <button
                          onClick={() => handleAction(req.id, false)}
                          disabled={isProcessing === req.id}
                          className="p-3 text-red-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-2xl transition-all"
                        >
                          <XCircle size={22} />
                        </button>
                        <button
                          onClick={() => handleAction(req.id, true)}
                          disabled={isProcessing === req.id}
                          className="flex items-center gap-2 bg-slate-900 text-white dark:bg-tenant-primary px-6 py-3 rounded-2xl text-[10px] font-black hover:scale-105 transition-all uppercase tracking-widest shadow-xl shadow-slate-900/10"
                        >
                          {isProcessing === req.id ? <RefreshCw className="animate-spin" size={16} /> : <CheckCircle size={16} />}
                          Liberar Pagamento
                        </button>
                      </div>
                    ) : (
                      <div className="flex justify-end">
                        <span className={`text-[10px] px-4 py-2 rounded-full font-black uppercase tracking-widest flex items-center gap-1.5 border ${req.status === 'PAGO' ? 'bg-emerald-50 text-emerald-600 border-emerald-100' : 'bg-red-50 text-red-600 border-red-200'
                          }`}>
                          {req.status === 'PAGO' ? 'Liquidado Asaas' : 'Cancelado'}
                        </span>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {filteredRequests.length === 0 && !loading && (
            <div className="py-24 text-center">
              <div className="w-20 h-20 bg-gray-50 dark:bg-slate-800 rounded-[2rem] flex items-center justify-center mx-auto mb-6 text-gray-200">
                <FileText size={40} />
              </div>
              <p className="text-gray-400 dark:text-slate-500 font-bold uppercase tracking-widest text-[10px]">Sem solicitações neste período</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AdminFinancialApproval;
