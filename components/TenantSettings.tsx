import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity, BadgeCheck, BellRing, Building2, Check, CheckCircle2, ChevronRight,
  Circle, CloudCog, Copy, Eye, Globe2, Image as ImageIcon, KeyRound, Loader2,
  LockKeyhole, Palette, RefreshCw, Save, School, ShieldCheck, Trash2,
  UploadCloud, Users, WalletCards, XCircle,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { BASE_DOMAIN, clearTenantCache } from '../lib/tenant-resolver';
import { clearSchoolInfoCache } from '../lib/schoolInfo';
import {
  TenantBrandingForm,
  TenantIntegrationProvider,
  TenantIntegrationStatus,
  TenantSchoolInfo,
  TenantSettingsAuditEntry,
  TenantSettingsError,
  TenantSettingsForm,
  TenantSettingsSnapshot,
  tenantSettingsService,
} from '../services/tenantSettingsService';
import { Tenant } from '../types';

interface TenantSettingsProps {
  tenant: Tenant;
  onUpdate: (updatedBranding: Tenant['branding']) => void;
}

type SectionId = 'overview' | 'identity' | 'branding' | 'portal' | 'operations' | 'integrations' | 'security';
type Notice = { type: 'success' | 'error' | 'info'; message: string } | null;
type BrandingUploadKind = 'logo' | 'favicon' | 'signature';

const DEFAULT_BRANDING: TenantBrandingForm = {
  primaryColor: '#002366', secondaryColor: '#D32F2F', logoUrl: '', faviconUrl: '', logoPath: '', faviconPath: '',
};
const EMPTY_SCHOOL: TenantSchoolInfo = {
  name: '', legalName: '', cnpj: '', address: '', email: '', phone: '', city: '', state: '',
  directorName: '', legalRepresentativeName: '', legalRepresentativeSignaturePath: '', legalRepresentativeSignatureUrl: '', privacyContactEmail: '',
};

const PROVIDER_LABELS: Record<TenantIntegrationProvider, { name: string; description: string; placeholder: string }> = {
  asaas: { name: 'Asaas', description: 'Prepara e valida a chave própria da escola para futura ativação no runtime.', placeholder: '$aact_...' },
  evolution: { name: 'Evolution WhatsApp', description: 'Prepara a credencial da conta Evolution sem trocar o runtime atual.', placeholder: 'Cole a API key da Evolution' },
  openai: { name: 'OpenAI', description: 'Prepara uma chave própria para futura ativação dos recursos de IA.', placeholder: 'sk-...' },
  openrouter: { name: 'OpenRouter', description: 'Prepara uma chave própria para futura ativação do catálogo ampliado.', placeholder: 'sk-or-...' },
};

const SECTION_ITEMS: Array<{ id: SectionId; label: string; description: string; icon: React.ElementType }> = [
  { id: 'overview', label: 'Visão geral', description: 'Implantação e saúde', icon: Activity },
  { id: 'identity', label: 'Escola e legal', description: 'Dados jurídicos', icon: Building2 },
  { id: 'branding', label: 'Marca', description: 'Logo, ícone e cores', icon: Palette },
  { id: 'portal', label: 'Portal e domínio', description: 'Endereços da escola', icon: Globe2 },
  { id: 'operations', label: 'Operação', description: 'Aulas e comunicação', icon: CloudCog },
  { id: 'integrations', label: 'Credenciais', description: 'Cofre e provedores', icon: KeyRound },
  { id: 'security', label: 'Segurança', description: 'Isolamento e auditoria', icon: ShieldCheck },
];

function deriveSlug(snapshot: TenantSettingsSnapshot): string {
  if (snapshot.tenant.slug && snapshot.tenant.slug.trim()) {
    return snapshot.tenant.slug.trim();
  }
  const candidate = snapshot.tenant.name || snapshot.tenant.domain || snapshot.tenant.id || 'escola';
  const cleaned = candidate
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return cleaned.length >= 3 ? cleaned : `${cleaned || 'escola'}-portal`.slice(0, 40);
}

function snapshotToForm(snapshot: TenantSettingsSnapshot): TenantSettingsForm {
  return {
    name: snapshot.tenant.name || '',
    slug: deriveSlug(snapshot),
    branding: { ...DEFAULT_BRANDING, ...snapshot.tenant.branding },
    schoolInfo: { ...EMPTY_SCHOOL, ...(snapshot.tenant.schoolInfo || {}) },
    whatsappEnabled: snapshot.tenant.whatsappEnabled,
    financialCutoffDay: snapshot.tenant.financialCutoffDay || 5,
    locale: snapshot.settings.locale || 'pt-BR',
    timezone: snapshot.settings.timezone || 'America/Sao_Paulo',
    currency: snapshot.settings.currency || 'BRL',
    weekStartsOn: snapshot.settings.weekStartsOn ?? 1,
    defaultLessonDurationMinutes: snapshot.settings.defaultLessonDurationMinutes || 60,
    studentNotificationsEnabled: snapshot.settings.studentNotificationsEnabled,
    teacherNotificationsEnabled: snapshot.settings.teacherNotificationsEnabled,
  };
}

function normalizeCnpj(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 14);
  return digits.replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
}

