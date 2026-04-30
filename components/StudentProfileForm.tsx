import React, { useState, useEffect } from 'react';
import { X, Save, BookOpen, MessageCircle, Briefcase, Phone, User, Check, Plus, Trash2, Calendar, FileText, CreditCard, DollarSign, Clock, Download } from 'lucide-react';
import { asaasService } from '../services/asaasService';
import StudentScheduleManager from './StudentScheduleManager';
import { ContractDocument } from './ContractDocument';
import { useReactToPrint } from 'react-to-print';
import { useRef } from 'react';

interface StudentProfileFormProps {
    initialData?: any;
    onSubmit: (data: any) => void;
    onCancel: () => void;
    onDelete?: () => void;
    title?: string;
    teachers?: any[];
    currentUserRole?: string; // RBAC
}

const StudentProfileForm: React.FC<StudentProfileFormProps> = ({ initialData, onSubmit, onCancel, onDelete, title = 'Aluno', teachers = [], currentUserRole }) => {
    // RBAC Logic: Director (School Admin) or Super Admin has full access
    const isDirector = currentUserRole === 'SCHOOL_ADMIN' || currentUserRole === 'SUPER_ADMIN';

    // If teacher, can't see Financial Tab. Default to Details.
    const [activeTab, setActiveTab] = useState<'DETAILS' | 'FINANCIAL' | 'AGENDA'>('DETAILS');
    const [loadingSubscription, setLoadingSubscription] = useState(false);

    const [formData, setFormData] = useState({
        name: '',
        email: '', // Added email
        cpf: '',
        levelBadge: 'B1',
        currentModuleStatus: '',
        interests: [] as string[],
        correctionPreference: 'TODOS',
        occupation: '',
        phone: '',
        meeting_link: '',
        img: 'https://i.pravatar.cc/150?u=new',
        fixed_schedule: '',
        private_notes: '',
        postalCode: '',
        address: '',
        addressNumber: '',
        professor_id: '',
        // Financial
        monthly_fee: 0,
        due_day: 10,
        subscription_id: '',
        status_financial: '',
        billingType: 'PIX',
        planDuration: 'RECURRENT'
    });

    const [newInterest, setNewInterest] = useState('');

    useEffect(() => {
        if (initialData) {
            setFormData({
                name: initialData.name || '',
                email: initialData.email || '',
                cpf: initialData.cpf || '',
                levelBadge: initialData.levelBadge || 'B1',
                currentModuleStatus: initialData.currentModuleStatus || '',
                interests: initialData.interests || [],
                correctionPreference: initialData.correctionPreference || 'TODOS',
                occupation: initialData.occupation || '',
                phone: initialData.phone || '',
                meeting_link: initialData.meeting_link || '',
                img: initialData.img || 'https://i.pravatar.cc/150?u=new',
                fixed_schedule: initialData.fixed_schedule || '',
                private_notes: initialData.private_notes || '',
                postalCode: initialData.postalCode || '',
                address: initialData.address || '',
                addressNumber: initialData.addressNumber || '',
                professor_id: initialData.professor_id || '',
                monthly_fee: initialData.monthly_fee || 0,
                due_day: initialData.due_day || 10,
                subscription_id: initialData.subscription_id || '',
                status_financial: initialData.status_financial || '',
                billingType: 'PIX',
                planDuration: initialData.planDuration || 'RECURRENT'
            });
        }
    }, [initialData]);

    const handleAddInterest = () => {
        if (newInterest.trim()) {
            setFormData(prev => ({
                ...prev,
                interests: [...prev.interests, newInterest.trim().toUpperCase()]
            }));
            setNewInterest('');
        }
    };

    const removeInterest = (index: number) => {
        setFormData(prev => ({
            ...prev,
            interests: prev.interests.filter((_, i) => i !== index)
        }));
    };

    const [generatingBooklet, setGeneratingBooklet] = useState(false);

    const handleCreateSubscription = async () => {
        if (!initialData?.id) return alert('Salve o aluno antes de criar assinatura.');
        if (!formData.monthly_fee || formData.monthly_fee <= 0) return alert('Informe um valor de mensalidade válido.');

        setLoadingSubscription(true);
        try {
            await asaasService.createSubscription({
                user_id: initialData.id,
                value: Number(formData.monthly_fee),
                dueDay: Number(formData.due_day),
                billingType: formData.billingType as any,
                planDuration: formData.planDuration as any
            });
            alert('Assinatura criada com SUCESSO! O aluno receberá a cobrança no dia de vencimento.');
            setFormData(prev => ({ ...prev, subscription_id: 'PENDING_REFRESH', status_financial: 'ACTIVE' }));
        } catch (error: any) {
            alert('Erro ao criar assinatura: ' + error.message);
        } finally {
            setLoadingSubscription(false);
        }
    };

    const handleGenerateManualPayments = async () => {
        if (!initialData?.id) return alert('Salve o aluno antes de gerar o carnê.');
        if (!formData.monthly_fee || formData.monthly_fee <= 0) return alert('Informe um valor de mensalidade válido.');

        if (!confirm(`Confirma a geração de 12 mensalidades de R$ ${formData.monthly_fee} para este aluno? Isso irá popular o "A Receber" do financeiro.`)) return;

        setGeneratingBooklet(true);
        try {
            const payments = [];
            const today = new Date();
            let currentYear = today.getFullYear();
            let currentMonth = today.getMonth(); // 0-11
            const dueDay = Number(formData.due_day);

            // If due day has passed or is today this month, start next month
            if (today.getDate() >= dueDay) {
                currentMonth++;
            }

            for (let i = 0; i < 12; i++) {
                // Handle year rollover
                const date = new Date(currentYear, currentMonth + i, dueDay);

                // Adjust if date is invalid (e.g. Feb 30 -> Mar 2) - simple JS Date handles rollover, 
                // but let's ensure we stick to the requested day as best as possible or last day of month
                // Actually JS Date(2025, 1, 30) -> Mar 2. 
                // Let's strict set date.
                const targetDate = new Date(currentYear, currentMonth + i, dueDay);

                payments.push({
                    student_id: initialData.id,
                    tenant_id: initialData.tenant_id, // Critical for RLS
                    value: Number(formData.monthly_fee),
                    status: 'PENDING',
                    due_date: targetDate.toISOString().split('T')[0],
                    billing_type: formData.billingType || 'MANUAL',
                    // payment_method: 'MANUAL', // Optional if schema supports
                });
            }

            // Insert into student_payments
            // Using standard Insert. RLS should allow if user is Admin.
            // Check if backend allows.
            import('../lib/supabase').then(async ({ supabase }) => {
                const { error } = await supabase.from('student_payments').insert(payments);
                if (error) throw error;

                alert('Carnê gerado com sucesso! 12 parcelas adicionadas ao fluxo "A Receber".');
            });

        } catch (error: any) {
            console.error(error);
            alert('Erro ao gerar carnê: ' + error.message);
        } finally {
            setGeneratingBooklet(false);
        }
    };

    const [generatingEnrollmentFee, setGeneratingEnrollmentFee] = useState(false);

    const handleCreateEnrollmentFee = async () => {
        if (!formData.cpf) return alert("CPF é obrigatório para gerar o Pix da matrícula.");
        setGeneratingEnrollmentFee(true);
        try {
            const customerData = {
                name: formData.name,
                email: formData.email || 'sem_email@wisewolf.com.br',
                cpfCnpj: formData.cpf.replace(/\D/g, ''),
                phone: formData.phone
            };
            const pixData = await asaasService.createEnrollmentPix(49, customerData);

            if (pixData?.invoiceUrl) {
                // Atualiza o banco de dados marcando que o boleto foi gerado
                if (initialData?.id) {
                    await import('../lib/supabase').then(async ({ supabase }) => {
                        await supabase.from('profiles').update({ enrollment_payment_id: pixData.id }).eq('id', initialData.id);
                    });
                }
                
                alert('PIX de Matrícula gerado com sucesso!\n\nVocê será redirecionado para o link do Asaas para copiar e mandar para o aluno.');
                window.open(pixData.invoiceUrl, '_blank');
            } else {
                alert('PIX gerado, mas link não retornado. Verifique o painel do Asaas.');
            }
        } catch (error: any) {
            alert('Erro ao gerar PIX da matrícula: ' + error.message);
        } finally {
            setGeneratingEnrollmentFee(false);
        }
    };

    // --- CONTRATO SIMULADO ---
    const contractRef = useRef<HTMLDivElement>(null);
    const handlePrintContract = useReactToPrint({
        contentRef: contractRef,
        documentTitle: `Contrato_WiseWolf_${formData.name ? formData.name.replace(/\s+/g, '_') : 'Aluno'}`,
    });

    const getContractDates = () => {
        const start = new Date();
        const duration = formData.planDuration === 'ANNUAL' ? 12 : formData.planDuration === 'SEMESTER' ? 6 : 1;
        const end = new Date(start);
        end.setMonth(end.getMonth() + duration);
        return {
            startDate: start.toISOString().split('T')[0],
            endDate: end.toISOString().split('T')[0]
        };
    };

    const handleSimulateContract = () => {
        if (!formData.cpf) return alert("Preencha o CPF na aba Financeiro.");
        if (!formData.address) return alert("Preencha o Endereço na aba Financeiro.");
        
        // Simula a aceitação atualizando o banco, opcionalmente
        if (initialData?.id) {
            import('../lib/supabase').then(async ({ supabase }) => {
                await supabase.from('profiles').update({
                    contract_accepted: true,
                    accepted_at: new Date().toISOString(),
                    signature_ip: 'Assinado Manualmente (Direção)'
                }).eq('id', initialData.id);
            });
        }

        handlePrintContract();
    };

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2rem] shadow-2xl w-full max-w-2xl border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200">

            {/* Header */}
            <div className="px-8 py-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/20">
                <div>
                    <h3 className="text-xl font-black text-slate-800 dark:text-white uppercase tracking-tight">{initialData ? 'Editar Perfil' : 'Novo Aluno'}</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mt-1">Preencha os detalhes do aluno</p>
                </div>
                <div className="flex items-center gap-2">
                    {onDelete && (
                        <button
                            onClick={onDelete}
                            className="p-2 bg-red-50 hover:bg-red-100 dark:bg-red-900/20 dark:hover:bg-red-900/40 text-red-500 rounded-xl transition-colors mr-2"
                            title="Remover da Agenda"
                        >
                            <Trash2 size={20} />
                        </button>
                    )}
                    <button onClick={onCancel} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-400">
                        <X size={20} />
                    </button>
                </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-slate-100 dark:border-slate-800">
                <button
                    onClick={() => setActiveTab('DETAILS')}
                    className={`flex-1 py-4 text-xs font-black uppercase tracking-widest transition-colors ${activeTab === 'DETAILS' ? 'text-tenant-primary border-b-2 border-tenant-primary bg-slate-50 dark:bg-slate-800/50' : 'text-slate-400 hover:text-slate-600'}`}
                >
                    Detalhes
                </button>
                {/* RBAC: Only Directors see Financial Tab */}
                {isDirector && (
                    <>
                        <button
                            onClick={() => setActiveTab('FINANCIAL')}
                            className={`flex-1 py-4 text-xs font-black uppercase tracking-widest transition-colors ${activeTab === 'FINANCIAL' ? 'text-tenant-primary border-b-2 border-tenant-primary bg-slate-50 dark:bg-slate-800/50' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            Financeiro
                        </button>
                        <button
                            onClick={() => setActiveTab('AGENDA')}
                            className={`flex-1 py-4 text-xs font-black uppercase tracking-widest transition-colors ${activeTab === 'AGENDA' ? 'text-tenant-primary border-b-2 border-tenant-primary bg-slate-50 dark:bg-slate-800/50' : 'text-slate-400 hover:text-slate-600'}`}
                        >
                            Agenda & Aulas
                        </button>
                    </>
                )}
            </div>

            <div className="p-8 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">

                {activeTab === 'DETAILS' && (
                    <div className="space-y-6">
                        {/* Basic Info */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <User size={12} /> Nome Completo
                                </label>
                                <input
                                    disabled={!isDirector}
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className={`w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none ${!isDirector ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    placeholder="Ex: Ana Silva"
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    Email (Opcional p/ Exp.)
                                </label>
                                <input
                                    disabled={!isDirector || !!initialData?.id} // Only editable on creation logic ideally, or let them edit but warn it doesn't change auth? Let's disable if ID exists.
                                    value={formData.email}
                                    onChange={e => setFormData({ ...formData, email: e.target.value })}
                                    className={`w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none ${(!isDirector || !!initialData?.id) ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    placeholder="Deixe vazio se for experimental"
                                />
                            </div>

                            {/* Professor Selector */}
                            <div className="space-y-2 relative">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Briefcase size={12} /> Professor Responsável
                                </label>
                                <select
                                    disabled={!isDirector}
                                    value={formData.professor_id || ''}
                                    onChange={e => setFormData({ ...formData, professor_id: e.target.value })}
                                    className={`w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none appearance-none ${!isDirector ? 'opacity-60 cursor-not-allowed' : ''}`}
                                >
                                    <option value="">-- Sem Professor --</option>
                                    {teachers?.map(t => (
                                        <option key={t.id} value={t.id}>{t.name}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    Nível (Badge)
                                </label>
                                <select
                                    disabled={!isDirector}
                                    value={formData.levelBadge}
                                    onChange={e => {
                                        const newBadge = e.target.value;
                                        let newStatus = formData.currentModuleStatus;
                                        const badges = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
                                        const parts = newStatus.split(' ');
                                        if (parts.length > 0 && badges.includes(parts[0])) {
                                            parts[0] = newBadge;
                                            newStatus = parts.join(' ');
                                        } else {
                                            newStatus = newBadge + (newStatus ? ' ' + newStatus : '');
                                        }
                                        setFormData({ ...formData, levelBadge: newBadge, currentModuleStatus: newStatus });
                                    }}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none appearance-none"
                                >
                                    <option>A1</option>
                                    <option>A2</option>
                                    <option>B1</option>
                                    <option>B2</option>
                                    <option>C1</option>
                                    <option>C2</option>
                                </select>
                            </div>
                        </div>

                        {/* Billing Info - DIRECTORS ONLY */}
                        {isDirector && (
                            <>
                                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                            CPF (Obrigatório para Asaas)
                                        </label>
                                        <input
                                            value={formData.cpf}
                                            onChange={e => setFormData({ ...formData, cpf: e.target.value })}
                                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                            placeholder="000.000.000-00"
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                            CEP
                                        </label>
                                        <input
                                            value={formData.postalCode}
                                            onChange={e => setFormData({ ...formData, postalCode: e.target.value })}
                                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                            placeholder="00000-000"
                                        />
                                    </div>
                                </div>

                                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                                    <div className="md:col-span-2 space-y-2">
                                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                            Endereço
                                        </label>
                                        <input
                                            value={formData.address}
                                            onChange={e => setFormData({ ...formData, address: e.target.value })}
                                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                            placeholder="Rua, Av..."
                                        />
                                    </div>
                                    <div className="space-y-2">
                                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                            Número
                                        </label>
                                        <input
                                            value={formData.addressNumber}
                                            onChange={e => setFormData({ ...formData, addressNumber: e.target.value })}
                                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                            placeholder="123"
                                        />
                                    </div>
                                </div>
                            </>
                        )}

                        {/* Current Module */}
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                <BookOpen size={12} /> Módulo Atual
                            </label>
                            <input
                                disabled={!isDirector}
                                value={formData.currentModuleStatus}
                                onChange={e => {
                                    const val = e.target.value.toUpperCase();
                                    const parts = val.split(' ');
                                    let newBadge = formData.levelBadge;
                                    if (parts.length > 0 && ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'].includes(parts[0])) {
                                        newBadge = parts[0];
                                    }
                                    setFormData({ ...formData, currentModuleStatus: val, levelBadge: newBadge });
                                }}
                                className="w-full px-4 py-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-xl text-xs font-black text-blue-700 dark:text-blue-300 focus:ring-2 focus:ring-blue-500 outline-none uppercase tracking-wide"
                                placeholder="Ex: B1 - PARTE 2 - AULA 26 ATÉ 50"
                            />
                        </div>

                        {/* Interests */}
                        <div className="space-y-3">
                            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                Interesses
                            </label>
                            <div className="flex flex-wrap gap-2 mb-2">
                                {formData.interests.map((interest, idx) => (
                                    <span key={idx} className="px-3 py-1 bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400 rounded-lg text-[10px] font-black uppercase tracking-wide flex items-center gap-2">
                                        {interest}
                                        <button onClick={() => removeInterest(idx)} className="hover:text-orange-800 dark:hover:text-orange-200"><X size={10} /></button>
                                    </span>
                                ))}
                            </div>
                            <div className="flex gap-2">
                                <input
                                    disabled={!isDirector}
                                    value={newInterest}
                                    onChange={e => setNewInterest(e.target.value)}
                                    onKeyDown={e => e.key === 'Enter' && handleAddInterest()}
                                    className="flex-1 px-4 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold focus:ring-2 focus:ring-orange-500 outline-none uppercase"
                                    placeholder="Adicionar interesse..."
                                />
                                <button
                                    onClick={handleAddInterest}
                                    className="px-4 py-2 bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-300 rounded-xl hover:bg-orange-100 hover:text-orange-600 transition-colors"
                                >
                                    <Plus size={16} />
                                </button>
                            </div>
                        </div>

                        {/* Correction & Occupation */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <MessageCircle size={12} /> Preferência de Correção
                                </label>
                                <select
                                    disabled={!isDirector}
                                    value={formData.correctionPreference}
                                    onChange={e => setFormData({ ...formData, correctionPreference: e.target.value })}
                                    className="w-full px-4 py-3 bg-emerald-50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30 rounded-xl text-xs font-black text-emerald-700 dark:text-emerald-400 focus:ring-2 focus:ring-emerald-500 outline-none uppercase"
                                >
                                    <option>TODOS</option>
                                    <option>AO FINAL</option>
                                    <option>SEMPRE</option>
                                    <option>NUNCA</option>
                                </select>
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Briefcase size={12} /> Ocupação
                                </label>
                                <input
                                    disabled={!isDirector}
                                    value={formData.occupation}
                                    onChange={e => setFormData({ ...formData, occupation: e.target.value.toUpperCase() })}
                                    className="w-full px-4 py-3 bg-white dark:bg-slate-900 border border-pink-200 dark:border-pink-900 rounded-xl text-xs font-black text-pink-500 dark:text-pink-400 focus:ring-2 focus:ring-pink-500 outline-none uppercase"
                                    placeholder="Ex: ARQUITETA"
                                />
                            </div>
                        </div>

                        {/* Phone & Meet Link */}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Phone size={12} /> Telefone (WhatsApp)
                                </label>
                                <input
                                    disabled={!isDirector}
                                    value={formData.phone}
                                    onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                    className={`w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none font-mono ${!isDirector ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    placeholder="5511999999999"
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Plus size={12} /> Link da Aula (Meet)
                                </label>
                                <input
                                    disabled={!isDirector}
                                    value={formData.meeting_link}
                                    onChange={e => setFormData({ ...formData, meeting_link: e.target.value })}
                                    className="w-full px-4 py-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-xl text-xs font-bold text-blue-700 dark:text-blue-300 focus:ring-2 focus:ring-blue-500 outline-none"
                                    placeholder="https://meet.google.com/abc-defg-hij"
                                />
                            </div>
                        </div>

                        {/* Fixed Schedule & Private Notes */}
                        <div className="space-y-6 pt-4 border-t border-slate-100 dark:border-slate-800">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Calendar size={12} /> Horário Fixo (Texto Livre)
                                </label>
                                <input
                                    disabled={!isDirector}
                                    value={formData.fixed_schedule}
                                    onChange={e => setFormData({ ...formData, fixed_schedule: e.target.value })}
                                    className={`w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none ${!isDirector ? 'opacity-60 cursor-not-allowed' : ''}`}
                                    placeholder="Ex: Seg e Qua às 14h"
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <FileText size={12} /> Anotações Pedagógicas (Privado)
                                </label>
                                <textarea
                                    value={formData.private_notes}
                                    onChange={e => setFormData({ ...formData, private_notes: e.target.value })}
                                    className="w-full h-32 px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-medium text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none resize-none"
                                    placeholder="Observações sobre o aprendizado, dificuldades ou metas do aluno (visível apenas para professores)..."
                                />
                            </div>
                        </div>
                    </div>
                )}

                {activeTab === 'FINANCIAL' && (
                    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        {formData.subscription_id ? (
                            <div className="p-6 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-800 rounded-2xl flex items-center gap-4">
                                <div className="w-12 h-12 rounded-full bg-emerald-100 dark:bg-emerald-800 flex items-center justify-center text-emerald-600 dark:text-emerald-400">
                                    <Check size={24} />
                                </div>
                                <div>
                                    <h4 className="font-black text-emerald-800 dark:text-emerald-200 text-lg">Assinatura Ativa</h4>
                                    <p className="text-sm text-emerald-600 dark:text-emerald-400 font-bold">Cobrança automática configurada no Asaas.</p>
                                    <p className="text-xs text-emerald-500/80 mt-1 uppercase tracking-widest">ID: {formData.subscription_id}</p>
                                </div>
                            </div>
                        ) : (
                            <div className="p-6 bg-slate-50 dark:bg-slate-800 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700 text-center">
                                <p className="text-slate-500 text-sm font-bold">Nenhuma assinatura ativa encontrada.</p>
                            </div>
                        )}

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <DollarSign size={12} /> Valor Mensal (R$)
                                </label>
                                <input
                                    type="number"
                                    value={formData.monthly_fee}
                                    onChange={e => setFormData({ ...formData, monthly_fee: Number(e.target.value) })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xl font-black text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                    placeholder="0.00"
                                />
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Calendar size={12} /> Dia de Vencimento
                                </label>
                                <select
                                    value={formData.due_day}
                                    onChange={e => setFormData({ ...formData, due_day: Number(e.target.value) })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none appearance-none"
                                >
                                    {[5, 10, 15, 20, 25].map(day => (
                                        <option key={day} value={day}>Dia {day}</option>
                                    ))}
                                </select>
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Clock size={12} /> Duração do Contrato
                                </label>
                                <select
                                    value={formData.planDuration}
                                    onChange={e => setFormData({ ...formData, planDuration: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none appearance-none"
                                >
                                    <option value="RECURRENT">Mensal (Sem Fidelidade)</option>
                                    <option value="SEMESTER">Semestral (6 Meses)</option>
                                    <option value="ANNUAL">Anual (12 Meses)</option>
                                </select>
                            </div>

                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <CreditCard size={12} /> Forma de Pagamento
                                </label>
                                <select
                                    value={formData.billingType}
                                    onChange={e => setFormData({ ...formData, billingType: e.target.value })}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none appearance-none"
                                >
                                    <option value="PIX">PIX</option>
                                    <option value="BOLETO">BOLETO</option>
                                </select>
                            </div>
                        </div>

                        <div className="pt-6 border-t border-slate-100 dark:border-slate-800 space-y-4">
                            <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest">Opções de Cobrança</h4>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                <button
                                    onClick={handleCreateSubscription}
                                    disabled={loadingSubscription || !!formData.subscription_id}
                                    className="w-full py-4 bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all shadow-lg shadow-emerald-500/20 flex flex-col items-center justify-center gap-1"
                                >
                                    <span className="flex items-center gap-2"><CreditCard size={14} /> {formData.subscription_id ? 'Assinatura Automática Ativa' : 'Criar Assinatura (Asaas)'}</span>
                                    {!formData.subscription_id && <span className="opacity-75 text-[9px]">Gera cobranças e envia boleto/pix automático</span>}
                                </button>

                                <button
                                    onClick={handleGenerateManualPayments}
                                    disabled={generatingBooklet}
                                    className="w-full py-4 bg-slate-800 hover:bg-slate-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all shadow-lg shadow-slate-800/20 flex flex-col items-center justify-center gap-1 border border-slate-700"
                                >
                                    <span className="flex items-center gap-2"><FileText size={14} /> Gerar Carnê Interno (12x)</span>
                                    <span className="opacity-75 text-[9px] text-center">Apenas lança no sistema (Para alunos manuais)</span>
                                </button>
                                
                                <button
                                    onClick={handleCreateEnrollmentFee}
                                    disabled={generatingEnrollmentFee || !formData.cpf}
                                    className="w-full py-4 bg-purple-600 hover:bg-purple-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl font-black text-[10px] uppercase tracking-widest transition-all shadow-lg shadow-purple-600/20 flex flex-col items-center justify-center gap-1 col-span-1 md:col-span-2 mt-2"
                                >
                                    <span className="flex items-center gap-2"><DollarSign size={14} /> Gerar PIX/Boleto da Matrícula (R$ 49)</span>
                                    <span className="opacity-75 text-[9px] text-center">Abre o link avulso na hora para enviar ao aluno</span>
                                </button>
                                
                                <button
                                    onClick={handleSimulateContract}
                                    className="w-full py-4 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-xl font-black text-[10px] uppercase tracking-widest transition-all flex flex-col items-center justify-center gap-1 col-span-1 md:col-span-2 border border-slate-200 dark:border-slate-700 mt-2"
                                >
                                    <span className="flex items-center gap-2"><Download size={14} /> Gerar Contrato em PDF (Assinado)</span>
                                    <span className="opacity-75 text-[9px] text-center">Simula assinatura do aluno e baixa o PDF oficial</span>
                                </button>
                            </div>

                            {formData.planDuration !== 'RECURRENT' && (
                                <div className="p-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800 rounded-xl text-center">
                                    <p className="text-xs font-bold text-blue-800 dark:text-blue-300">
                                        Resumo: O contrato prevê {formData.planDuration === 'SEMESTER' ? '6' : '12'} parcelas de R$ {formData.monthly_fee || '...'}
                                    </p>
                                </div>
                            )}
                        </div>
                    </div>
                )}

                {activeTab === 'AGENDA' && isDirector && initialData?.id && (
                    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
                        <div className="p-4 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-800 rounded-2xl flex items-center gap-4">
                            <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-800 flex items-center justify-center text-blue-600 dark:text-blue-400">
                                <Calendar size={20} />
                            </div>
                            <div>
                                <h4 className="font-black text-blue-800 dark:text-blue-200 text-sm">Gerenciamento de Agenda</h4>
                                <p className="text-xs text-blue-600 dark:text-blue-400 font-bold">Adicione dias, troque horários ou transfira de professor.</p>
                            </div>
                        </div>

                        <StudentScheduleManager
                            studentId={initialData.id}
                            tenantId={initialData.tenant_id} // Assuming initialData has tenant_id, usually filtering by it anyway
                            teachers={teachers}
                            onUpdate={() => {
                                // Optional: Refresh parent or local state if needed
                            }}
                        />
                    </div>
                )}

            </div>

            {/* Footer */}
            <div className="p-6 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900 flex justify-between gap-3 custom-shadow-top items-center">
                {/* Empty div to spacing if update layout, or just justify-end in original */}
                <div className="flex-1"></div>
                <div className="flex gap-3">
                    <button
                        onClick={onCancel}
                        className="px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                    >
                        Cancelar
                    </button>
                    <button
                        onClick={() => onSubmit(formData)}
                        className="px-8 py-3 bg-tenant-primary text-white rounded-xl font-black text-xs uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-lg shadow-tenant-primary/20 flex items-center gap-2"
                    >
                        <Save size={16} /> Salvar Perfil
                    </button>
                </div>
            </div>

            {/* Hidden Contract Form for PDF Printing */}
            <div className="hidden">
                <div ref={contractRef}>
                    <ContractDocument
                        studentName={formData.name.toUpperCase()}
                        studentCPF={formData.cpf.replace(/\D/g, '')}
                        studentAddress={`${formData.address}, ${formData.addressNumber} - CEP: ${formData.postalCode}`}
                        studentEmail={formData.email}
                        studentPhone={formData.phone}
                        planName={`Plano ${formData.planDuration === 'ANNUAL' ? 'Anual' : formData.planDuration === 'SEMESTER' ? 'Semestral' : 'Mensal'}`}
                        planValue={Number(formData.monthly_fee).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        totalValue={(Number(formData.monthly_fee) * (formData.planDuration === 'ANNUAL' ? 12 : formData.planDuration === 'SEMESTER' ? 6 : 1)).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                        planDuration={formData.planDuration === 'ANNUAL' ? 12 : formData.planDuration === 'SEMESTER' ? 6 : 1}
                        startDate={getContractDates().startDate}
                        endDate={getContractDates().endDate}
                        dueDay={formData.due_day}
                        classFrequency={2} // Média simulada ou buscar dos agendamentos
                        acceptedAt={new Date().toISOString()}
                        userIp="Assinado Manualmente (Sistema Interno Wise Wolf)"
                        subscriptionId={formData.subscription_id || "Aguardando Vínculo Financeiro"}
                    />
                </div>
            </div>

        </div >
    );
};

export default StudentProfileForm;
