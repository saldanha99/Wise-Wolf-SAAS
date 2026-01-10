
import React, { useState } from 'react';
import { supabase } from '../lib/supabase';
import { MOCK_ACCOUNTS, MOCK_TENANTS } from '../constants';
import { Database, Loader2, CheckCircle, AlertCircle } from 'lucide-react';

const SupabaseSeeder = () => {
    const [loading, setLoading] = useState(false);
    const [status, setStatus] = useState('');
    const [error, setError] = useState('');

    const seedDatabase = async () => {
        setLoading(true);
        setStatus('Iniciando...');
        setError('');

        try {
            // 1. Seed Tenants
            setStatus('Criando Escolas (Tenants)...');
            for (const key of Object.keys(MOCK_TENANTS)) {
                const tenant = MOCK_TENANTS[key];
                const { error } = await supabase.from('tenants').upsert({
                    id: tenant.id,
                    name: tenant.name,
                    domain: tenant.domain,
                    branding: tenant.branding,
                    student_limit: tenant.studentLimit,
                    teacher_limit: tenant.teacherLimit
                });
                if (error) throw new Error(`Erro ao criar tenant ${tenant.name}: ${error.message}`);
            }

            // 2. Seed Users & Profiles
            setStatus('Criando Usuários e Perfis...');
            const profileIds: Record<string, string> = {};

            for (const account of MOCK_ACCOUNTS) {
                let userId = null;

                const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
                    email: account.email,
                    password: account.password,
                });

                if (signUpError) {
                    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
                        email: account.email,
                        password: account.password
                    });
                    if (signInError) {
                        console.error(`Falha ao logar/criar usuario ${account.email}`, signInError);
                    } else if (signInData.user) {
                        userId = signInData.user.id;
                    }
                } else if (signUpData.user) {
                    userId = signUpData.user.id;
                }

                if (userId) {
                    profileIds[account.email] = userId;
                    await supabase.from('profiles').upsert({
                        id: userId,
                        email: account.email,
                        full_name: account.user.name,
                        role: account.user.role,
                        tenant_id: account.user.tenantId,
                        avatar_url: account.user.avatar,
                        module: (account.user as any).module || 'A1',
                        current_book_part: 'A1-1',
                        evaluation_unlocked: false
                    });
                }
            }

            // 3. Create Demo Booking for Prof Lobo and Aluno Teste
            setStatus('Configurando vínculos (Aulas)...');
            const loboId = profileIds['professor@wisewolf.com'];
            const alunoId = profileIds['aluno@wisewolf.com'];

            if (loboId && alunoId) {
                await supabase.from('bookings').upsert({
                    teacher_id: loboId,
                    student_id: alunoId,
                    day_of_week: 'Segunda',
                    time_slot: '14:00',
                    module: 'A1',
                    type: 'Individual',
                    tenant_id: 'wise-wolf-school'
                });
            }

            setStatus('Concluído com Sucesso!');
            setLoading(false);
        } catch (err: any) {
            console.error(err);
            setError(err.message || 'Erro desconhecido');
            setLoading(false);
        }
    };

    return (
        <div className="mt-4 p-4 bg-slate-800/50 rounded-xl border border-slate-700/50">
            <div className="flex items-center justify-between mb-2">
                <h4 className="text-white text-[10px] font-black uppercase flex items-center gap-2 tracking-widest">
                    <Database size={14} className="text-blue-400" /> Setup Banco de Dados
                </h4>
                {status && <span className="text-[9px] text-blue-300 animate-pulse">{status}</span>}
            </div>

            {error && (
                <div className="mb-3 p-2 bg-red-900/30 text-red-300 text-[10px] rounded border border-red-900/50 flex items-center gap-2">
                    <AlertCircle size={12} /> {error}
                </div>
            )}

            {status === 'Concluído com Sucesso!' ? (
                <div className="p-2 bg-green-900/30 text-green-300 text-[10px] rounded border border-green-900/50 flex items-center gap-2 font-bold justify-center">
                    <CheckCircle size={12} /> Banco Populado!
                </div>
            ) : (
                <button
                    onClick={seedDatabase}
                    disabled={loading}
                    className="w-full py-2 bg-blue-600/20 hover:bg-blue-600/40 text-blue-400 hover:text-white border border-blue-500/30 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                    {loading ? <Loader2 size={14} className="animate-spin" /> : 'Restaurar Ambiente Demo'}
                </button>
            )}
        </div>
    );
};

export default SupabaseSeeder;