function isValidCnpj(value: string) {
  const digits = value.replace(/\D/g, '');
  if (digits.length !== 14 || /^(\d)\1{13}$/.test(digits)) return false;
  const calculateDigit = (length: number) => {
    let factor = length - 7;
    let total = 0;
    for (let index = 0; index < length; index += 1) {
      total += Number(digits[index]) * factor;
      factor -= 1;
      if (factor === 1) factor = 9;
    }
    const remainder = total % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  return calculateDigit(12) === Number(digits[12]) && calculateDigit(13) === Number(digits[13]);
}

function isTenantSignaturePath(value: string, tenantId: string) {
  const escapedTenant = tenantId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^${escapedTenant}/legal-representative-signature/[0-9a-f-]{36}\\.(?:png|jpe?g|webp)$`,
    'i',
  ).test(value);
}

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits ? `(${digits}` : '';
  if (digits.length <= 6) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

function friendlyError(error: unknown) {
  if (error instanceof TenantSettingsError) {
    const messages: Record<string, string> = {
      SETTINGS_CONFLICT: 'As configurações mudaram em outra sessão. Recarregue antes de salvar.',
      SLUG_IN_USE: 'Este endereço do portal já está sendo usado por outra escola.',
      INVALID_SETTINGS: 'Configurações inválidas. Verifique os campos informados.',
      INVALID_CREDENTIAL: 'O provedor recusou essa credencial. Confira a chave e o ambiente.',
      RATE_LIMITED: 'Muitas tentativas em pouco tempo. Aguarde alguns minutos.',
      DNS_NOT_READY: 'Os registros DNS ainda não foram encontrados nos dois pontos de verificação.',
      DOMAIN_IN_USE: 'Esse domínio já pertence a outra escola na plataforma.',
      ACTIVE_TENANT_REQUIRED: 'Selecione uma escola ativa antes de abrir as configurações.',
      TENANT_INACTIVE: 'Esta escola está fora de um plano ativo ou período de teste.',
      INVALID_ENVIRONMENT: 'Selecione Sandbox ou Produção para a credencial Asaas.',
      INVALID_LEGAL_SIGNATURE: 'A assinatura privada não está disponível. Envie o arquivo novamente.',
    };
    return messages[error.code] || error.message;
  }
  return error instanceof Error ? error.message : 'Não foi possível concluir a operação.';
}

const TenantSettings: React.FC<TenantSettingsProps> = ({ tenant, onUpdate }) => {
  const [section, setSection] = useState<SectionId>('overview');
  const [snapshot, setSnapshot] = useState<TenantSettingsSnapshot | null>(null);
  const [form, setForm] = useState<TenantSettingsForm | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [uploading, setUploading] = useState<BrandingUploadKind | null>(null);
  const [domainDraft, setDomainDraft] = useState('');
  const [domainBusy, setDomainBusy] = useState<'request' | 'verify' | null>(null);
  const [credentialDrafts, setCredentialDrafts] = useState<Record<TenantIntegrationProvider, string>>({ asaas: '', evolution: '', openai: '', openrouter: '' });
  const [credentialEnvironments, setCredentialEnvironments] = useState<Record<TenantIntegrationProvider, 'sandbox' | 'production'>>({ asaas: 'sandbox', evolution: 'production', openai: 'production', openrouter: 'production' });
  const [credentialBusy, setCredentialBusy] = useState<TenantIntegrationProvider | null>(null);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const faviconInputRef = useRef<HTMLInputElement>(null);
  const signatureInputRef = useRef<HTMLInputElement>(null);
  const loadSequenceRef = useRef(0);

  const load = async (preserveNotice = false) => {
    const requestId = ++loadSequenceRef.current;
    setLoading(true);
    try {
      const next = await tenantSettingsService.get();
      if (requestId !== loadSequenceRef.current) return;
      setSnapshot(next);
      setForm(snapshotToForm(next));
      setDomainDraft(next.tenant.customDomain || '');
      const asaas = next.integrations.find((item) => item.provider === 'asaas');
      setCredentialEnvironments({
        asaas: asaas?.environment === 'production' ? 'production' : 'sandbox',
        evolution: 'production',
        openai: 'production',
        openrouter: 'production',
      });
      setDirty(false);
      if (!preserveNotice) setNotice(null);
    } catch (error) {
      if (requestId !== loadSequenceRef.current) return;
      setNotice({ type: 'error', message: friendlyError(error) });
    } finally {
      if (requestId === loadSequenceRef.current) setLoading(false);
    }
  };

  useEffect(() => {
    setSnapshot(null);
    setForm(null);
    setDirty(false);
    void load();
  }, [tenant.id]);
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [dirty]);

  const updateForm = <K extends keyof TenantSettingsForm>(key: K, value: TenantSettingsForm[K]) => {
    setForm((current) => current ? { ...current, [key]: value } : current);
    setDirty(true);
    setNotice(null);
  };
  const updateSchool = (key: keyof TenantSchoolInfo, value: string) => {
    if (form) updateForm('schoolInfo', { ...(form.schoolInfo || EMPTY_SCHOOL), [key]: value });
  };
  const updateBranding = (key: keyof TenantBrandingForm, value: string) => {
    if (form) updateForm('branding', { ...form.branding, [key]: value });
  };

  const checklist = useMemo(() => {
    const school = form?.schoolInfo || {};
    const legalReady = Boolean((school.legalName || school.name) && isValidCnpj(school.cnpj || '')
      && school.address && school.email && school.phone && school.city && /^[A-Za-z]{2}$/.test(school.state || '')
      && (school.legalRepresentativeName || school.directorName));
    return [
      { label: 'Identidade jurídica', ready: legalReady, section: 'identity' as SectionId },
      { label: 'Assinatura do representante', ready: isTenantSignaturePath(school.legalRepresentativeSignaturePath || '', snapshot?.tenant.id || '') && Boolean(school.legalRepresentativeSignatureUrl), section: 'identity' as SectionId },
      { label: 'Marca publicada', ready: Boolean(form?.branding.logoUrl), section: 'branding' as SectionId },
      { label: 'Portal personalizado', ready: Boolean(form?.slug), section: 'portal' as SectionId },
      { label: 'Preferências registradas', ready: Boolean(form?.studentNotificationsEnabled && form.teacherNotificationsEnabled), section: 'operations' as SectionId },
      { label: 'Primeira credencial preparada', ready: Boolean(snapshot?.integrations.some((item) => item.configured)), section: 'integrations' as SectionId },
    ];
  }, [form, snapshot]);
  const completion = Math.round((checklist.filter((item) => item.ready).length / checklist.length) * 100);

  const save = async () => {
    if (!form || !snapshot) return;
    setSaving(true); setNotice(null);
    try {
      const payload: TenantSettingsForm = {
        ...form,
        slug: form.slug.trim() || deriveSlug(snapshot),
      };
      await tenantSettingsService.save(snapshot.settings.version, payload);
      clearTenantCache();
      clearSchoolInfoCache(snapshot.tenant.id);
      onUpdate({ ...form.branding });
      setNotice({ type: 'success', message: 'Configurações registradas com segurança.' });
      await load(true);
    } catch (error) { setNotice({ type: 'error', message: friendlyError(error) }); }
    finally { setSaving(false); }
  };

  const validateImage = async (file: File, kind: BrandingUploadKind) => {
    const allowed = kind === 'favicon' ? ['image/png', 'image/x-icon'] : ['image/png', 'image/jpeg', 'image/webp'];
    const maxBytes = kind === 'favicon' ? 512 * 1024 : kind === 'signature' ? 1024 * 1024 : 2 * 1024 * 1024;
    if (!allowed.includes(file.type)) throw new Error('Formato não permitido para este arquivo.');
    if (file.size > maxBytes) throw new Error(kind === 'favicon' ? 'O ícone deve ter até 512 KB.' : kind === 'signature' ? 'A assinatura deve ter até 1 MB.' : 'A logo deve ter até 2 MB.');
    if (file.type !== 'image/x-icon') {
      const bitmap = await createImageBitmap(file);
      try {
        if (bitmap.width < 32 || bitmap.height < 32 || bitmap.width > 4096 || bitmap.height > 4096) throw new Error('Use uma imagem entre 32 e 4096 pixels.');
        if (kind === 'favicon' && bitmap.width !== bitmap.height) throw new Error('O favicon precisa ser quadrado.');
      } finally { bitmap.close(); }
    }
  };

  const uploadBranding = async (kind: BrandingUploadKind, file: File) => {
    if (!snapshot) return;
    setUploading(kind); setNotice(null);
    try {
      await validateImage(file, kind);
      const extension = file.type === 'image/jpeg' ? 'jpg' : file.type === 'image/x-icon' ? 'ico' : file.type.split('/')[1];
      const folder = kind === 'signature' ? 'legal-representative-signature' : kind;
      const bucket = kind === 'signature' ? 'tenant-legal-assets' : 'tenant-public-branding';
      const path = `${snapshot.tenant.id}/${folder}/${crypto.randomUUID()}.${extension}`;
      const { error } = await supabase.storage.from(bucket).upload(path, file, {
        upsert: false,
        cacheControl: kind === 'signature' ? '3600' : '31536000',
        contentType: file.type,
      });
      if (error) throw error;
      if (!form) return;
      if (kind === 'signature') {
        const currentUrl = form.schoolInfo?.legalRepresentativeSignatureUrl || '';
        if (currentUrl.startsWith('blob:')) URL.revokeObjectURL(currentUrl);
        updateForm('schoolInfo', {
          ...(form.schoolInfo || EMPTY_SCHOOL),
          legalRepresentativeSignaturePath: path,
          legalRepresentativeSignatureUrl: URL.createObjectURL(file),
        });
      } else {
        const { data } = supabase.storage.from(bucket).getPublicUrl(path);
        updateForm('branding', { ...form.branding,
          [kind === 'logo' ? 'logoPath' : 'faviconPath']: path,
          [kind === 'logo' ? 'logoUrl' : 'faviconUrl']: data.publicUrl,
        });
      }
      setNotice({ type: 'info', message: 'Arquivo enviado. Publique as alterações para ativá-lo.' });
    } catch (error) { setNotice({ type: 'error', message: friendlyError(error) }); }
    finally { setUploading(null); }
  };

  const requestDomain = async () => {
    if (!domainDraft.trim()) return;
    setDomainBusy('request'); setNotice(null);
    try {
      await tenantSettingsService.requestDomain(domainDraft.trim());
      setNotice({ type: 'success', message: 'Domínio reservado. Configure os dois registros DNS exibidos abaixo.' });
      await load(true);
    } catch (error) { setNotice({ type: 'error', message: friendlyError(error) }); }
    finally { setDomainBusy(null); }
  };
  const verifyDomain = async () => {
    setDomainBusy('verify'); setNotice(null);
    try {
      await tenantSettingsService.verifyDomain();
      setNotice({ type: 'success', message: 'TXT e CNAME confirmados. O DNS está validado; tráfego e TLS ainda dependem da infraestrutura.' });
      await load(true);
    } catch (error) { setNotice({ type: 'error', message: friendlyError(error) }); }
    finally { setDomainBusy(null); }
  };

  const saveCredential = async (provider: TenantIntegrationProvider) => {
    const secret = credentialDrafts[provider].trim();
    if (!secret) return;
    setCredentialBusy(provider); setNotice(null);
    try {
      await tenantSettingsService.setSecret(provider, secret, credentialEnvironments[provider]);
      setCredentialDrafts((current) => ({ ...current, [provider]: '' }));
      setNotice({ type: 'success', message: `${PROVIDER_LABELS[provider].name}: credencial validada e guardada. O runtime atual não foi alterado.` });
      await load(true);
    } catch (error) { setNotice({ type: 'error', message: friendlyError(error) }); }
    finally { setCredentialBusy(null); }
  };
  const deleteCredential = async (provider: TenantIntegrationProvider) => {
    if (!window.confirm(`Remover a credencial ${PROVIDER_LABELS[provider].name} desta escola?`)) return;
    setCredentialBusy(provider); setNotice(null);
    try {
      await tenantSettingsService.deleteSecret(provider);
      setNotice({ type: 'success', message: 'Credencial removida do cofre.' });
      await load(true);
    } catch (error) { setNotice({ type: 'error', message: friendlyError(error) }); }
    finally { setCredentialBusy(null); }
  };

  if (loading && !snapshot) return <LoadingCard />;
  if (!snapshot || !form) return <UnavailableCard message={notice?.message} reload={() => void load()} />;

  return (
    <div className="space-y-5 pb-28 animate-in fade-in duration-300">
      <header className="flex flex-col gap-4 rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-tenant-primary/10 text-tenant-primary"><School size={24} /></div>
          <div><div className="flex flex-wrap items-center gap-2"><h1 className="text-xl font-black text-brand-text">Central da escola</h1><span className="rounded-full bg-emerald-500/10 px-2.5 py-1 text-[9px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-300">Tenant isolado</span></div><p className="mt-1 text-xs text-brand-muted">Identidade, operação, domínio, integrações e segurança em um só lugar.</p></div>
        </div>
        <div className="flex items-center gap-3">
          <div className="min-w-[150px] rounded-2xl bg-brand-surface-2 px-4 py-3"><div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-brand-muted"><span>Implantação</span><span>{completion}%</span></div><div className="mt-2 h-2 overflow-hidden rounded-full bg-brand-border"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${completion}%` }} /></div></div>
          <button onClick={() => void load()} disabled={loading} title="Recarregar" className="rounded-xl border border-brand-border p-3 text-brand-muted hover:text-brand-text disabled:opacity-50"><RefreshCw size={17} className={loading ? 'animate-spin' : ''} /></button>
        </div>
      </header>
      {notice && <NoticeBanner notice={notice} onClose={() => setNotice(null)} />}
      <div className="grid gap-5 lg:grid-cols-[240px,minmax(0,1fr)]">
        <aside className="h-fit rounded-3xl border border-brand-border bg-brand-surface p-2 lg:sticky lg:top-20">
          <nav aria-label="Seções das configurações" className="space-y-1">
            {SECTION_ITEMS.map((item) => { const Icon = item.icon; const active = section === item.id; return (
              <button key={item.id} onClick={() => setSection(item.id)} className={`flex w-full items-center gap-3 rounded-2xl px-3 py-3 text-left transition-colors ${active ? 'bg-tenant-primary text-white shadow-sm' : 'text-brand-muted hover:bg-brand-surface-2 hover:text-brand-text'}`}>
                <Icon size={17} className="shrink-0" /><span className="min-w-0 flex-1"><span className="block text-xs font-black">{item.label}</span><span className={`block truncate text-[10px] ${active ? 'text-white/70' : 'text-brand-muted'}`}>{item.description}</span></span><ChevronRight size={13} className="shrink-0 opacity-60" />
              </button>); })}
          </nav>
        </aside>
        <main className="min-w-0">
          {section === 'overview' && <OverviewSection checklist={checklist} completion={completion} snapshot={snapshot} onSection={setSection} />}
          {section === 'identity' && <IdentitySection form={form} updateSchool={updateSchool} updateName={(value) => updateForm('name', value)} uploadingSignature={uploading === 'signature'} signatureInputRef={signatureInputRef} uploadSignature={(file) => void uploadBranding('signature', file)} />}
          {section === 'branding' && <BrandingSection form={form} uploading={uploading} logoInputRef={logoInputRef} faviconInputRef={faviconInputRef} updateBranding={updateBranding} uploadBranding={uploadBranding} />}
          {section === 'portal' && <PortalSection form={form} snapshot={snapshot} domainDraft={domainDraft} domainBusy={domainBusy} setDomainDraft={setDomainDraft} updateSlug={(value) => updateForm('slug', value.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40))} requestDomain={requestDomain} verifyDomain={verifyDomain} />}
          {section === 'operations' && <OperationsSection form={form} updateForm={updateForm} />}
          {section === 'integrations' && <IntegrationsSection integrations={snapshot.integrations} drafts={credentialDrafts} environments={credentialEnvironments} busy={credentialBusy} setDraft={(provider, value) => setCredentialDrafts((current) => ({ ...current, [provider]: value }))} setEnvironment={(provider, value) => setCredentialEnvironments((current) => ({ ...current, [provider]: value }))} save={saveCredential} remove={deleteCredential} />}
          {section === 'security' && <SecuritySection snapshot={snapshot} />}
        </main>
      </div>
      {section !== 'overview' && section !== 'integrations' && section !== 'security' && (
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-brand-border bg-brand-surface/95 px-4 py-3 shadow-2xl backdrop-blur">
          <div className="mx-auto flex max-w-5xl items-center justify-between gap-4"><div><p className="text-xs font-black text-brand-text">{dirty ? 'Alterações ainda não publicadas' : 'Tudo está salvo'}</p><p className="text-[10px] text-brand-muted">Versão {snapshot.settings.version} · publicação com auditoria</p></div><button onClick={save} disabled={!dirty || saving} className="flex items-center gap-2 rounded-xl bg-tenant-primary px-5 py-3 text-xs font-black uppercase tracking-wider text-white shadow-lg disabled:cursor-not-allowed disabled:opacity-40">{saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}{saving ? 'Publicando…' : 'Publicar alterações'}</button></div>
        </div>
      )}
    </div>
  );
};

