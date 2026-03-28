import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { TeacherContractDocument } from './TeacherContractDocument';
import { Loader2, AlertCircle, FileText } from 'lucide-react';

interface PublicContractViewProps {
    id?: string;
}

const PublicContractView: React.FC<PublicContractViewProps> = ({ id: propId }) => {
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [profile, setProfile] = useState<any>(null);

    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const id = propId || params.get('id');

        if (!id) {
            setError("ID do contrato não fornecido.");
            setLoading(false);
            return;
        }

        const fetchProfile = async () => {
            try {
                // Fetch basic public profile info for the contract
                const { data, error: fetchError } = await supabase
                    .from('profiles')
                    .select('full_name, rg, cpf, address, birth_date, hourly_rate, contract_accepted, accepted_at, user_ip')
                    .eq('id', id)
                    .single();

                if (fetchError) throw fetchError;
                if (!data) throw new Error("Contrato não encontrado.");

                setProfile(data);
            } catch (err: any) {
                console.error(err);
                setError(err.message || "Erro ao carregar o contrato.");
            } finally {
                setLoading(false);
            }
        };

        fetchProfile();
    }, []);

    if (loading) {
        return (
            <div className="min-h-screen flex flex-col items-center justify-center bg-slate-50 gap-4">
                <Loader2 className="animate-spin text-tenant-primary" size={48} />
                <p className="text-slate-500 font-bold uppercase tracking-widest text-xs">Autenticando Contrato...</p>
            </div>
        );
    }

    if (error || !profile) {
        return (
            <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
                <div className="bg-white p-8 rounded-3xl shadow-xl max-w-md w-full text-center">
                    <AlertCircle size={48} className="text-red-500 mx-auto mb-4" />
                    <h2 className="text-xl font-bold text-slate-800 mb-2">Erro na Visualização</h2>
                    <p className="text-slate-500 mb-6">{error}</p>
                    <a href="/" className="text-tenant-primary font-bold hover:underline">Ir para o Portal</a>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-gray-100 py-10">
            {/* Security Header */}
            <div className="max-w-[210mm] mx-auto mb-6 px-4 flex items-center justify-between text-slate-400">
                <div className="flex items-center gap-2">
                    <FileText size={16} />
                    <span className="text-[10px] font-black uppercase tracking-widest">Documento Digital Autêntico</span>
                </div>
                <div className="text-[10px] font-bold">
                    ID: {new URLSearchParams(window.location.search).get('id')?.substring(0, 8)}...
                </div>
            </div>

            <TeacherContractDocument
                teacherName={profile.full_name}
                teacherRG={profile.rg}
                teacherCPF={profile.cpf}
                teacherAddress={profile.address}
                teacherBirthDate={profile.birth_date}
                hourlyRate={profile.hourly_rate}
                acceptedAt={profile.accepted_at}
                userIp={profile.user_ip}
                subscriptionId={new URLSearchParams(window.location.search).get('id') || undefined}
            />
        </div>
    );
};

export default PublicContractView;
