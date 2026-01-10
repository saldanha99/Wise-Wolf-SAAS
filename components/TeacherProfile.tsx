
import React, { useState } from 'react';
import { User, Mail, Phone, Lock, Save, Camera, CreditCard, Bell, Shield, CheckCircle } from 'lucide-react';

const TeacherProfile: React.FC = () => {
    const [isSaving, setIsSaving] = useState(false);
    const [showSuccess, setShowSuccess] = useState(false);

    const [formData, setFormData] = useState({
        name: 'Roberto Almeida',
        email: 'roberto@wisewolf.com.br',
        phone: '(11) 99876-5432',
        whatsappInstance: '',
        bio: 'Professor de Inglês com 10 anos de experiência, focado em Business English e preparação para exames internacionais.',
        pixKey: 'roberto@email.com',
        notifications: {
            email: true,
            push: true,
            marketing: false
        }
    });

    const handleSave = () => {
        setIsSaving(true);
        // Simulate API call
        setTimeout(() => {
            setIsSaving(false);
            setShowSuccess(true);
            setTimeout(() => setShowSuccess(false), 3000);
        }, 1500);
    };

    return (
        <div className="max-w-4xl mx-auto space-y-8 animate-in fade-in duration-500 pb-20">

            {/* Header */}
            <div className="flex items-end justify-between border-b border-slate-200 dark:border-slate-800 pb-6">
                <div>
                    <h2 className="text-3xl font-black text-slate-800 dark:text-white tracking-tighter">Meu Perfil</h2>
                    <p className="text-slate-500 dark:text-slate-400 mt-1">Gerencie suas informações pessoais e preferências.</p>
                </div>
                <button
                    onClick={handleSave}
                    disabled={isSaving}
                    className="hidden md:flex bg-tenant-primary text-white px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all items-center gap-2 shadow-lg shadow-tenant-primary/20"
                >
                    {isSaving ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={18} />}
                    {isSaving ? 'Salvando...' : 'Salvar Alterações'}
                </button>
            </div>

            {/* Success Toast */}
            {showSuccess && (
                <div className="fixed top-10 right-10 z-50 bg-emerald-500 text-white px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-4 animate-in slide-in-from-right duration-500">
                    <div className="bg-white/20 p-2 rounded-full"><CheckCircle size={20} /></div>
                    <div>
                        <p className="font-black uppercase text-xs tracking-widest">Sucesso!</p>
                        <p className="text-sm font-medium">Perfil atualizado com sucesso.</p>
                    </div>
                </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">

                {/* Left Column - Avatar & Quick Info */}
                <div className="lg:col-span-1 space-y-6">
                    <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[2rem] p-8 flex flex-col items-center text-center shadow-xl shadow-slate-200/50 dark:shadow-none relative overflow-hidden group">
                        <div className="absolute inset-0 bg-gradient-to-b from-tenant-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

                        <div className="relative mb-6">
                            <div className="w-32 h-32 rounded-full p-1 bg-gradient-to-br from-tenant-primary to-blue-400">
                                <img
                                    src="https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?ixlib=rb-1.2.1&auto=format&fit=facearea&facepad=2&w=256&h=256&q=80"
                                    alt="Avatar"
                                    className="w-full h-full rounded-full object-cover border-4 border-white dark:border-slate-900"
                                />
                            </div>
                            <button className="absolute bottom-1 right-1 bg-slate-900 text-white p-2.5 rounded-xl hover:scale-110 transition-transform shadow-lg border-2 border-white dark:border-slate-800">
                                <Camera size={16} />
                            </button>
                        </div>

                        <h3 className="font-black text-xl text-slate-800 dark:text-white mb-1">{formData.name}</h3>
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Teacher</p>

                        <div className="w-full mt-8 pt-6 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-4">
                            <div>
                                <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Aulas</p>
                                <p className="text-xl font-black text-slate-800 dark:text-white">124</p>
                            </div>
                            <div>
                                <p className="text-[10px] text-slate-400 font-black uppercase tracking-widest mb-1">Avaliação</p>
                                <p className="text-xl font-black text-emerald-500">4.9</p>
                            </div>
                        </div>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-[2rem] p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="p-2 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 rounded-lg">
                                <Shield size={18} />
                            </div>
                            <div>
                                <h4 className="font-bold text-sm text-slate-700 dark:text-slate-200">Segurança</h4>
                                <p className="text-xs text-slate-400">Última troca de senha: 30 dias</p>
                            </div>
                        </div>
                        <button className="w-full py-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors flex items-center justify-center gap-2">
                            <Lock size={14} /> Redefinir Senha
                        </button>
                    </div>
                </div>

                {/* Right Column - Forms */}
                <div className="lg:col-span-2 space-y-8">

                    {/* Personal Info */}
                    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[2.5rem] p-8 md:p-10 shadow-sm relative">
                        <div className="absolute top-8 right-8 text-slate-300"><User size={24} /></div>
                        <h3 className="text-xl font-black text-slate-800 dark:text-white mb-8 flex items-center gap-3">
                            <span className="w-2 h-8 bg-tenant-primary rounded-full" /> Informações Pessoais
                        </h3>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Nome Completo</label>
                                <input
                                    value={formData.name}
                                    onChange={e => setFormData({ ...formData, name: e.target.value })}
                                    className="w-full p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-700 dark:text-white focus:ring-4 focus:ring-tenant-primary/10 focus:border-tenant-primary outline-none transition-all"
                                />
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Telefone / WhatsApp</label>
                                <div className="relative">
                                    <Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                    <input
                                        value={formData.phone}
                                        onChange={e => setFormData({ ...formData, phone: e.target.value })}
                                        className="w-full pl-12 pr-4 py-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-700 dark:text-white focus:ring-4 focus:ring-tenant-primary/10 focus:border-tenant-primary outline-none transition-all"
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Instância WA (Automation)</label>
                                <div className="relative">
                                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-tenant-primary font-black text-[10px]">WA</div>
                                    <input
                                        value={formData.whatsappInstance}
                                        onChange={e => setFormData({ ...formData, whatsappInstance: e.target.value })}
                                        placeholder="Nome da sua instância..."
                                        className="w-full pl-12 pr-4 py-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-700 dark:text-white focus:ring-4 focus:ring-tenant-primary/10 focus:border-tenant-primary outline-none transition-all"
                                    />
                                </div>
                            </div>
                            <div className="space-y-2">
                                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Email Principal</label>
                                <div className="relative">
                                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" size={18} />
                                    <input
                                        value={formData.email}
                                        readOnly
                                        className="w-full pl-12 pr-4 py-4 bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 rounded-2xl text-sm font-bold text-slate-500 cursor-not-allowed"
                                    />
                                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-[10px] uppercase font-black text-slate-400 bg-slate-200 dark:bg-slate-800 px-2 py-1 rounded">Verificado</span>
                                </div>
                            </div>
                            <div className="md:col-span-2 space-y-2">
                                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Bio Profissional</label>
                                <textarea
                                    value={formData.bio}
                                    onChange={e => setFormData({ ...formData, bio: e.target.value })}
                                    className="w-full p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-medium text-slate-700 dark:text-white focus:ring-4 focus:ring-tenant-primary/10 focus:border-tenant-primary outline-none transition-all h-32 resize-none"
                                />
                            </div>
                        </div>
                    </section>

                    {/* Financial Info */}
                    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[2.5rem] p-8 md:p-10 shadow-sm relative">
                        <div className="absolute top-8 right-8 text-slate-300"><CreditCard size={24} /></div>
                        <h3 className="text-xl font-black text-slate-800 dark:text-white mb-8 flex items-center gap-3">
                            <span className="w-2 h-8 bg-emerald-500 rounded-full" /> Dados de Recebimento
                        </h3>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div className="md:col-span-2 md:w-2/3 space-y-2">
                                <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Chave PIX</label>
                                <div className="relative">
                                    <span className="absolute left-4 top-1/2 -translate-y-1/2 font-black text-emerald-500">PIX</span>
                                    <input
                                        value={formData.pixKey}
                                        onChange={e => setFormData({ ...formData, pixKey: e.target.value })}
                                        className="w-full pl-14 pr-4 py-4 bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30 rounded-2xl text-sm font-bold text-slate-700 dark:text-white focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all"
                                    />
                                </div>
                                <p className="text-[10px] text-slate-400 font-medium ml-2">Usada para transferências automáticas de saldo.</p>
                            </div>
                        </div>
                    </section>

                    {/* Notifications */}
                    <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[2.5rem] p-8 md:p-10 shadow-sm relative">
                        <div className="absolute top-8 right-8 text-slate-300"><Bell size={24} /></div>
                        <h3 className="text-xl font-black text-slate-800 dark:text-white mb-8 flex items-center gap-3">
                            <span className="w-2 h-8 bg-amber-500 rounded-full" /> Preferências
                        </h3>

                        <div className="space-y-4">
                            {[
                                { id: 'email', label: 'Notificações por Email', sub: 'Receba resumos semanais e alertas de pagamento.' },
                                { id: 'push', label: 'Notificações Push', sub: 'Alertas em tempo real sobre novas aulas e avisos.' },
                                { id: 'marketing', label: 'Novidades da Plataforma', sub: 'Receba dicas de uso e atualizações do sistema.' }
                            ].map(opt => (
                                <div key={opt.id} className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors">
                                    <div>
                                        <p className="font-bold text-sm text-slate-700 dark:text-white">{opt.label}</p>
                                        <p className="text-xs text-slate-400">{opt.sub}</p>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                        <input
                                            type="checkbox"
                                            checked={(formData.notifications as any)[opt.id]}
                                            onChange={() => setFormData({
                                                ...formData,
                                                notifications: { ...formData.notifications, [opt.id]: !(formData.notifications as any)[opt.id] }
                                            })}
                                            className="sr-only peer"
                                        />
                                        <div className="w-11 h-6 bg-slate-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-tenant-primary/20 dark:peer-focus:ring-tenant-primary/30 rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-tenant-primary"></div>
                                    </label>
                                </div>
                            ))}
                        </div>
                    </section>
                </div>
            </div>

            {/* Floating Save Button (Mobile) */}
            <button
                onClick={handleSave}
                disabled={isSaving}
                className="md:hidden fixed bottom-6 right-6 z-50 bg-tenant-primary text-white p-4 rounded-full shadow-2xl shadow-tenant-primary/40 hover:scale-110 active:scale-95 transition-all text-sm font-bold uppercase tracking-widest flex items-center justify-center"
            >
                {isSaving ? <div className="w-6 h-6 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Save size={24} />}
            </button>
        </div>
    );
};

export default TeacherProfile;