const LoadingCard = () => <div className="flex min-h-[420px] items-center justify-center rounded-3xl border border-brand-border bg-brand-surface"><div className="text-center"><Loader2 className="mx-auto mb-3 animate-spin text-tenant-primary" size={30} /><p className="text-sm font-bold text-brand-text">Carregando a central segura…</p></div></div>;
const UnavailableCard: React.FC<{ message?: string; reload: () => void }> = ({ message, reload }) => <div className="rounded-3xl border border-rose-200 bg-rose-50 p-8 text-center dark:border-rose-900/40 dark:bg-rose-950/20"><XCircle className="mx-auto mb-3 text-rose-500" size={30} /><h2 className="font-black text-rose-800 dark:text-rose-200">Central indisponível</h2><p className="mt-1 text-sm text-rose-600 dark:text-rose-300">{message}</p><button onClick={reload} className="mt-5 rounded-xl bg-rose-600 px-5 py-2 text-xs font-black uppercase text-white">Tentar novamente</button></div>;

const NoticeBanner: React.FC<{ notice: NonNullable<Notice>; onClose: () => void }> = ({ notice, onClose }) => {
  const style = notice.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200' : notice.type === 'error' ? 'border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900/40 dark:bg-rose-950/20 dark:text-rose-200' : 'border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-900/40 dark:bg-blue-950/20 dark:text-blue-200';
  const Icon = notice.type === 'success' ? CheckCircle2 : notice.type === 'error' ? XCircle : BellRing;
  return <div role={notice.type === 'error' ? 'alert' : 'status'} className={`flex items-center gap-3 rounded-2xl border px-4 py-3 text-xs font-bold ${style}`}><Icon size={17} className="shrink-0" /><span className="flex-1">{notice.message}</span><button onClick={onClose} aria-label="Fechar aviso" className="opacity-60 hover:opacity-100"><XCircle size={15} /></button></div>;
};
const Card: React.FC<React.PropsWithChildren<{ className?: string }>> = ({ children, className = '' }) => <section className={`rounded-3xl border border-brand-border bg-brand-surface p-5 shadow-sm sm:p-6 ${className}`}>{children}</section>;
const SectionTitle: React.FC<{ icon: React.ElementType; title: string; description: string }> = ({ icon: Icon, title, description }) => <div className="mb-6 flex items-start gap-3"><div className="rounded-xl bg-tenant-primary/10 p-2.5 text-tenant-primary"><Icon size={19} /></div><div><h2 className="font-black text-brand-text">{title}</h2><p className="mt-0.5 text-xs text-brand-muted">{description}</p></div></div>;
const Field: React.FC<{ label: string; value: string | number; onChange: (value: string) => void; type?: string; placeholder?: string; hint?: string; maxLength?: number }> = ({ label, value, onChange, type = 'text', placeholder, hint, maxLength }) => <label className="block space-y-1.5"><span className="text-[10px] font-black uppercase tracking-widest text-brand-muted">{label}</span><input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} maxLength={maxLength} className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-sm text-brand-text outline-none transition focus:border-tenant-primary focus:ring-2 focus:ring-tenant-primary/15" />{hint && <span className="block text-[10px] leading-relaxed text-brand-muted">{hint}</span>}</label>;
const Toggle: React.FC<{ checked: boolean; onChange: (checked: boolean) => void; label: string; description: string }> = ({ checked, onChange, label, description }) => <label className="flex cursor-pointer items-center justify-between gap-4 rounded-2xl border border-brand-border bg-brand-surface-2 p-4"><span><span className="block text-xs font-black text-brand-text">{label}</span><span className="mt-0.5 block text-[10px] text-brand-muted">{description}</span></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} className="h-5 w-5 rounded border-brand-border text-tenant-primary focus:ring-tenant-primary" /></label>;

