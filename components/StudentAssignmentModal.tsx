
import React, { useState, useEffect } from 'react';
import { X, Calendar, Clock, User, Check, AlertCircle, Plus, Phone, Briefcase, Mail, Tag, DollarSign, FileText } from 'lucide-react';
import { supabase } from '../lib/supabase';

const DAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const TIMES = Array.from({ length: 37 }, (_, i) => {
    const hour = Math.floor(i / 2) + 6;
    const minutes = (i % 2 === 0) ? '00' : '30';
    if (hour === 24) return '00:00';
    return `${hour < 10 ? '0' + hour : hour}:${minutes}`;
});


interface Student {
    id: string;
    full_name: string;
    module?: string;
    monthly_tuition?: number;
    fidelity_plan?: string;
}

interface StudentAssignmentModalProps {
    students: Student[];
    availableSlots: Set<string>;
    onAssign: (data: {
        studentId?: string;
        isNew: boolean;
        studentData?: any;
        schedule: { day: string, time: string }[];
        module: string;
        startDate?: string;
        contractFile?: File;
        financial?: {
            price: number;
            planName: string;
            duration: number; // months
        }
    }) => void;
    onClose: () => void;
    isLoading?: boolean;
}

const StudentAssignmentModal: React.FC<StudentAssignmentModalProps> = ({ students, availableSlots, onAssign, onClose, isLoading }) => {
    const [isNewStudent, setIsNewStudent] = useState(false);
    const [selectedStudentId, setSelectedStudentId] = useState('');

    // Flexible Schedule State: Map of Day -> Time
    const [schedule, setSchedule] = useState<Record<string, string>>({});

    const [module, setModule] = useState('B1');
    const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
    const [validationError, setValidationError] = useState<string | null>(null);

    // Pricing State
    const [pricingPlans, setPricingPlans] = useState<any[]>([]);
    const [fidelityMonths, setFidelityMonths] = useState<number>(6); // Default 6 months
    const [calculatedPrice, setCalculatedPrice] = useState<number>(0);
    const [selectedPlanName, setSelectedPlanName] = useState<string>('');

    // Financial Update Toggle (For Existing Students)
    const [updateFinancials, setUpdateFinancials] = useState(true);
    const [existingTuition, setExistingTuition] = useState<number | null>(null);

    // Manual Price State
    const [isManualPrice, setIsManualPrice] = useState(false);
    const [manualPriceValue, setManualPriceValue] = useState<number>(0);

    // New Student Fields
    const [newName, setNewName] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [newPhone, setNewPhone] = useState('');
    const [newOccupation, setNewOccupation] = useState('');
    const [newInterests, setNewInterests] = useState('');
    // Asaas Fields
    const [newCpf, setNewCpf] = useState('');
    const [newAddress, setNewAddress] = useState('');
    const [newAddressNumber, setNewAddressNumber] = useState('');
    const [newPostalCode, setNewPostalCode] = useState('');
    const [contractFile, setContractFile] = useState<File | null>(null);

    // Load Pricing Plans
    useEffect(() => {
        const fetchPlans = async () => {
            const { data } = await supabase.from('student_pricing_plans').select('*');
            if (data) setPricingPlans(data);
        };
        fetchPlans();
    }, []);

    // Handle Student Selection Check for Existing Financials
    useEffect(() => {
        if (!isNewStudent && selectedStudentId) {
            const std = students.find(s => s.id === selectedStudentId);
            if (std?.monthly_tuition && std.monthly_tuition > 0) {
                setExistingTuition(std.monthly_tuition);
                // Default to FALSE (do not overwrite) if existing tuition is present
                setUpdateFinancials(false);
            } else {
                setExistingTuition(null);
                setUpdateFinancials(true);
            }
        } else {
            setExistingTuition(null);
            setUpdateFinancials(true);
        }
    }, [selectedStudentId, isNewStudent, students]);


    // Recalculate Price when Schedule or Fidelity changes (ONLY if updateFinancials is true)
    useEffect(() => {
        if (!updateFinancials) return;
        if (isManualPrice) {
            setCalculatedPrice(manualPriceValue);
            setSelectedPlanName('Personalizado / Manual');
            return;
        }

        const classesPerWeek = Object.keys(schedule).length;
        if (classesPerWeek === 0) {
            setCalculatedPrice(0);
            return;
        }

        // Find Plan
        const plan = pricingPlans.find(p => p.classes_per_week === classesPerWeek && p.fidelity_months === fidelityMonths);

        if (plan) {
            setCalculatedPrice(plan.monthly_price);
            setSelectedPlanName(plan.name);
        } else {
            setCalculatedPrice(0);
            setSelectedPlanName('Personalizado / Não Encontrado');
        }
    }, [schedule, fidelityMonths, pricingPlans, updateFinancials, isManualPrice, manualPriceValue]);


    const toggleDay = (day: string) => {
        setValidationError(null);
        setSchedule(prev => {
            const newSched = { ...prev };
            if (newSched[day]) {
                delete newSched[day];
            } else {
                if (Object.keys(newSched).length >= 5) {
                    alert("Máximo de 5 dias por semana permitido.");
                    return prev;
                }
                newSched[day] = '08:00'; // Default Time
            }
            return newSched;
        });
    };

    const updateTimeForDay = (day: string, newTime: string) => {
        setValidationError(null);
        setSchedule(prev => ({
            ...prev,
            [day]: newTime
        }));
    };

    const handleAssign = () => {
        if (!isNewStudent && !selectedStudentId) return alert("Selecione um aluno.");
        if (isNewStudent && !newName) return alert("Informe o nome do novo aluno.");
        // Email is no longer required to prevent conflicts
        // if (isNewStudent && !newEmail) return alert("Informe o e-mail para o novo acesso.");

        const days = Object.keys(schedule);
        if (days.length === 0) return alert("Selecione ao menos um dia.");

        // Check availability
        const dayMap: Record<string, number> = {
            'Segunda': 0, 'Terça': 1, 'Quarta': 2, 'Quinta': 3, 'Sexta': 4, 'Sábado': 5
        };

        const unavailableDays: string[] = [];

        days.forEach(day => {
            const time = schedule[day];
            const key = `${dayMap[day]}-${time}`;
            if (!availableSlots.has(key)) {
                unavailableDays.push(`${day} às ${time}`);
            }
        });

        if (unavailableDays.length > 0) {
            setValidationError(`O professor não possui disponibilidade em: ${unavailableDays.join(', ')}.`);
            return;
        }

        // Construct final schedule array
        const finalSchedule = days.map(day => ({
            day,
            time: schedule[day]
        }));

        onAssign({
            studentId: isNewStudent ? undefined : selectedStudentId,
            isNew: isNewStudent,
            studentData: isNewStudent ? {
                name: newName,
                email: newEmail.trim() || `experimental_${Date.now()}@temp.wisewolf.com`,
                phone: newPhone,
                occupation: newOccupation,
                interests: newInterests.split(',').map(i => i.trim()).filter(i => i !== ''),
                cpf: newCpf,
                address: newAddress,
                addressNumber: newAddressNumber,
                postalCode: newPostalCode
            } : undefined,
            schedule: finalSchedule,
            module,
            startDate,
            contractFile: contractFile || undefined,
            // Only send financial data if updateFinancials is TRUE
            financial: updateFinancials ? {
                price: calculatedPrice,
                planName: selectedPlanName,
                duration: fidelityMonths
            } : undefined
        });
    };

    return (
        <div className="bg-white dark:bg-slate-900 rounded-[2.5rem] shadow-2xl w-full max-w-lg border border-slate-100 dark:border-slate-800 overflow-hidden animate-in zoom-in-95 duration-200">
            <div className="px-8 py-6 border-b border-slate-100 dark:border-slate-800 flex justify-between items-center bg-slate-50/50 dark:bg-slate-800/20">
                <div>
                    <h3 className="text-xl font-black text-slate-800 dark:text-white uppercase tracking-tight">Atribuir Aluno</h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400 font-bold uppercase tracking-widest mt-1">Configure a agenda semanal</p>
                </div>
                <button onClick={onClose} className="p-2 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-full transition-colors text-slate-400">
                    <X size={20} />
                </button>
            </div>

            <div className="p-8 space-y-6 max-h-[70vh] overflow-y-auto custom-scrollbar">
                {validationError && (
                    <div className="p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/50 rounded-2xl flex items-start gap-3 animate-in fade-in slide-in-from-top-2">
                        <AlertCircle className="text-red-500 shrink-0" size={18} />
                        <p className="text-xs font-bold text-red-600 dark:text-red-400">{validationError}</p>
                    </div>
                )}

                {/* Mode Selector */}
                <div className="flex gap-2 p-1 bg-slate-100 dark:bg-slate-800 rounded-2xl">
                    <button
                        onClick={() => setIsNewStudent(false)}
                        className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${!isNewStudent ? 'bg-white dark:bg-slate-700 text-tenant-primary shadow-sm' : 'text-slate-400'}`}
                    >
                        Aluno Existente
                    </button>
                    <button
                        onClick={() => setIsNewStudent(true)}
                        className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${isNewStudent ? 'bg-white dark:bg-slate-700 text-tenant-primary shadow-sm' : 'text-slate-400'}`}
                    >
                        Novo Aluno
                    </button>
                </div>

                {!isNewStudent ? (
                    <div className="space-y-2 animate-in fade-in slide-in-from-right-4 duration-300">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                            <User size={12} /> Selecionar Aluno
                        </label>
                        <select
                            value={selectedStudentId}
                            onChange={(e) => {
                                const stdId = e.target.value;
                                setSelectedStudentId(stdId);
                                const std = students.find(s => s.id === stdId);
                                if (std?.module) setModule(std.module);
                            }}
                            className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                        >
                            <option value="">Escolha um aluno...</option>
                            {students.map(s => (
                                <option key={s.id} value={s.id}>{s.full_name}</option>
                            ))}
                        </select>
                    </div>
                ) : (
                    <div className="space-y-4 animate-in fade-in slide-in-from-left-4 duration-300">
                        {/* Compact New Student Name/Email */}
                        <div className="grid grid-cols-1 gap-4">
                            <div>
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Nome</label>
                                <input value={newName} onChange={e => setNewName(e.target.value)} className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold outline-none" placeholder="Nome Completo" />
                            </div>
                            <div>
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400">Email (Opcional p/ Exp.)</label>
                                <input value={newEmail} onChange={e => setNewEmail(e.target.value)} className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold outline-none" placeholder="Deixe vazio se for experimental" />
                            </div>
                        </div>

                        {/* Optional Asaas Fields */}
                        <details className="text-xs text-slate-400 cursor-pointer">
                            <summary className="font-bold hover:text-tenant-primary transition-colors">Mais Detalhes (CPF, Endereço...)</summary>
                            <div className="pt-3 space-y-3 pl-2 border-l-2 border-slate-100 dark:border-slate-800 mt-2">
                                <input value={newPhone} onChange={e => setNewPhone(e.target.value)} className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold outline-none" placeholder="Telefone" />
                                <input value={newCpf} onChange={e => setNewCpf(e.target.value)} className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold outline-none" placeholder="CPF" />
                                <input value={newAddress} onChange={e => setNewAddress(e.target.value)} className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-xs font-bold outline-none" placeholder="Endereço" />
                            </div>
                        </details>

                        {/* Contract Upload */}
                        <div className="pt-2 border-t border-dashed border-slate-200 dark:border-slate-800">
                            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5 mb-1">
                                <FileText size={10} /> Contrato (PDF)
                            </label>
                            <input type="file" accept="application/pdf" onChange={(e) => { if (e.target.files?.[0]) setContractFile(e.target.files[0]) }} className="block w-full text-xs text-slate-500 file:mr-4 file:py-1 file:px-3 file:rounded-full file:border-0 file:text-[10px] file:font-semibold file:bg-tenant-primary/10 file:text-tenant-primary hover:file:bg-tenant-primary/20" />
                        </div>
                    </div>
                )}

                {/* Level & Start Date Row */}
                <div className="grid grid-cols-2 gap-4">
                    <div>
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-1 block">Nível</label>
                        <input value={module} onChange={e => setModule(e.target.value.toUpperCase())} className="w-full px-3 py-2 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-xl text-xs font-black text-blue-700 dark:text-blue-300 outline-none uppercase text-center" />
                    </div>
                    <div>
                        <label className="text-[10px] font-black uppercase tracking-widest text-tenant-primary mb-1 block">Início</label>
                        <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} className="w-full px-3 py-2 bg-white dark:bg-slate-950 border border-tenant-primary/20 rounded-xl text-xs font-bold outline-none" />
                    </div>
                </div>

                {/* Schedule & Pricing Section */}
                <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-slate-200 dark:border-slate-700 space-y-4">
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-black uppercase tracking-widest text-slate-500 gap-2 flex items-center">
                            <Calendar size={12} /> Agenda Semanal Flexível
                        </label>
                        <span className="text-[9px] font-bold text-tenant-primary bg-tenant-primary/10 px-2 py-1 rounded-md">
                            {Object.keys(schedule).length} dias selecionados
                        </span>
                    </div>

                    {/* Day Selection */}
                    <div className="grid grid-cols-3 gap-2">
                        {DAYS.map(day => (
                            <button
                                key={day}
                                onClick={() => toggleDay(day)}
                                className={`py-2 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all border ${schedule[day]
                                    ? 'bg-tenant-primary border-tenant-primary text-white shadow-md'
                                    : 'bg-white dark:bg-slate-900 border-slate-100 dark:border-slate-700 text-slate-400 hover:border-tenant-primary/50'
                                    }`}
                            >
                                {day}
                            </button>
                        ))}
                    </div>

                    {/* Time Selection for Active Days */}
                    {Object.keys(schedule).length > 0 && (
                        <div className="space-y-2 animate-in fade-in slide-in-from-top-2">
                            <p className="text-[9px] font-bold text-slate-400 uppercase tracking-wider pl-1">Horários por dia:</p>
                            <div className="grid grid-cols-2 gap-2">
                                {Object.keys(schedule).map(day => (
                                    <div key={day} className="flex items-center gap-2 bg-white dark:bg-slate-900 p-2 rounded-xl border border-slate-100 dark:border-slate-700">
                                        <span className="text-[9px] font-black uppercase text-slate-500 w-12">{day}</span>
                                        <Clock size={10} className="text-slate-300" />
                                        <select
                                            value={schedule[day]}
                                            onChange={(e) => updateTimeForDay(day, e.target.value)}
                                            className="flex-1 text-[10px] font-bold bg-transparent outline-none text-slate-700 dark:text-slate-200"
                                        >
                                            {TIMES.map(t => <option key={t} value={t}>{t}</option>)}
                                        </select>
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                </div>

                {/* Financial / Pricing Section */}
                <div className={`p-4 rounded-2xl border space-y-3 transition-colors ${updateFinancials ? 'bg-emerald-50/50 dark:bg-emerald-900/10 border-emerald-100 dark:border-emerald-800' : 'bg-gray-50 dark:bg-slate-800 border-gray-200 dark:border-slate-700 grayscale'}`}>
                    <div className="flex justify-between items-center">
                        <label className="text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400 gap-2 flex items-center">
                            <DollarSign size={12} /> Proposta Comercial
                        </label>
                        {existingTuition !== null && existingTuition > 0 && (
                            <div className="flex items-center gap-2">
                                <span className="text-[9px] font-bold text-slate-500">
                                    Atual: {new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(existingTuition)}
                                </span>
                                <label className="text-[9px] font-bold flex items-center gap-1 cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={updateFinancials}
                                        onChange={(e) => setUpdateFinancials(e.target.checked)}
                                        className="rounded text-emerald-500 focus:ring-emerald-500"
                                    />
                                    Atualizar?
                                </label>
                            </div>
                        )}
                    </div>

                    {updateFinancials ? (
                        <div className="space-y-4 animate-in fade-in">
                            <div className="flex gap-3 items-end">
                                <div className="flex-1 space-y-1">
                                    <label className="text-[9px] font-bold text-slate-400 uppercase">Fidelidade</label>
                                    <select
                                        value={fidelityMonths}
                                        onChange={(e) => setFidelityMonths(Number(e.target.value))}
                                        className="w-full px-3 py-2 bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 rounded-xl text-xs font-bold text-emerald-800 dark:text-emerald-300 outline-none"
                                        disabled={isManualPrice} // Disable duration logic if manual overrides price? Or allow duration selection but price is manual.
                                    >
                                        <option value={6}>6 Meses</option>
                                        <option value={12}>12 Meses (Anual)</option>
                                        <option value={0}>Sem Fidelidade (Avulso)</option>
                                    </select>
                                </div>
                                <div className="flex-1 space-y-1 text-right">
                                    <label className="text-[9px] font-bold text-slate-400 uppercase">Mensalidade {isManualPrice ? 'Definida' : 'Estimada'}</label>
                                    <div className="text-lg font-black text-emerald-600 dark:text-emerald-400 tracking-tight">
                                        {calculatedPrice > 0
                                            ? new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(calculatedPrice)
                                            : '---'
                                        }
                                    </div>
                                </div>
                            </div>

                            {/* Manual Price / Discount Toggle */}
                            <div className="pt-2 border-t border-emerald-200/50 dark:border-emerald-800/50">
                                <label className="flex items-center gap-2 text-[9px] font-bold uppercase text-emerald-700 dark:text-emerald-500 mb-2 cursor-pointer hover:underline">
                                    <input
                                        type="checkbox"
                                        checked={isManualPrice}
                                        onChange={(e) => setIsManualPrice(e.target.checked)}
                                        className="rounded text-emerald-600 focus:ring-emerald-500"
                                    />
                                    Definir Valor Manual / Desconto
                                </label>

                                {isManualPrice && (
                                    <div className="relative animate-in fade-in slide-in-from-top-2">
                                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-emerald-600/50 font-bold text-xs">R$</span>
                                        <input
                                            type="number"
                                            value={manualPriceValue}
                                            onChange={(e) => setManualPriceValue(Number(e.target.value))}
                                            className="w-full pl-8 pr-4 py-2 bg-white dark:bg-slate-900 border border-emerald-200 dark:border-emerald-800 rounded-xl font-black text-emerald-700 dark:text-emerald-300 outline-none focus:ring-2 focus:ring-emerald-500 text-sm"
                                            placeholder="0.00"
                                        />
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <div className="text-center py-2">
                            <p className="text-[10px] font-bold text-slate-400">Mantendo valor atual contratado.</p>
                        </div>
                    )}
                </div>

            </div>

            <div className="p-8 border-t border-slate-100 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900 flex justify-end gap-3">
                <button
                    onClick={onClose}
                    className="px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
                >
                    Cancelar
                </button>
                <button
                    onClick={handleAssign}
                    disabled={isLoading}
                    className="px-8 py-3 bg-tenant-primary text-white rounded-xl font-black text-xs uppercase tracking-widest hover:scale-105 active:scale-95 transition-all shadow-lg shadow-tenant-primary/20 flex items-center gap-2 disabled:opacity-50"
                >
                    {isLoading ? 'Processando...' : 'Finalizar Atribuição'}
                </button>
            </div>
        </div>
    );
};

export default StudentAssignmentModal;
