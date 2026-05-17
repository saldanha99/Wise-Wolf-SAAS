
import React, { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Users, Save, Loader, AlertCircle } from 'lucide-react';

interface GroupSelectorProps {
    user: any;
    instanceName: string;
    label?: string;
    description?: string;
    dbColumn?: string;
}

const EVOLUTION_API_URL = "https://api.2b.app.br";
const GLOBAL_API_KEY = "d037768b3d06382756a0d9edecf3e40e";

const GroupSelector: React.FC<GroupSelectorProps> = ({
    user,
    instanceName,
    label = "Grupo de Destino",
    description = "Selecione o grupo de WhatsApp onde as vagas serão publicadas.",
    dbColumn = "teachers_group_id"
}) => {
    const [groups, setGroups] = useState<any[]>([]);
    const [selectedGroup, setSelectedGroup] = useState('');
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
            const response = await fetch(`${EVOLUTION_API_URL}/group/fetchAllGroups/${instanceName}?getParticipants=false`, {
                method: 'GET',
                headers: {
                    'apikey': GLOBAL_API_KEY,
                    'Content-Type': 'application/json'
                }
            });

            const data = await response.json();
            // ... parsing logic same as before ...
            let groupsList: any[] = [];
            if (Array.isArray(data)) {
                groupsList = data;
            } else if (data && Array.isArray(data.groups)) {
                groupsList = data.groups;
            } else if (data && Array.isArray(data.data)) {
                groupsList = data.data;
            } else if (data && typeof data === 'object') {
                groupsList = Object.values(data).filter((item: any) => item && item.id && item.subject);
            }

            const validGroups = groupsList
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
        if (!selectedGroup) return;
        setSaving(true);
        try {
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
                        <option value="">{loading ? "Carregando..." : "Selecione..."}</option>
                        {groups.map((g) => (
                            <option key={g.id} value={g.id}>
                                {g.subject.substring(0, 30)}
                            </option>
                        ))}
                    </select>
                </div>

                <button
                    onClick={handleSave}
                    disabled={saving || !selectedGroup}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white px-4 rounded-lg font-bold text-xs transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                    {saving ? <Loader size={14} className="animate-spin" /> : <Save size={14} />}
                    Salvar
                </button>
            </div>

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