const OverviewSection: React.FC<{ checklist: Array<{ label: string; ready: boolean; section: SectionId }>; completion: number; snapshot: TenantSettingsSnapshot; onSection: (section: SectionId) => void }> = ({ checklist, completion, snapshot, onSection }) => (
  <div className="space-y-5"><Card><SectionTitle icon={BadgeCheck} title="Implantação guiada" description="Complete os dados preparatórios antes de ativar cada recurso no runtime." /><div className="grid gap-3 sm:grid-cols-2">{checklist.map((item) => <button key={item.label} onClick={() => onSection(item.section)} className="flex items-center gap-3 rounded-2xl border border-brand-border bg-brand-surface-2 p-4 text-left hover:border-tenant-primary/40">{item.ready ? <CheckCircle2 size={19} className="shrink-0 text-emerald-500" /> : <Circle size={19} className="shrink-0 text-amber-500" />}<span className="flex-1 text-xs font-bold text-brand-text">{item.label}</span><ChevronRight size={14} className="text-brand-muted" /></button>)}</div><p className="mt-4 text-[11px] text-brand-muted">{completion === 100 ? 'Os dados preparatórios estão completos; integrações e automações exigem ativação própria.' : 'Itens incompletos não alteram o isolamento entre escolas.'}</p></Card><div className="grid gap-4 md:grid-cols-3"><SummaryCard icon={Users} label="Limite de alunos" value={String(snapshot.tenant.studentLimit || '—')} /><SummaryCard icon={School} label="Limite de professores" value={String(snapshot.tenant.teacherLimit || '—')} /><SummaryCard icon={WalletCards} label="Assinatura" value={snapshot.tenant.subscriptionStatus || 'Não informada'} /></div><Card><SectionTitle icon={ShieldCheck} title="Proteções ativas" description="A central não confia em identificadores enviados pelo navegador." /><div className="grid gap-3 sm:grid-cols-2">{['Tenant derivado da associação ativa', 'Credenciais write-only no Supabase Vault', 'Branding público com gestão isolada por pasta', 'Alterações versionadas e auditadas'].map((label) => <div key={label} className="flex items-center gap-2 rounded-xl bg-emerald-500/5 px-3 py-2.5 text-xs font-bold text-emerald-700 dark:text-emerald-300"><Check size={14} />{label}</div>)}</div></Card></div>
);
const SummaryCard: React.FC<{ icon: React.ElementType; label: string; value: string }> = ({ icon: Icon, label, value }) => <Card className="!p-4"><div className="flex items-center gap-3"><div className="rounded-xl bg-brand-surface-2 p-2 text-tenant-primary"><Icon size={18} /></div><div><p className="text-[9px] font-black uppercase tracking-widest text-brand-muted">{label}</p><p className="mt-0.5 text-sm font-black text-brand-text">{value}</p></div></div></Card>;

