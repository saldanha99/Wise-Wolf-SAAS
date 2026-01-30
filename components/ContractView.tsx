import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { ContractDocument } from './ContractDocument';
import { RefreshCw } from 'lucide-react';

interface ContractViewProps {
    userId: string;
    classFrequency?: number | string;
}

const ContractView: React.FC<ContractViewProps> = ({ userId, classFrequency = 2 }) => {
    const [profile, setProfile] = useState<any>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        fetchContractData();
    }, [userId]);

    const fetchContractData = async () => {
        try {
            setLoading(true);
            const { data, error } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', userId)
                .single();

            if (error) throw error;
            setProfile(data);
        } catch (error) {
            console.error("Erro ao carregar contrato:", error);
        } finally {
            setLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="flex justify-center items-center h-64 text-slate-500 gap-2">
                <RefreshCw className="animate-spin" /> Carregando Contrato...
            </div>
        );
    }

    if (!profile) return <div>Contrato não encontrado.</div>;

    // Determine Duration based on Plan/Modality or default
    let duration = 12; // Default Anual
    let planName = 'Plano Recorrente';

    if (profile.module?.includes('Semestral') || profile.modality === 'SEMESTER') {
        duration = 6;
        planName = 'Plano Semestral';
    } else if (profile.module?.includes('Anual') || profile.modality === 'ANNUAL') {
        duration = 12;
        planName = 'Plano Anual';
    }

    // Format Dates
    const startDate = new Date(profile.created_at || new Date()).toLocaleDateString('pt-BR');
    const endDate = new Date(new Date().setMonth(new Date().getMonth() + duration)).toLocaleDateString('pt-BR');

    return (
        <ContractDocument
            studentName={profile.full_name || 'Aluno Wise Wolf'}
            studentCPF={profile.cpf || '000.000.000-00'}
            studentAddress={`${profile.address || ''}, ${profile.address_number || ''} - ${profile.postal_code || ''}`}
            studentEmail={profile.email}
            studentPhone={profile.phone || ''}
            planName={planName}
            planValue={(profile.monthly_fee || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            planDuration={duration}
            startDate={startDate}
            endDate={endDate}
            dueDay={profile.due_day || 10}
            classFrequency={classFrequency}
            acceptedAt={profile.accepted_at}
            userIp={profile.signature_ip}
        />
    );
};

export default ContractView;
