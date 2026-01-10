
import React, { useState } from 'react';
import { X, Calendar, Clock, User, Check, AlertCircle, Plus, Phone, Briefcase, Mail, Tag } from 'lucide-react';

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
}

interface StudentAssignmentModalProps {
    students: Student[];
    availableSlots: Set<string>;
    onAssign: (data: { studentId?: string; isNew: boolean; studentData?: any; days: string[]; timeSlot: string; module: string }) => void;
    onClose: () => void;
    isLoading?: boolean;
}

const StudentAssignmentModal: React.FC<StudentAssignmentModalProps> = ({ students, availableSlots, onAssign, onClose, isLoading }) => {
    const [isNewStudent, setIsNewStudent] = useState(false);
    const [selectedStudentId, setSelectedStudentId] = useState('');
    const [selectedDays, setSelectedDays] = useState<string[]>([]);
    const [selectedTime, setSelectedTime] = useState('08:00');
    const [module, setModule] = useState('B1');
    const [startDate, setStartDate] = useState(new Date().toISOString().split('T')[0]);
    const [validationError, setValidationError] = useState<string | null>(null);

    // New Student Fields
    const [newName, setNewName] = useState('');
    const [newEmail, setNewEmail] = useState('');
    const [newPhone, setNewPhone] = useState('');
    const [newOccupation, setNewOccupation] = useState('');
    const [newInterests, setNewInterests] = useState('');

    const toggleDay = (day: string) => {
        setValidationError(null);
        if (selectedDays.includes(day)) {
            setSelectedDays(selectedDays.filter(d => d !== day));
        } else {
            if (selectedDays.length < 5) {
                setSelectedDays([...selectedDays, day]);
            } else {
                alert("Máximo de 5 dias por semana permitido.");
            }
        }
    };

    const handleAssign = () => {
        if (!isNewStudent && !selectedStudentId) return alert("Selecione um aluno.");
        if (isNewStudent && !newName) return alert("Informe o nome do novo aluno.");
        if (isNewStudent && !newEmail) return alert("Informe o e-mail para o novo acesso.");
        if (selectedDays.length === 0) return alert("Selecione ao menos um dia.");

        // Check availability for all selected days at the chosen time
        const dayMap: Record<string, number> = {
            'Segunda': 0, 'Terça': 1, 'Quarta': 2, 'Quinta': 3, 'Sexta': 4, 'Sábado': 5
        };
        const hour = selectedTime;
        const unavailableDays: string[] = [];

        selectedDays.forEach(day => {
            const key = `${dayMap[day]}-${hour}`;
            if (!availableSlots.has(key)) {
                unavailableDays.push(day);
            }
        });

        if (unavailableDays.length > 0) {
            setValidationError(`O professor não possui disponibilidade nos dias: ${unavailableDays.join(', ')} às ${selectedTime}.`);
            return;
        }

        onAssign({
            studentId: isNewStudent ? undefined : selectedStudentId,
            isNew: isNewStudent,
            studentData: isNewStudent ? {
                name: newName,
                email: newEmail,
                phone: newPhone,
                occupation: newOccupation,
                interests: newInterests.split(',').map(i => i.trim()).filter(i => i !== '')
            } : undefined,
            days: selectedDays,
            timeSlot: selectedTime,
            module,
            startDate
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
                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                <Plus size={12} /> Nome Completo
                            </label>
                            <input
                                value={newName}
                                onChange={e => setNewName(e.target.value)}
                                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                placeholder="Nome do aluno"
                            />
                        </div>

                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                <Mail size={12} /> E-mail (Acesso)
                            </label>
                            <input
                                type="email"
                                value={newEmail}
                                onChange={e => setNewEmail(e.target.value)}
                                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                placeholder="ex: aluno@email.com"
                            />
                            <p className="text-[8px] text-slate-400 font-bold uppercase tracking-widest">Senha padrão: 123456</p>
                        </div>

                        <div className="grid grid-cols-2 gap-4">
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Phone size={12} /> Telefone
                                </label>
                                <input
                                    value={newPhone}
                                    onChange={e => setNewPhone(e.target.value)}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                    placeholder="WhatsApp"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                    <Briefcase size={12} /> Ocupação
                                </label>
                                <input
                                    value={newOccupation}
                                    onChange={e => setNewOccupation(e.target.value)}
                                    className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                    placeholder="Ex: Arquiteto"
                                />
                            </div>
                        </div>

                        <div className="space-y-2">
                            <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                                <Tag size={12} /> Interesses (Separados por vírgula)
                            </label>
                            <input
                                value={newInterests}
                                onChange={e => setNewInterests(e.target.value)}
                                className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                                placeholder="Ex: Viagens, Negócios, Filmes"
                            />
                        </div>
                    </div>
                )}

                {/* Level/Module */}
                <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                        Módulo/Nível
                    </label>
                    <input
                        value={module}
                        onChange={e => setModule(e.target.value.toUpperCase())}
                        className="w-full px-4 py-3 bg-blue-50 dark:bg-blue-900/10 border border-blue-100 dark:border-blue-900/30 rounded-xl text-xs font-black text-blue-700 dark:text-blue-300 focus:ring-2 focus:ring-blue-500 outline-none uppercase tracking-wide"
                        placeholder="Ex: B1"
                    />
                </div>

                {/* Start Date */}
                <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-tenant-primary flex items-center gap-1.5">
                        <Calendar size={12} /> Aluno inicia no dia:
                    </label>
                    <input
                        type="date"
                        value={startDate}
                        onChange={e => setStartDate(e.target.value)}
                        className="w-full px-4 py-3 bg-white dark:bg-slate-950 border border-tenant-primary/20 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                    />
                </div>

                {/* Days of Week */}
                <div className="space-y-3">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                        <Calendar size={12} /> Dias da Semana (Até 5x)
                    </label>
                    <div className="grid grid-cols-3 gap-2">
                        {DAYS.map(day => (
                            <button
                                key={day}
                                onClick={() => toggleDay(day)}
                                className={`py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all border ${selectedDays.includes(day)
                                    ? 'bg-tenant-primary border-tenant-primary text-white shadow-md'
                                    : 'bg-slate-50 dark:bg-slate-800 border-slate-100 dark:border-slate-700 text-slate-400'
                                    }`}
                            >
                                {day}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Time Slot */}
                <div className="space-y-2">
                    <label className="text-[10px] font-black uppercase tracking-widest text-slate-400 flex items-center gap-1.5">
                        <Clock size={12} /> Horário
                    </label>
                    <select
                        value={selectedTime}
                        onChange={(e) => {
                            setSelectedTime(e.target.value);
                            setValidationError(null);
                        }}
                        className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold text-slate-700 dark:text-slate-200 focus:ring-2 focus:ring-tenant-primary outline-none"
                    >
                        {TIMES.map(t => (
                            <option key={t} value={t}>{t}</option>
                        ))}
                    </select>
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