const IdentitySection: React.FC<{ form: TenantSettingsForm; updateSchool: (key: keyof TenantSchoolInfo, value: string) => void; updateName: (value: string) => void; uploadingSignature: boolean; signatureInputRef: React.RefObject<HTMLInputElement | null>; uploadSignature: (file: File) => void }> = ({ form, updateSchool, updateName, uploadingSignature, signatureInputRef, uploadSignature }) => {
  const school = form.schoolInfo || EMPTY_SCHOOL;
  return <div className="space-y-5"><Card><SectionTitle icon={Building2} title="Identidade da escola" description="Esses dados alimentam contratos e não são publicados no resolver anônimo." /><div className="grid gap-4 sm:grid-cols-2"><Field label="Nome exibido no sistema" value={form.name} onChange={updateName} maxLength={120} /><Field label="Razão social" value={school.legalName || school.name || ''} onChange={(value) => updateSchool('legalName', value)} maxLength={160} /><Field label="CNPJ" value={school.cnpj || ''} onChange={(value) => updateSchool('cnpj', normalizeCnpj(value))} placeholder="00.000.000/0000-00" /><Field label="E-mail institucional" value={school.email || ''} onChange={(value) => updateSchool('email', value)} type="email" maxLength={160} /><Field label="Telefone institucional" value={school.phone || ''} onChange={(value) => updateSchool('phone', normalizePhone(value))} /><Field label="Contato de privacidade (LGPD)" value={school.privacyContactEmail || ''} onChange={(value) => updateSchool('privacyContactEmail', value)} type="email" maxLength={160} /></div><div className="mt-4 grid gap-4 sm:grid-cols-[1fr,140px,90px]"><Field label="Endereço jurídico completo" value={school.address || ''} onChange={(value) => updateSchool('address', value)} maxLength={300} /><Field label="Cidade" value={school.city || ''} onChange={(value) => updateSchool('city', value)} maxLength={120} /><Field label="UF" value={school.state || ''} onChange={(value) => updateSchool('state', value.replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 2))} maxLength={2} /></div></Card><Card><SectionTitle icon={BadgeCheck} title="Representante legal" description="Nunca usamos nome, assinatura ou dados jurídicos da plataforma como fallback." /><div className="grid gap-4 sm:grid-cols-2"><Field label="Nome do representante" value={school.legalRepresentativeName || school.directorName || ''} onChange={(value) => updateSchool('legalRepresentativeName', value)} maxLength={160} /><div><input ref={signatureInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) uploadSignature(file); event.currentTarget.value = ''; }} /><BrandUpload title="Assinatura do representante" hint="PNG, JPG ou WebP · até 1 MB · arquivo privado com prévia temporária" imageUrl={school.legalRepresentativeSignatureUrl || ''} busy={uploadingSignature} onClick={() => signatureInputRef.current?.click()} compact /></div></div><div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-xs text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200">A assinatura fica em armazenamento privado. O sistema libera uma visualização temporária somente nos fluxos autorizados de contrato.</div><div className="mt-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">Contratos ficam bloqueados para aceite e impressão enquanto a identidade jurídica ou assinatura estiver incompleta.</div></Card></div>;
};

