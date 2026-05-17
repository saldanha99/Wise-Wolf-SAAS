import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { User, JobApplication, JobStatus } from '../types';
import { Briefcase, FileText, Search, UserCheck, XCircle, Clock, ChevronDown, CheckCircle } from 'lucide-react';

interface HRModuleProps {
    user: User;
    tenantId?: string;
}

const HRModule: React.FC<HRModuleProps> = ({ user, tenantId }) => {
    const [applications, setApplications] = useState<JobApplication[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [searchTerm, setSearchTerm] = useState('');

    const fetchApplications = async () => {
        if (!tenantId) return;
        setIsLoading(true);
        try {
            const { data, error } = await supabase
                .from('job_applications')
                .select('*')
                .eq('tenant_id', tenantId)
                .order('created_at', { ascending: false });

            if (error) throw error;
            setApplications(data || []);
        } catch (error: any) {
            console.error('Error fetching job applications:', error);
            alert('Erro ao carregar currículos.');
        } finally {
            setIsLoading(false);
        }
    };

    useEffect(() => {
        fetchApplications();
    }, [tenantId]);

    const updateStatus = async (id: string, newStatus: JobStatus) => {
        try {
            const { error } = await supabase
                .from('job_applications')
                .update({ status: newStatus })
                .eq('id', id);

            if (error) throw error;

            setApplications(apps => apps.map(app =>
                app.id === id ? { ...app, status: newStatus } : app
            ));
        } catch (error: any) {
            console.error('Error updating status:', error);
            alert('Erro ao atualizar status.');
        }
    };

    const getStatusBadge = (status: JobStatus) => {
        const styles: Record<JobStatus, string> = {
            'Novo': 'bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200 dark:border-blue-500/20',
            'Em Análise': 'bg-yellow-100 dark:bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border-yellow-200 dark:border-yellow-500/20',
            'Entrevistado': 'bg-purple-100 dark:bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-200 dark:border-purple-500/20',
            'Contratado': 'bg-green-100 dark:bg-green-500/10 text-green-600 dark:text-green-400 border-green-200 dark:border-green-500/20',
            'Rejeitado': 'bg-red-100 dark:bg-red-500/10 text-red-600 dark:text-red-400 border-red-200 dark:border-red-500/20'
        };

        return (
            <span className={`px-3 py-1.5 flex items-center justify-center w-full max-w-[120px] rounded-full text-xs font-semibold border ${styles[status]}`}>
                {status}
            </span>
        );
    };

    const openResume = (url?: string) => {
        if (url) {
            window.open(url, '_blank');
        } else {
            alert('Currículo não anexado.');
        }
    };

    const filteredApps = applications.filter(app =>
        app.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        app.whatsapp.includes(searchTerm)
    );

    return (
        <div className="space-y-6">
            <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                    <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-blue-600 to-purple-600 dark:from-blue-400 dark:to-purple-400 flex items-center gap-2">
                        <Briefcase className="w-8 h-8 text-blue-500" />
                        Recursos Humanos
                    </h2>
                    <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
                        Gerencie as candidaturas e currículos recebidos pelo site.
                    </p>
                </div>
            </div>

            <div className="bg-brand-surface/80 dark:bg-brand-surface/80 backdrop-blur-xl border border-gray-200 dark:border-gray-800 rounded-3xl p-6 shadow-sm overflow-hidden relative">
                <div className="flex flex-col md:flex-row justify-between mb-6 gap-4 relative z-10">
                    <div className="relative w-full md:w-96">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                        <input
                            type="text"
                            placeholder="Buscar candidato por nome ou whatsapp..."
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full pl-11 pr-4 py-3 bg-gray-50 dark:bg-brand-surface-2/80 border border-gray-200 dark:border-gray-700 rounded-xl text-sm focus:ring-2 focus:ring-blue-500 outline-none transition-all dark:text-gray-200 shadow-sm"
                        />
                    </div>
                </div>

                {isLoading ? (
                    <div className="flex flex-col items-center justify-center p-16 relative z-10">
                        <div className="w-10 h-10 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                        <p className="mt-4 text-sm text-gray-500 font-medium animate-pulse">Carregando currículos...</p>
                    </div>
                ) : filteredApps.length === 0 ? (
                    <div className="text-center p-16 bg-gray-50/50 dark:bg-brand-surface-2/20 rounded-2xl border border-dashed border-gray-200 dark:border-gray-700 relative z-10">
                        <Briefcase className="w-16 h-16 text-gray-300 dark:text-gray-600 mx-auto mb-4" />
                        <h3 className="text-base font-bold text-gray-700 dark:text-gray-300">Nenhum candidato encontrado</h3>
                        <p className="text-sm text-gray-500 mt-2 max-w-sm mx-auto">
                            {searchTerm
                                ? "Não encontramos nenhum candidato com os termos buscados."
                                : "Ainda não há nenhuma candidatura de emprego registrada em seu sistema."}
                        </p>
                    </div>
                ) : (
                    <div className="overflow-x-auto relative z-10 -mx-6 px-6 pb-4">
                        <table className="w-full text-sm text-left border-separate border-spacing-y-2">
                            <thead className="text-xs text-gray-500 uppercase font-semibold">
                                <tr>
                                    <th className="px-6 py-3 px-8">Candidato</th>
                                    <th className="px-6 py-3">WhatsApp</th>
                                    <th className="px-6 py-3">Status</th>
                                    <th className="px-6 py-3">Data da Inscrição</th>
                                    <th className="px-6 py-3 text-right">Ações</th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredApps.map((app) => (
                                    <tr key={app.id} className="bg-gray-50 dark:bg-brand-surface-2/40 hover:bg-gray-100 dark:hover:bg-brand-surface-2/80 transition-colors group shadow-sm rounded-xl">
                                        <td className="px-6 py-4 font-bold text-gray-900 dark:text-gray-100 rounded-l-xl">
                                            {app.name}
                                        </td>
                                        <td className="px-6 py-4 text-gray-600 dark:text-gray-400 font-medium">
                                            {app.whatsapp}
                                        </td>
                                        <td className="px-6 py-4">
                                            {getStatusBadge(app.status)}
                                        </td>
                                        <td className="px-6 py-4 text-gray-500 dark:text-gray-500 font-medium">
                                            {new Date(app.created_at).toLocaleDateString('pt-BR')} às {new Date(app.created_at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                                        </td>
                                        <td className="px-6 py-4 text-right rounded-r-xl">
                                            <div className="flex items-center justify-end gap-3">
                                                <button
                                                    onClick={() => openResume(app.resume_url)}
                                                    disabled={!app.resume_url}
                                                    className="p-2 text-gray-500 hover:text-blue-600 hover:bg-blue-100 dark:hover:bg-blue-500/20 rounded-lg transition-colors font-medium text-xs flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    title="Visualizar Currículo (PDF)"
                                                >
                                                    <FileText className="w-4 h-4" />
                                                    <span>PDF</span>
                                                </button>

                                                <div className="h-6 w-px bg-gray-200 dark:bg-gray-700"></div>

                                                <select
                                                    value={app.status}
                                                    onChange={(e) => updateStatus(app.id, e.target.value as JobStatus)}
                                                    className="text-xs bg-brand-surface border border-gray-200 dark:border-gray-700 rounded-lg pl-3 pr-8 py-2 font-semibold text-gray-700 dark:text-gray-200 outline-none focus:ring-2 focus:ring-blue-500 shadow-sm transition-all cursor-pointer appearance-none bg-[url('data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%22292.4%22%20height%3D%22292.4%22%3E%3Cpath%20fill%3D%22%239CA3AF%22%20d%3D%22M287%2069.4a17.6%2017.6%200%200%200-13-5.4H18.4c-5%200-9.3%201.8-12.9%205.4A17.6%2017.6%200%200%200%200%2082.2c0%205%201.8%209.3%205.4%2012.9l128%20127.9c3.6%203.6%207.8%205.4%2012.8%205.4s9.2-1.8%2012.8-5.4L287%2095c3.5-3.5%205.4-7.8%205.4-12.8%200-5-1.9-9.2-5.5-12.8z%22%2F%3E%3C%2Fsvg%3E')] bg-[length:10px_10px] bg-[right_10px_center] bg-no-repeat"
                                                >
                                                    <option value="Novo">Novo</option>
                                                    <option value="Em Análise">Em Análise</option>
                                                    <option value="Entrevistado">Entrevistado</option>
                                                    <option value="Contratado">Contratado</option>
                                                    <option value="Rejeitado">Rejeitado</option>
                                                </select>
                                            </div>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    );
};

export default HRModule;
