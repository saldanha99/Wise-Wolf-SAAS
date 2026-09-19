
import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { whatsappService } from '../services/whatsappService';
import { Users, Save, Loader } from 'lucide-react';

export type NoticeChannel = 'direcao' | 'financeiro' | 'coordenacao' | 'comercial';

// Para onde o canal cai enquanto não tem grupo próprio (get_notice_channels.fallback).
const FALLBACK_NOTE: Record<string, string> = {
    gestao: 'Sem grupo escolhido: os avisos deste canal caem no grupo da Gestão.',
    direcao: 'Sem grupo escolhido: os avisos deste canal caem no grupo da Direção.',
    grupo_de_avisos: 'Sem grupo escolhido: os avisos deste canal caem no Grupo de Avisos (Leads / Aceites).',
    grupo_dos_professores: 'Sem grupo escolhido: usa o Grupo de Oportunidades.',
};

interface GroupSelectorProps {
    user: any;
    instanceName: string;
    label?: string;
    description?: string;
    dbColumn?: string;
    /**
     * Canal de aviso (tenant_notice_channels) em vez de coluna do perfil: o valor
     * vai e volta pelas RPCs get_notice_channels / save_notice_channel. Sem grupo
     * escolhido, o canal cai no grupo da Gestão — a tela diz isso.
     */
    channel?: NoticeChannel;
}

const GroupSelector: React.FC<GroupSelectorProps> = ({
    user,
    instanceName,
    label = "Grupo de Destino",
    description = "Selecione o grupo de WhatsApp onde as vagas serão publicadas.",
    dbColumn = "teachers_group_id",
    channel
}) => {
    const [groups, setGroups] = useState<any[]>([]);
    const [selectedGroup, setSelectedGroup] = useState('');
    const [fallbackNote, setFallbackNote] = useState('');
    const [loading, setLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [feedback, setFeedback] = useState('');
    const [open, setOpen] = useState(false); // Collapsible state to avoid fetching 2x instantly

    useEffect(() => {
        if (user && instanceName) {
            // Only fetch groups once or on demand could be better, but for now we fetch.
            // Actually, fetching groups 2x for 2 selectors is wasteful. 
            // Ideally we lift state up, but for speed we just keep it local.
            fetchGroups();
            fetchCurrentSelection();
        }
    }, [user, instanceName]);

    const fetchCurrentSelection = async () => {
        if (channel) {
            const { data } = await supabase.rpc('get_notice_channels');
            const row = Array.isArray(data) ? data.find((c: any) => c?.channel === channel) : null;
            if (row?.group_jid) {
                setSelectedGroup(row.group_jid);
                setFallbackNote('');
            } else {
                setSelectedGroup('');
                setFallbackNote(FALLBACK_NOTE[String(row?.fallback || 'gestao')] || FALLBACK_NOTE.gestao);
            }
            return;
        }
        const { data } = await supabase
            .from('profiles')
            .select(dbColumn)
            .eq('id', user.id)
            .single();

        if (data && data[dbColumn]) {
            setSelectedGroup(data[dbColumn]);
        }
    };

    const fetchGroups = async () => {
        setLoading(true);
        try {
            const result = await whatsappService.fetchGroups(undefined, instanceName);
            if (!result.success) throw new Error(result.error || 'Falha ao carregar grupos.');

            const validGroups = result.groups
                .filter(g => g && g.id && g.subject)
                .sort((a, b) => a.subject.localeCompare(b.subject));

            setGroups(validGroups);

        } catch (error) {
            console.error("Error fetching groups:", error);
            setFeedback("Erro ao carregar grupos.");
        } finally {
            setLoading(false);
        }
    };

    const handleSave = async () => {
        if (!selectedGroup && !channel) return;
        setSaving(true);
        try {
            if (channel) {
                const { error } = await supabase.rpc('save_notice_channel', { p_channel: channel, p_group_jid: selectedGroup || null });
                if (error) throw error;
                setFallbackNote(selectedGroup ? '' : (channel === 'financeiro' ? FALLBACK_NOTE.direcao : FALLBACK_NOTE.gestao));
                setFeedback("✅ Canal salvo!");
                setTimeout(() => setFeedback(''), 3000);
                return;
            }
            const updateObj = { [dbColumn]: selectedGroup }; // Dynamic key
            const { error } = await supabase
                .from('profiles')
                .update(updateObj)
                .eq('id', user.id);

            if (error) throw error;
            setFeedback("✅ Grupo salvo!");
            setTimeout(() => setFeedback(''), 3000);
        } catch (error: any) {
            setFeedback("❌ Erro: " + error.message);
        } finally {
            setSaving(false);
        }
    };

    if (!instanceName) return null;

    return (
        <div className="bg-brand-surface-2/50 rounded-xl p-6 border border-brand-border mt-6 relative">
            <h3 className="text-sm font-black text-brand-text dark:text-slate-200 uppercase tracking-widest mb-2 flex items-center gap-2">
                <Users size={16} /> {label}
            </h3>

            <p className="text-xs text-brand-muted mb-4 h-4">
                {description}
            </p>

            <div className="flex gap-2">
                <div className="relative flex-1">
                    <select
                        value={selectedGroup}
                        onChange={(e) => setSelectedGroup(e.target.value)}
                        disabled={loading}
                        className="w-full bg-brand-surface border border-brand-border dark:border-slate-600 rounded-lg px-4 py-3 text-sm font-medium appearance-none focus:ring-2 focus:ring-indigo-500/20 outline-none truncate pr-8"
                    >
                        <option value="">{loading ? "Carregando..." : channel === 'financeiro' ? "Usar o grupo da Direção" : channel ? "Usar o grupo da Gestão" : "Selecione..."}</option>
                        {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.subject.substring(0, 30)}
                            </option>
                        ))}
                    </select>
                </div>

                <button
                    onClick={handleSave}
                    disabled={saving || (!selectedGroup && !channel)}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 rounded-lg font-bold text-xs transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                    {saving ? <Loader size={14} className="animate-spin" /> : <Save size={14} />}
                    Salvar
                </button>
            </div>

            {fallbackNote && (
                <p className="mt-2 text-[10px] font-bold text-amber-600 dark:text-amber-400">{fallbackNote}</p>
            )}

            {feedback && (
                <div className="mt-2 text-[10px] font-bold flex items-center gap-1.5 animate-in fade-in absolute bottom-2 right-6">
                    <span className={feedback.includes('Erro') ? "text-red-500" : "text-emerald-500"}>
                        {feedback}
                    </span>
                </div>
            )}
        </div>
    );
};

export default GroupSelector;