const BrandingSection: React.FC<{ form: TenantSettingsForm; uploading: 'logo' | 'favicon' | null; logoInputRef: React.RefObject<HTMLInputElement | null>; faviconInputRef: React.RefObject<HTMLInputElement | null>; updateBranding: (key: keyof TenantBrandingForm, value: string) => void; uploadBranding: (kind: 'logo' | 'favicon', file: File) => void }> = ({ form, uploading, logoInputRef, faviconInputRef, updateBranding, uploadBranding }) => (
  <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr),320px]"><div className="space-y-5"><Card><SectionTitle icon={Palette} title="Cores da marca" description="Aplicadas no portal, botões e destaques da escola." /><div className="grid gap-5 sm:grid-cols-2">{(['primaryColor', 'secondaryColor'] as const).map((key) => <label key={key} className="space-y-2"><span className="text-[10px] font-black uppercase tracking-widest text-brand-muted">{key === 'primaryColor' ? 'Cor principal' : 'Cor secundária'}</span><div className="flex items-center gap-3 rounded-2xl border border-brand-border bg-brand-surface-2 p-3"><input type="color" value={form.branding[key]} onChange={(event) => updateBranding(key, event.target.value)} className="h-11 w-14 cursor-pointer rounded-xl border-0 bg-transparent" /><input value={form.branding[key]} onChange={(event) => updateBranding(key, event.target.value.toUpperCase())} maxLength={7} className="min-w-0 flex-1 bg-transparent font-mono text-sm font-bold uppercase text-brand-text outline-none" /></div></label>)}</div></Card><Card><SectionTitle icon={ImageIcon} title="Arquivos da marca" description="Gestão isolada por pasta; arquivos publicados ficam acessíveis por URL pública." /><div className="grid gap-4 sm:grid-cols-2"><BrandUpload title="Logo principal" hint="PNG, JPG ou WebP · até 2 MB" imageUrl={form.branding.logoUrl} busy={uploading === 'logo'} onClick={() => logoInputRef.current?.click()} /><BrandUpload title="Favicon" hint="PNG ou ICO quadrado · até 512 KB" imageUrl={form.branding.faviconUrl} busy={uploading === 'favicon'} onClick={() => faviconInputRef.current?.click()} compact /><input ref={logoInputRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadBranding('logo', file); event.currentTarget.value = ''; }} /><input ref={faviconInputRef} type="file" accept="image/png,image/x-icon" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) void uploadBranding('favicon', file); event.currentTarget.value = ''; }} /></div></Card></div><Card className="h-fit xl:sticky xl:top-20"><SectionTitle icon={Eye} title="Prévia" description="Visualização aproximada do portal." /><div className="overflow-hidden rounded-3xl border-4 border-slate-900 bg-slate-100 shadow-xl dark:bg-slate-950"><div className="flex h-14 items-center gap-3 bg-white px-4 dark:bg-slate-900">{form.branding.logoUrl ? <img src={form.branding.logoUrl} alt="Logo da escola" className="max-h-8 max-w-[130px] object-contain" /> : <div className="h-7 w-24 rounded bg-slate-200 dark:bg-slate-700" />}</div><div className="space-y-4 p-5"><div className="h-4 w-2/3 rounded" style={{ backgroundColor: form.branding.primaryColor }} /><div className="rounded-2xl bg-white p-4 shadow-sm dark:bg-slate-900"><div className="mb-3 h-2 rounded bg-slate-200 dark:bg-slate-700" /><div className="mb-5 h-2 w-3/4 rounded bg-slate-200 dark:bg-slate-700" /><div className="rounded-xl py-3 text-center text-[10px] font-black uppercase text-white" style={{ backgroundColor: form.branding.primaryColor }}>Continuar</div></div><div className="ml-auto h-10 w-10 rounded-full shadow-lg" style={{ backgroundColor: form.branding.secondaryColor }} /></div></div></Card></div>
);
const BrandUpload: React.FC<{ title: string; hint: string; imageUrl: string; busy: boolean; onClick: () => void; compact?: boolean }> = ({ title, hint, imageUrl, busy, onClick, compact }) => <button type="button" onClick={onClick} disabled={busy} className="flex min-h-[170px] flex-col items-center justify-center rounded-2xl border-2 border-dashed border-brand-border bg-brand-surface-2 p-5 text-center hover:border-tenant-primary disabled:opacity-50">{busy ? <Loader2 className="animate-spin text-tenant-primary" size={25} /> : imageUrl ? <img src={imageUrl} alt={title} className={`${compact ? 'h-12 w-12' : 'h-20 max-w-[220px]'} object-contain`} /> : <UploadCloud className="text-brand-muted" size={28} />}<span className="mt-3 text-xs font-black text-brand-text">{title}</span><span className="mt-1 text-[10px] text-brand-muted">{hint}</span></button>;

