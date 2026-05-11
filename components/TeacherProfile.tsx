
import React, { useState, useEffect } from 'react';
import { User, Mail, Phone, Lock, Save, Camera, CreditCard, Bell, Shield, CheckCircle, Upload, Eye, EyeOff } from 'lucide-react';
import { supabase } from '../lib/supabase';
import TeacherPixSettings from './TeacherPixSettings';

const TeacherProfile: React.FC = () => {
    const [loading, setLoading] = useState(true);
    const [isSaving, setIsSaving] = useState(false);
    const [showSuccess, setShowSuccess] = useState(false);
    const [uploadingPhoto, setUploadingPhoto] = useState(false);

    // Password Reset State
    const [showPasswordReset, setShowPasswordReset] = useState(false);
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [passLoading, setPassLoading] = useState(false);
    const [passError, setPassError] = useState('');
    const [passSuccess, setPassSuccess] = useState('');

    const [formData, setFormData] = useState({
        id: '',
        name: '',
        email: '',
        phone: '',
        avatar_url: '',
        role: '',
        whatsappInstance: '',
        bio: '',
        pixKey: '',
        bankName: '',
        agency: '',
        accountNumber: '',
        notifications: {
            email: true,
            push: true,
            marketing: false
        }
    });

    useEffect(() => {
        fetchProfile();
    }, []);

    const fetchProfile = async () => {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            const { data: profile } = await supabase
                .from('profiles')
                .select('*')
                .eq('id', user.id)
                .single();

            if (profile) {
                setFormData({
                    id: profile.id,
                    name: profile.full_name || '',
                    email: profile.email || user.email || '',
                    phone: profile.phone || '',
                    avatar_url: profile.avatar_url || '',
                    role: profile.role || 'STUDENT',
                    whatsappInstance: profile.whatsapp_instance || '', // Assuming column exists or we use a placeholder
                    bio: profile.bio || '', // Assuming column exists
                    pixKey: profile.pix_key || '',
                    bankName: profile.bank_name || '',
                    agency: profile.agency || '',
                    accountNumber: profile.account_number || '',
                    notifications: profile.notifications || { email: true, push: true, marketing: false }
                });
            }
        } catch (error) {
            console.error('Error fetching profile:', error);
        } finally {
            setLoading(false);
        }
    };

    const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!e.target.files || e.target.files.length === 0) return;

        const file = e.target.files[0];
        const fileExt = file.name.split('.').pop();

        // Sanitize ID to avoid UUID errors if user.id is not a standard UUID (e.g. "wise-wolf-school")
        const cleanUserId = formData.id && formData.id.includes('-') && formData.id.length > 20 ? formData.id : `user_${(formData.id || 'unknown').replace(/[^a-zA-Z0-9]/g, '')}`;

        const fileName = `${cleanUserId}-${Date.now()}.${fileExt}`;
        const filePath = `${fileName}`;

        setUploadingPhoto(true);

        try {
            // 1. Upload
            const { error: uploadError } = await supabase.storage
                .from('avatars')
                .upload(filePath, file);

            if (uploadError) throw uploadError;

            // 2. Get URL
            const { data: { publicUrl } } = supabase.storage
                .from('avatars')
                .getPublicUrl(filePath);

            // 3. Update Profile
            const { error: updateError } = await supabase
                .from('profiles')
                .update({ avatar_url: publicUrl })
                .eq('id', formData.id);

            if (updateError) throw updateError;

            setFormData(prev => ({ ...prev, avatar_url: publicUrl }));
            alert('Foto atualizada com sucesso!');
        } catch (error: any) {
            console.error('Error uploading photo:', error);
            alert('Erro ao atualizar foto: ' + error.message);
        } finally {
            setUploadingPhoto(false);
        }
    };

    const handleSave = async () => {
        setIsSaving(true);
        try {
            const { error } = await supabase
                .from('profiles')
                .update({
                    full_name: formData.name,
                    phone: formData.phone,
                    // bio: formData.bio, // Add to schema if needed
                    pix_key: formData.pixKey,
                    bank_name: formData.bankName,
                    agency: formData.agency,
                    account_number: formData.accountNumber,
                    // notifications: formData.notifications 
                })
                .eq('id', formData.id);

            if (error) throw error;

            setShowSuccess(true);
            setTimeout(() => setShowSuccess(false), 3000);
        } catch (error: any) {
            console.error('Error saving profile:', error);
            alert('Erro ao salvar: ' + error.message);
        } finally {
            setIsSaving(false);
        }
    };

    const handlePasswordReset = async () => {
        setPassError('');
        setPassSuccess('');

        if (newPassword !== confirmPassword) {
            setPassError('As senhas não coincidem.');
            return;
        }
        if (newPassword.length < 6) {
            setPassError('A senha deve ter pelo menos 6 caracteres.');
            return;
        }

        setPassLoading(true);
        try {
            const { error } = await supabase.auth.updateUser({
                password: newPassword
            });

            if (error) throw error;

            setPassSuccess('Senha alterada com sucesso!');
            setNewPassword('');
            setConfirmPassword('');
            setTimeout(() => {
                setShowPasswordReset(false);
                setPassSuccess('');
            }, 2000);
        } catch (error: any) {
            setPassError(error.message);
        } finally {
            setPassLoading(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center h-64">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-tenant-primary"></div>
            </div>
        );
    }

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
                    className="hidden md:flex bg-tenant-primary text-white px-6 py-3 rounded-xl font-bold text-xs uppercase tracking-widest hover:brightness-110 transition-all items-center gap-2 shadow-lg shadow-tenant-primary/20 disabled:opacity-50"
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

                        <div className="relative mb-6 group/avatar">
                            <div className="w-32 h-32 rounded-full p-1 bg-gradient-to-br from-tenant-primary to-blue-400">
                                <img
                                    src={formData.avatar_url || `https://ui-avatars.com/api/?name=${formData.name}`}
                                    alt="Avatar"
                                    className="w-full h-full rounded-full object-cover border-4 border-white dark:border-slate-900"
                                />
                            </div>
                            <label className="absolute bottom-1 right-1 bg-slate-900 text-white p-2.5 rounded-xl hover:scale-110 transition-transform shadow-lg border-2 border-white dark:border-slate-800 cursor-pointer">
                                {uploadingPhoto ? <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" /> : <Camera size={16} />}
                                <input type="file" className="hidden" accept="image/*" onChange={handlePhotoUpload} disabled={uploadingPhoto} />
                            </label>
                        </div>

                        <h3 className="font-black text-xl text-slate-800 dark:text-white mb-1">{formData.name}</h3>
                        <p className="text-xs font-bold text-slate-400 uppercase tracking-widest">Teacher</p>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-800 rounded-[2rem] p-6">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="p-2 bg-indigo-100 dark:bg-indigo-500/20 text-indigo-600 dark:text-indigo-400 rounded-lg">
                                <Shield size={18} />
                            </div>
                            <div>
                                <h4 className="font-bold text-sm text-slate-700 dark:text-slate-200">Segurança</h4>
                                <p className="text-xs text-slate-400">Gerencie sua senha</p>
                            </div>
                        </div>
                        {showPasswordReset ? (
                            <div className="space-y-3 animate-in fade-in slide-in-from-top-2">
                                <input
                                    type="password"
                                    placeholder="Nova Senha"
                                    className="w-full p-2 text-xs border rounded-lg dark:bg-slate-800 dark:border-slate-700"
                                    value={newPassword}
                                    onChange={e => setNewPassword(e.target.value)}
                                />
                                <input
                                    type="password"
                                    placeholder="Confirmar Senha"
                                    className="w-full p-2 text-xs border rounded-lg dark:bg-slate-800 dark:border-slate-700"
                                    value={confirmPassword}
                                    onChange={e => setConfirmPassword(e.target.value)}
                                />
                                {passError && <p className="text-xs text-red-500 font-bold">{passError}</p>}
                                {passSuccess && <p className="text-xs text-emerald-500 font-bold">{passSuccess}</p>}
                                <div className="flex gap-2">
                                    <button
                                        onClick={handlePasswordReset}
                                        disabled={passLoading}
                                        className="flex-1 bg-indigo-600 text-white py-2 rounded-lg text-xs font-bold hover:bg-indigo-700"
                                    >
                                        {passLoading ? '...' : 'Confirmar'}
                                    </button>
                                    <button
                                        onClick={() => setShowPasswordReset(false)}
                                        className="px-3 py-2 bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 rounded-lg text-xs font-bold"
                                    >
                                        Cancelar
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <button
                                onClick={() => setShowPasswordReset(true)}
                                className="w-full py-3 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-xl text-xs font-bold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors flex items-center justify-center gap-2"
                            >
                                <Lock size={14} /> Redefinir Senha
                            </button>
                        )}
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
                                    placeholder="Conte um pouco sobre você..."
                                />
                            </div>
                        </div>
                    </section>
                    {/* Financial Info - ONLY FOR TEACHERS */}
                    {formData.role === 'TEACHER' && (
                        <section className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-[2.5rem] p-8 md:p-10 shadow-sm relative">
                            <div className="absolute top-8 right-8 text-slate-300"><CreditCard size={24} /></div>
                            <h3 className="text-xl font-black text-slate-800 dark:text-white mb-8 flex items-center gap-3">
                                <span className="w-2 h-8 bg-emerald-500 rounded-full" /> Dados de Recebimento
                            </h3>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                <div className="md:col-span-1 space-y-2">
                                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Chave PIX</label>
                                    <div className="relative">
                                        <span className="absolute left-4 top-1/2 -translate-y-1/2 font-black text-emerald-500">PIX</span>
                                        <input
                                            value={formData.pixKey}
                                            onChange={e => setFormData({ ...formData, pixKey: e.target.value })}
                                            className="w-full pl-14 pr-4 py-4 bg-emerald-50/50 dark:bg-emerald-900/10 border border-emerald-100 dark:border-emerald-900/30 rounded-2xl text-sm font-bold text-slate-700 dark:text-white focus:ring-4 focus:ring-emerald-500/20 focus:border-emerald-500 outline-none transition-all"
                                        />
                                    </div>
                                </div>

                                <div className="md:col-span-1 space-y-2">
                                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Banco</label>
                                    <input
                                        value={formData.bankName}
                                        onChange={e => setFormData({ ...formData, bankName: e.target.value })}
                                        placeholder="Ex: Nubank, Itáu..."
                                        className="w-full p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-700 dark:text-white outline-none focus:border-emerald-500 transition-all"
                                    />
                                </div>

                                <div className="md:col-span-1 space-y-2">
                                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Agência</label>
                                    <input
                                        value={formData.agency}
                                        onChange={e => setFormData({ ...formData, agency: e.target.value })}
                                        placeholder="0000"
                                        className="w-full p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-700 dark:text-white outline-none focus:border-emerald-500 transition-all"
                                    />
                                </div>

                                <div className="md:col-span-1 space-y-2">
                                    <label className="text-xs font-black text-slate-400 uppercase tracking-widest ml-1">Conta Corrente</label>
                                    <input
                                        value={formData.accountNumber}
                                        onChange={e => setFormData({ ...formData, accountNumber: e.target.value })}
                                        placeholder="00000-0"
                                        className="w-full p-4 bg-slate-50 dark:bg-slate-800/50 border border-slate-200 dark:border-slate-700 rounded-2xl text-sm font-bold text-slate-700 dark:text-white outline-none focus:border-emerald-500 transition-all"
                                    />
                                </div>
                            </div>
                        </section>
                    )}


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
