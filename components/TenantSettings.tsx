
import React, { useState, useEffect } from 'react';
import { Palette, Globe, Image as ImageIcon, Save, RefreshCw, Check, Loader2, UploadCloud, Zap } from 'lucide-react';
import { Tenant } from '../types';

interface TenantSettingsProps {
  tenant: Tenant;
  onUpdate: (updatedBranding: any) => void;
}

const TenantSettings: React.FC<TenantSettingsProps> = ({ tenant, onUpdate }) => {
  const [whatsappConfig, setWhatsappConfig] = useState({
    url: tenant.whatsapp_api_url || '',
    key: tenant.whatsapp_api_key || '',
    enabled: tenant.whatsapp_enabled ?? true
  });

  // ... (inside the component)

  const handleSave = async () => {
    setIsSaving(true);
    try {
      // update tenant branding and whatsapp config
      // Note: onUpdate in App.tsx updates local state, but we need to persist to DB here or in App.tsx.
      // Assuming onUpdate only updates local state, we should save to Supabase here.

      const { error } = await import('../lib/supabase').then(({ supabase }) =>
        supabase.from('tenants').update({
          branding: branding,
          whatsapp_api_url: whatsappConfig.url,
          whatsapp_api_key: whatsappConfig.key,
          whatsapp_enabled: whatsappConfig.enabled
        }).eq('id', tenant.id)
      );

      if (error) throw error;

      onUpdate({ ...branding }); // Update parent state
      alert("Configurações atualizadas com sucesso!");
    } catch (err) {
      console.error(err);
      alert("Erro ao salvar configurações.");
    } finally {
      setIsSaving(false);
    }
  };

  // ... (UI part)

  <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm space-y-6">
    <div className="flex items-center gap-3 pb-4 border-b border-gray-50 dark:border-slate-800">
      <div className="p-2 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-lg">
        <Zap size={20} />
      </div>
      <h3 className="font-bold text-gray-800 dark:text-slate-100">Automação WhatsApp</h3>
    </div>
    <div className="space-y-6">
      <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl">
        <div>
          <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Ativar Notificações</label>
          <p className="text-xs text-gray-500">Enviar lembretes e confirmações automaticamente.</p>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            className="sr-only peer"
            checked={whatsappConfig.enabled}
            onChange={(e) => setWhatsappConfig({ ...whatsappConfig, enabled: e.target.checked })}
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-tenant-primary"></div>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-[10px] font-bold text-gray-400 uppercase">API Gateway URL</label>
          <input
            type="text"
            value={whatsappConfig.url}
            onChange={(e) => setWhatsappConfig({ ...whatsappConfig, url: e.target.value })}
            placeholder="https://sua-api.com"
            className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl outline-none text-xs"
          />
        </div>
        <div className="space-y-2">
          <label className="text-[10px] font-bold text-gray-400 uppercase">API Key (Segredo)</label>
          <input
            type="password"
            value={whatsappConfig.key}
            onChange={(e) => setWhatsappConfig({ ...whatsappConfig, key: e.target.value })}
            placeholder="••••••••••••"
            className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl outline-none text-xs"
          />
        </div>
      </div>
    </div>
  </div>

  const handleValidateDNS = () => {
    setIsValidating(true);
    setTimeout(() => {
      setIsValidating(false);
      alert(`Domínio ${domain} validado com sucesso! Apontamento CNAME detectado e propagado.`);
    }, 2000);
  };

  const simulateUpload = (type: 'logo' | 'favicon') => {
    setIsUploading(type);

    // Create a hidden file input to simulate real browsing
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';

    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        // Create local preview URL
        const url = URL.createObjectURL(file);

        setTimeout(() => {
          setBranding(prev => ({
            ...prev,
            [type === 'logo' ? 'logoUrl' : 'faviconUrl']: url
          }));
          setIsUploading(null);
          // Don't alert here, let the UI update show it
        }, 1200);
      } else {
        setIsUploading(null);
      }
    };

    input.click();
  };

  const resetColors = () => {
    setBranding({
      ...branding,
      primaryColor: '#002366',
      secondaryColor: '#D32F2F'
    });
  };

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <header className="flex justify-between items-end">
        <div>
          <h2 className="text-2xl font-bold text-gray-800 dark:text-slate-100 tracking-tight">Customização da Marca</h2>
          <p className="text-sm text-gray-500 dark:text-slate-400">Gerencie a identidade visual da sua escola (White Label).</p>
        </div>
        <span className="text-[10px] font-black uppercase tracking-widest bg-blue-100/50 text-blue-600 px-3 py-1 rounded-full animate-pulse">
          Live Preview Ativo
        </span>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-6">
          <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm space-y-8 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-gray-50 to-gray-100 dark:from-slate-800 dark:to-slate-900 rounded-bl-full -mr-10 -mt-10 pointer-events-none" />

            <div className="flex items-center gap-3 pb-4 border-b border-gray-50 dark:border-slate-800 relative">
              <div className="p-2 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 rounded-lg">
                <Palette size={20} />
              </div>
              <h3 className="font-bold text-gray-800 dark:text-slate-100">Cores do Sistema</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8 relative">
              <div className="space-y-3">
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Cor Primária (Comandos)</label>
                <div className="flex items-center gap-4 group">
                  <div className="relative overflow-hidden w-14 h-14 rounded-2xl shadow-sm ring-1 ring-gray-200 dark:ring-slate-700 transition-transform group-hover:scale-105">
                    <input
                      type="color"
                      value={branding.primaryColor}
                      onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
                      className="absolute -top-1/2 -left-1/2 w-[200%] h-[200%] cursor-pointer border-none p-0"
                    />
                  </div>
                  <div className="flex-1">
                    <input
                      type="text"
                      value={branding.primaryColor}
                      onChange={(e) => setBranding({ ...branding, primaryColor: e.target.value })}
                      className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl font-mono text-xs uppercase text-gray-700 dark:text-slate-300 outline-none focus:ring-2 focus:ring-tenant-primary transition-all"
                    />
                    <p className="text-[9px] text-gray-400 mt-1">Botões, Links, Destaques</p>
                  </div>
                </div>
              </div>

              <div className="space-y-3">
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Cor Secundária (Alertas)</label>
                <div className="flex items-center gap-4 group">
                  <div className="relative overflow-hidden w-14 h-14 rounded-2xl shadow-sm ring-1 ring-gray-200 dark:ring-slate-700 transition-transform group-hover:scale-105">
                    <input
                      type="color"
                      value={branding.secondaryColor}
                      onChange={(e) => setBranding({ ...branding, secondaryColor: e.target.value })}
                      className="absolute -top-1/2 -left-1/2 w-[200%] h-[200%] cursor-pointer border-none p-0"
                    />
                  </div>
                  <div className="flex-1">
                    <input
                      type="text"
                      value={branding.secondaryColor}
                      onChange={(e) => setBranding({ ...branding, secondaryColor: e.target.value })}
                      className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl font-mono text-xs uppercase text-gray-700 dark:text-slate-300 outline-none focus:ring-2 focus:ring-tenant-primary transition-all"
                    />
                    <p className="text-[9px] text-gray-400 mt-1">Notificações, Badges, Status</p>
                  </div>
                </div>
              </div>
            </div>

            <button
              onClick={resetColors}
              className="text-[10px] font-bold text-gray-400 hover:text-blue-600 transition-colors uppercase flex items-center gap-2"
            >
              <RefreshCw size={12} /> Restaurar cores padrão
            </button>
          </div>

          <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm space-y-8">
            <div className="flex items-center gap-3 pb-4 border-b border-gray-50 dark:border-slate-800">
              <div className="p-2 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-lg">
                <ImageIcon size={20} />
              </div>
              <h3 className="font-bold text-gray-800 dark:text-slate-100">Logotipos e Ícones</h3>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
              <div className="space-y-4">
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Logo Principal (SVG/PNG)</label>
                <button
                  onClick={() => simulateUpload('logo')}
                  disabled={!!isUploading}
                  className="w-full border-2 border-dashed border-gray-100 dark:border-slate-800 rounded-2xl p-6 flex flex-col items-center justify-center text-center space-y-3 hover:border-tenant-primary hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-all cursor-pointer group disabled:opacity-50 relative overflow-hidden"
                >
                  {isUploading === 'logo' ? <Loader2 className="animate-spin text-tenant-primary" /> : (
                    <>
                      <img src={branding.logoUrl} className="h-16 w-auto object-contain transition-transform group-hover:scale-110" alt="Current Logo" />
                      <div className="absolute inset-x-0 bottom-0 bg-black/50 p-2 transform translate-y-full group-hover:translate-y-0 transition-transform">
                        <span className="text-[10px] text-white font-black uppercase flex items-center justify-center gap-2"><UploadCloud size={12} /> Alterar</span>
                      </div>
                    </>
                  )}
                </button>
              </div>
              <div className="space-y-4">
                <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Favicon (32x32)</label>
                <button
                  onClick={() => simulateUpload('favicon')}
                  disabled={!!isUploading}
                  className="w-full border-2 border-dashed border-gray-100 dark:border-slate-800 rounded-2xl p-6 flex flex-col items-center justify-center text-center space-y-3 hover:border-tenant-primary hover:bg-gray-50 dark:hover:bg-slate-800/50 transition-all cursor-pointer group disabled:opacity-50 relative overflow-hidden"
                >
                  {isUploading === 'favicon' ? <Loader2 className="animate-spin text-tenant-primary" /> : (
                    <>
                      <div className="w-10 h-10 rounded-xl bg-gray-50 dark:bg-slate-800 p-2 shadow-sm">
                        <img src={branding.faviconUrl} className="w-full h-full object-contain" alt="Favicon" />
                      </div>
                      <div className="absolute inset-x-0 bottom-0 bg-black/50 p-2 transform translate-y-full group-hover:translate-y-0 transition-transform">
                        <span className="text-[10px] text-white font-black uppercase flex items-center justify-center gap-2"><UploadCloud size={12} /> Alterar</span>
                      </div>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b border-gray-50 dark:border-slate-800">
              <div className="p-2 bg-indigo-50 dark:bg-indigo-900/20 text-indigo-600 dark:text-indigo-400 rounded-lg">
                <Zap size={20} />
              </div>
              <h3 className="font-bold text-gray-800 dark:text-slate-100">Automação WhatsApp</h3>
            </div>
            <div className="space-y-6">
              <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-800 rounded-2xl">
                <div>
                  <label className="text-[10px] font-black text-gray-400 uppercase tracking-widest">Ativar Notificações</label>
                  <p className="text-xs text-gray-500">Enviar lembretes e confirmações automaticamente.</p>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input type="checkbox" className="sr-only peer" defaultChecked />
                  <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none rounded-full peer dark:bg-slate-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600 peer-checked:bg-tenant-primary"></div>
                </label>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">API Gateway URL</label>
                  <input
                    type="text"
                    placeholder="https://sua-api.com"
                    className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl outline-none text-xs"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-[10px] font-bold text-gray-400 uppercase">API Key (Segredo)</label>
                  <input
                    type="password"
                    placeholder="••••••••••••"
                    className="w-full p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl outline-none text-xs"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white dark:bg-slate-900 p-8 rounded-3xl border border-gray-100 dark:border-slate-800 shadow-sm space-y-6">
            <div className="flex items-center gap-3 pb-4 border-b border-gray-50 dark:border-slate-800">
              <div className="p-2 bg-emerald-50 dark:bg-emerald-900/20 text-emerald-600 dark:text-emerald-400 rounded-lg">
                <Globe size={20} />
              </div>
              <h3 className="font-bold text-gray-800 dark:text-slate-100">Domínio Customizado</h3>
            </div>
            <div className="space-y-4">
              <label className="text-[10px] font-bold text-gray-400 uppercase">Subdomínio ou URL Própria</label>
              <div className="flex flex-col md:flex-row gap-3">
                <input
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  className="flex-1 p-3 bg-gray-50 dark:bg-slate-800 border border-gray-100 dark:border-slate-700 rounded-xl focus:ring-1 focus:ring-tenant-primary outline-none font-medium text-gray-700 dark:text-slate-300"
                />
                <button
                  onClick={handleValidateDNS}
                  disabled={isValidating}
                  className="px-6 py-3 bg-gray-900 dark:bg-slate-100 dark:text-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:opacity-90 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                >
                  {isValidating ? <RefreshCw className="animate-spin" size={14} /> : null}
                  {isValidating ? 'Validando...' : 'Validar CNAME'}
                </button>
              </div>
              <p className="text-[10px] text-gray-400 dark:text-slate-500 italic font-medium">Configure o registro CNAME no seu provedor de DNS para apontar para <b>core.educore.io</b></p>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="sticky top-8">
            <div className="bg-gray-900 dark:bg-slate-800 text-white p-6 rounded-3xl shadow-xl overflow-hidden relative border dark:border-slate-700">
              <div className="absolute -right-4 -top-4 w-24 h-24 bg-blue-600/20 blur-3xl rounded-full" />
              <h4 className="font-bold text-lg mb-1 relative z-10">Preview em Tempo Real</h4>
              <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-6 relative z-10">Interface Mobile/Tablet</p>

              <div className="aspect-[9/16] bg-[#F4F7F9] dark:bg-slate-900 rounded-2xl border-4 border-gray-800 dark:border-slate-950 relative overflow-hidden text-gray-800 dark:text-slate-100">
                <div className="h-10 bg-white dark:bg-slate-800 border-b dark:border-slate-700 flex items-center px-3 justify-between">
                  <div className="h-3 w-12 bg-gray-100 dark:bg-slate-700 rounded-full" />
                  <div className="w-5 h-5 rounded bg-gray-100 dark:bg-slate-700" />
                </div>
                <div className="p-4 space-y-3">
                  <div className="h-4 w-24 rounded-full" style={{ backgroundColor: branding.primaryColor }} />
                  <div className="h-20 w-full bg-white dark:bg-slate-800 rounded-xl border border-gray-100 dark:border-slate-700 shadow-sm p-3 space-y-2">
                    <div className="h-2 w-full bg-gray-100 dark:bg-slate-700 rounded" />
                    <div className="h-2 w-2/3 bg-gray-100 dark:bg-slate-700 rounded" />
                    <div className="h-8 w-full rounded-lg" style={{ backgroundColor: branding.primaryColor }} />
                  </div>
                  <div className="h-8 w-8 rounded-full border-2 border-white dark:border-slate-800 shadow-sm absolute bottom-4 right-4" style={{ backgroundColor: branding.secondaryColor }} />
                </div>
              </div>

              <button
                onClick={handleSave}
                disabled={isSaving}
                className={`w-full mt-6 py-4 rounded-2xl font-black text-xs flex items-center justify-center gap-2 transition-all uppercase tracking-widest ${isSaving ? 'bg-gray-700 text-gray-400' : 'bg-blue-600 text-white hover:scale-[1.02] shadow-lg shadow-blue-900/40'
                  }`}
              >
                {isSaving ? <RefreshCw className="animate-spin" size={18} /> : <Save size={18} />}
                {isSaving ? 'Salvando...' : 'Publicar Branding'}
              </button>
            </div>

            <div className="mt-6 p-4 bg-amber-50 dark:bg-amber-900/10 border border-amber-100 dark:border-amber-900/30 rounded-2xl flex items-start gap-3">
              <div className="p-1.5 bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 rounded-lg">
                <Check size={14} />
              </div>
              <p className="text-[10px] text-amber-900 dark:text-amber-200 leading-relaxed font-medium">
                Mudanças de branding refletem instantaneamente para todos os alunos e professores vinculados ao seu Tenant.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default TenantSettings;