const PortalSection: React.FC<{ form: TenantSettingsForm; snapshot: TenantSettingsSnapshot; domainDraft: string; domainBusy: 'request' | 'verify' | null; setDomainDraft: (value: string) => void; updateSlug: (value: string) => void; requestDomain: () => void; verifyDomain: () => void }> = ({ form, snapshot, domainDraft, domainBusy, setDomainDraft, updateSlug, requestDomain, verifyDomain }) => (
  <div className="space-y-5"><Card><SectionTitle icon={Globe2} title="Endereço Wise Wolf" description="Subdomínio imediato e exclusivo da escola." /><div className="flex flex-col gap-3 sm:flex-row"><div className="flex flex-1 overflow-hidden rounded-xl border border-brand-border bg-brand-surface-2 focus-within:border-tenant-primary"><span className="border-r border-brand-border px-3 py-3 text-xs text-brand-muted">https://</span><input value={form.slug} onChange={(event) => updateSlug(event.target.value)} className="min-w-0 flex-1 bg-transparent px-3 py-3 text-sm font-bold text-brand-text outline-none" /><span className="border-l border-brand-border px-3 py-3 text-xs text-brand-muted">.{BASE_DOMAIN}</span></div><CopyButton value={`https://${form.slug}.${BASE_DOMAIN}`} /></div><p className="mt-2 text-[10px] text-brand-muted">A alteração só entra em vigor ao publicar.</p></Card><Card><SectionTitle icon={Globe2} title="Domínio próprio" description="Esta etapa valida TXT e CNAME; ela não provisiona tráfego nem certificado TLS." /><div className="flex flex-col gap-3 sm:flex-row"><input value={domainDraft} onChange={(event) => setDomainDraft(event.target.value.toLowerCase().trim())} placeholder="portal.suaescola.com.br" className="min-w-0 flex-1 rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-3 text-sm text-brand-text outline-none focus:border-tenant-primary" /><button onClick={requestDomain} disabled={!domainDraft || domainBusy !== null} className="flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-5 py-3 text-xs font-black uppercase text-white disabled:opacity-50">{domainBusy === 'request' && <Loader2 size={14} className="animate-spin" />}Preparar DNS</button></div>{snapshot.tenant.customDomain && snapshot.tenant.customDomainDnsToken && <div className="mt-5 space-y-3 rounded-2xl border border-brand-border bg-brand-surface-2 p-4"><DnsRow type="TXT" name={`_wisewolf-verify.${snapshot.tenant.customDomain}`} value={snapshot.tenant.customDomainDnsToken} /><DnsRow type="CNAME" name={snapshot.tenant.customDomain} value={snapshot.dns.cnameTarget} /><div className="flex flex-wrap items-center justify-between gap-3 pt-2"><span className={`flex items-center gap-2 text-xs font-black ${snapshot.tenant.customDomainVerified ? 'text-emerald-600' : 'text-amber-600'}`}>{snapshot.tenant.customDomainVerified ? <CheckCircle2 size={16} /> : <Circle size={16} />}{snapshot.tenant.customDomainVerified ? 'DNS verificado' : 'Aguardando os dois registros DNS'}</span>{!snapshot.tenant.customDomainVerified && <button onClick={verifyDomain} disabled={domainBusy !== null} className="flex items-center gap-2 rounded-xl bg-emerald-600 px-4 py-2.5 text-xs font-black uppercase text-white disabled:opacity-50">{domainBusy === 'verify' && <Loader2 size={14} className="animate-spin" />}Verificar DNS</button>}</div></div>}</Card></div>
);
const CopyButton: React.FC<{ value: string }> = ({ value }) => { const [copied, setCopied] = useState(false); return <button onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="flex items-center justify-center gap-2 rounded-xl border border-brand-border px-4 py-3 text-xs font-bold text-brand-muted hover:text-brand-text">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? 'Copiado' : 'Copiar'}</button>; };
const DnsRow: React.FC<{ type: string; name: string; value: string }> = ({ type, name, value }) => <div className="grid gap-2 rounded-xl border border-brand-border bg-brand-surface p-3 sm:grid-cols-[70px,minmax(0,1fr),minmax(0,1fr),auto] sm:items-center"><span className="text-[10px] font-black text-violet-600">{type}</span><code className="truncate text-[10px] text-brand-text">{name}</code><code className="truncate text-[10px] text-brand-muted">{value}</code><CopyButton value={value} /></div>;

const OperationsSection: React.FC<{ form: TenantSettingsForm; updateForm: <K extends keyof TenantSettingsForm>(key: K, value: TenantSettingsForm[K]) => void }> = ({ form, updateForm }) => (
  <div className="space-y-5"><Card><SectionTitle icon={CloudCog} title="Padrões operacionais" description="Preferências registradas para adoção progressiva pelas rotinas da escola." /><div className="grid gap-4 sm:grid-cols-2"><Field label="Duração padrão da aula (minutos)" value={form.defaultLessonDurationMinutes} onChange={(value) => updateForm('defaultLessonDurationMinutes', Math.max(15, Math.min(240, Number(value) || 15)))} type="number" /><Field label="Dia de fechamento financeiro" value={form.financialCutoffDay} onChange={(value) => updateForm('financialCutoffDay', Math.max(1, Math.min(28, Number(value) || 1)))} type="number" hint="Preferência entre os dias 1 e 28; cada fluxo deve ser integrado antes de aplicá-la." /><label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Fuso horário</span><select value={form.timezone} onChange={(event) => updateForm('timezone', event.target.value)} className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-sm text-brand-text outline-none"><option value="America/Sao_Paulo">Brasília</option><option value="America/Manaus">Manaus</option><option value="America/Cuiaba">Cuiabá</option><option value="America/Rio_Branco">Rio Branco</option><option value="America/Fortaleza">Fortaleza</option></select></label><label className="space-y-1.5"><span className="text-[10px] font-black uppercase tracking-widest text-brand-muted">Início da semana</span><select value={form.weekStartsOn} onChange={(event) => updateForm('weekStartsOn', Number(event.target.value))} className="w-full rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-sm text-brand-text outline-none"><option value={0}>Domingo</option><option value={1}>Segunda-feira</option></select></label></div></Card><Card><SectionTitle icon={BellRing} title="Preferências de comunicação" description="Registro preparatório; não funciona ainda como bloqueio global dos disparos." /><div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">Estas opções não interrompem automaticamente rotinas já existentes. A ativação será indicada quando todos os emissores estiverem integrados.</div><div className="space-y-3"><Toggle checked={form.whatsappEnabled} onChange={(value) => updateForm('whatsappEnabled', value)} label="Preferência para WhatsApp" description="Registra a intenção da escola, sem prometer bloqueio do runtime atual." /><Toggle checked={form.studentNotificationsEnabled} onChange={(value) => updateForm('studentNotificationsEnabled', value)} label="Preferência para alunos" description="Registra a preferência para futuras integrações de comunicação." /><Toggle checked={form.teacherNotificationsEnabled} onChange={(value) => updateForm('teacherNotificationsEnabled', value)} label="Preferência para professores" description="Registra a preferência para futuras integrações de comunicação." /></div></Card></div>
);

const IntegrationsSection: React.FC<{ integrations: TenantIntegrationStatus[]; drafts: Record<TenantIntegrationProvider, string>; environments: Record<TenantIntegrationProvider, 'sandbox' | 'production'>; busy: TenantIntegrationProvider | null; setDraft: (provider: TenantIntegrationProvider, value: string) => void; setEnvironment: (provider: TenantIntegrationProvider, value: 'sandbox' | 'production') => void; save: (provider: TenantIntegrationProvider) => void; remove: (provider: TenantIntegrationProvider) => void }> = ({ integrations, drafts, environments, busy, setDraft, setEnvironment, save, remove }) => (
  <div className="space-y-5"><Card><SectionTitle icon={LockKeyhole} title="Cofre de credenciais" description="A chave é validada e guardada para uma ativação posterior e controlada no runtime." /><div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200"><strong>Preparação, não ativação:</strong> guardar uma chave aqui não substitui automaticamente a credencial usada pelos fluxos atuais. O valor continua write-only e nunca volta ao navegador.</div></Card>{integrations.map((integration) => { const config = PROVIDER_LABELS[integration.provider]; const isBusy = busy === integration.provider; return <Card key={integration.provider}><div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between"><div className="flex items-start gap-3"><div className="rounded-xl bg-brand-surface-2 p-2.5 text-tenant-primary"><KeyRound size={18} /></div><div><div className="flex flex-wrap items-center gap-2"><h3 className="font-black text-brand-text">{config.name}</h3><IntegrationBadge integration={integration} /></div><p className="mt-1 text-xs text-brand-muted">{config.description}</p>{integration.configured && <p className="mt-2 text-[10px] font-bold text-brand-muted">Final •••• {integration.secretLastFour} · {integration.environment} · validada {formatDate(integration.lastValidatedAt)}</p>}</div></div>{integration.configured && <button onClick={() => remove(integration.provider)} disabled={isBusy} className="flex items-center gap-2 self-start rounded-xl border border-rose-200 px-3 py-2 text-[10px] font-black uppercase text-rose-600 disabled:opacity-50"><Trash2 size={13} />Remover</button>}</div><div className="mt-5 grid gap-3 md:grid-cols-[150px,minmax(0,1fr),auto]">{integration.provider === 'asaas' ? <select value={environments.asaas} onChange={(event) => setEnvironment('asaas', event.target.value as 'sandbox' | 'production')} className="rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-sm text-brand-text"><option value="sandbox">Sandbox</option><option value="production">Produção</option></select> : <div className="flex items-center rounded-xl border border-brand-border bg-brand-surface-2 px-3 text-xs font-bold text-brand-muted">Produção</div>}<input type="password" autoComplete="new-password" value={drafts[integration.provider]} onChange={(event) => setDraft(integration.provider, event.target.value)} placeholder={integration.configured ? 'Cole uma nova chave para substituir a preparada' : config.placeholder} className="min-w-0 rounded-xl border border-brand-border bg-brand-surface-2 px-3 py-2.5 text-sm text-brand-text outline-none focus:border-tenant-primary" /><button onClick={() => save(integration.provider)} disabled={!drafts[integration.provider].trim() || isBusy} className="flex items-center justify-center gap-2 rounded-xl bg-tenant-primary px-5 py-2.5 text-xs font-black uppercase text-white disabled:opacity-50">{isBusy ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}{integration.configured ? 'Validar e substituir' : 'Validar e guardar'}</button></div></Card>; })}</div>
);
const IntegrationBadge: React.FC<{ integration: TenantIntegrationStatus }> = ({ integration }) => integration.configured ? <span className="rounded-full bg-amber-500/10 px-2 py-1 text-[9px] font-black uppercase text-amber-700 dark:text-amber-300">Preparada</span> : <span className="rounded-full bg-slate-500/10 px-2 py-1 text-[9px] font-black uppercase text-brand-muted">Não preparada</span>;

const SecuritySection: React.FC<{ snapshot: TenantSettingsSnapshot }> = ({ snapshot }) => <div className="space-y-5"><Card><SectionTitle icon={ShieldCheck} title="Isolamento e proteção" description="Controles efetivos desta central administrativa." /><div className="grid gap-3 sm:grid-cols-2"><SecurityItem title="Autoridade do tenant" description="Associação ativa e plano vigente, resolvidos no servidor" /><SecurityItem title="Cofre de segredos" description="Supabase Vault, sem leitura pelo cliente" /><SecurityItem title="Logo e favicon" description={`Públicos; gestão em ${snapshot.security.brandingNamespace}`} /><SecurityItem title="Assinatura jurídica" description={`Privada; URL curta em ${snapshot.security.legalAssetNamespace}`} /><SecurityItem title="Concorrência" description={`Versão atual ${snapshot.settings.version}`} /></div></Card><Card><SectionTitle icon={Activity} title="Histórico de configurações" description="Eventos sem credenciais, mensagens ou respostas cruas de provedores." />{snapshot.audit.length === 0 ? <p className="rounded-2xl bg-brand-surface-2 p-5 text-center text-xs text-brand-muted">Nenhuma alteração registrada ainda.</p> : <div className="divide-y divide-brand-border">{snapshot.audit.map((entry) => <AuditRow key={entry.id} entry={entry} />)}</div>}</Card></div>;
const SecurityItem: React.FC<{ title: string; description: string }> = ({ title, description }) => <div className="flex items-start gap-3 rounded-2xl border border-brand-border bg-brand-surface-2 p-4"><CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-500" /><div><p className="text-xs font-black text-brand-text">{title}</p><p className="mt-0.5 break-all text-[10px] text-brand-muted">{description}</p></div></div>;
const AuditRow: React.FC<{ entry: TenantSettingsAuditEntry }> = ({ entry }) => { const labels: Record<string, string> = { settings_published: 'Configurações registradas', credential_configured: 'Credencial preparada', credential_rotated: 'Credencial preparada substituída', credential_removed: 'Credencial preparada removida', custom_domain_requested: 'DNS solicitado', custom_domain_verified: 'DNS verificado' }; return <div className="flex items-start gap-3 py-3"><div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-tenant-primary" /><div className="min-w-0 flex-1"><p className="text-xs font-bold text-brand-text">{labels[entry.action] || entry.action}</p><p className="text-[10px] text-brand-muted">{entry.actor_role} · {entry.section}</p></div><time className="shrink-0 text-[10px] text-brand-muted">{formatDate(entry.created_at)}</time></div>; };
function formatDate(value: string | null) { if (!value) return '—'; return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value)); }

export default TenantSettings;
