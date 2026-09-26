import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, RefreshCw, Video } from 'lucide-react';
import { googleMeetAction } from '../lib/googleMeet';

export default function GoogleMeetSettings({ tenantId }: { tenantId?: string }) {
  const [status,setStatus] = useState<any>(null), [busy,setBusy] = useState(''), [error,setError] = useState('');
  const [authorizationUrl,setAuthorizationUrl] = useState(''), [message,setMessage] = useState('');
  const load = useCallback(async () => {
    setBusy('load'); setError('');
    try { setStatus(await googleMeetAction('status',{tenantId})); }
    catch (err) { setError((err as Error).message); } finally { setBusy(''); }
  },[tenantId]);
  useEffect(()=>{setAuthorizationUrl('');void load();},[load]);
  const run = async (action: string) => {
    setBusy(action);setError('');setMessage('');
    try {
      const result:any = await googleMeetAction(action,{tenantId});
      if (action==='connect') setAuthorizationUrl(result.authorization_url);
      else { setAuthorizationUrl('');setMessage(result.message || 'Sincronização concluída.');await load(); }
    } catch(err) {setError((err as Error).message);} finally {setBusy('');}
  };
  return <div className="max-w-4xl space-y-5 p-4 sm:p-6">
    <div className="flex items-start justify-between gap-4"><div><h2 className="flex items-center gap-2 text-xl font-bold text-brand-text"><Video size={22}/>Google Meet da escola</h2><p className="mt-2 text-sm text-brand-muted">Uma conta organizadora central, professores com seus próprios Gmails e documentos de aula vinculados ao histórico de cada aluno.</p></div><button type="button" onClick={()=>void load()} disabled={!!busy} aria-label="Atualizar conexão" className="rounded-xl border border-brand-border p-2 text-brand-text">{busy==='load'?<Loader2 className="animate-spin" size={18}/>:<RefreshCw size={18}/>}</button></div>
    {error&&<p role="alert" className="rounded-xl bg-red-50 p-4 text-sm text-red-700">{error}</p>}
    {message&&<p role="status" className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800">{message}</p>}
    {status&&<>
      <div className="rounded-2xl border border-brand-border bg-brand-surface p-5 space-y-3">
        <p className="text-sm font-bold text-brand-text">{status.connection?.status==='CONNECTED'?'Conta conectada':status.configured?'Aguardando conexão da conta central':'Configuração pendente'}</p>
        {status.connection?.organizer_email&&<p className="text-sm text-brand-muted">Organizadora: {status.connection.organizer_email}</p>}
        <p className="text-sm text-brand-muted">{status.enabled?'Documentação pedagógica ativada. A disponibilidade de transcrição, notas e coanfitrião depende dos recursos liberados pelo Google na conta conectada.':'A documentação permanece desativada até a configuração e a validação da conta da escola.'}</p>
        {status.connection?.status==='CONNECTED'&&status.scopes_outdated&&<p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">A conta foi conectada com a permissão antiga do Drive. As salas funcionam, mas transcrição, anotações e presença só são lidas depois de <strong>Reconectar conta central</strong>.</p>}
        {status.connection?.last_error_code&&<p className="text-sm text-amber-700">A conexão precisa de atenção. Reconecte a conta e confira as permissões.</p>}
        {status.can_manage&&<div className="flex flex-wrap gap-3">
          <button type="button" disabled={!!busy||!status.configured} onClick={()=>void run('connect')} className="rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white disabled:opacity-40">{busy==='connect'?'Preparando…':status.connection?.status==='CONNECTED'?'Reconectar conta central':'Conectar conta central'}</button>
          {status.connection?.status==='CONNECTED'&&<button type="button" disabled={!!busy} onClick={()=>{if(window.confirm('Desconectar a conta organizadora? Novas salas e importações ficarão indisponíveis; o histórico já revisado será preservado.'))void run('disconnect');}} className="rounded-xl border border-brand-border px-4 py-2.5 text-sm font-bold text-brand-text">Desconectar</button>}
          {status.connection?.status==='CONNECTED'&&status.enabled&&<button type="button" disabled={!!busy} onClick={()=>void run('sync_due')} className="rounded-xl border border-brand-border px-4 py-2.5 text-sm font-bold text-brand-text">Importar documentos pendentes</button>}
        </div>}
        {authorizationUrl&&<div className="rounded-xl bg-indigo-50 p-4 text-sm text-indigo-900"><a href={authorizationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 font-bold">Autorizar conta central no Google <ExternalLink size={15}/></a><p className="mt-2">Depois de autorizar, volte aqui e atualize a conexão. Este link expira em dez minutos.</p></div>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2"><div className="rounded-2xl border border-brand-border bg-brand-surface p-5"><h3 className="font-bold text-brand-text">Continuidade do aluno</h3><p className="mt-2 text-sm text-brand-muted">Transcrições e notas Gemini viram rascunhos com as fontes preservadas. Um educador revisa o objetivo, o que foi praticado e o próximo passo antes de alimentar a memória individual.</p><p className="mt-2 text-sm text-brand-muted">As salas são externas ao aplicativo. Professor entra com sua própria conta como coanfitrião.</p></div><div className="rounded-2xl border border-brand-border bg-brand-surface p-5"><h3 className="font-bold text-brand-text">Notas e uso adicional de IA</h3><p className="mt-2 text-sm text-brand-muted">Importar as notas nativas não aciona uma segunda análise por API. A estruturação adicional por Gemini exige ativação e exibe estimativa antes da solicitação; a cobrança é separada do AI Pro ou Workspace.</p><p className="mt-2 text-sm text-brand-muted">Estruturação adicional: {status.summary_ai_enabled?'disponível':'desativada'}.{status.summary_ai_model&&` Modelo: ${status.summary_ai_model}.`}</p></div></div>
      <p className="rounded-xl bg-amber-50 p-4 text-sm text-amber-900">A presença vem do relatório de presença do próprio Google (Business Plus), gerado depois de cada aula na sala da escola. Quando diverge do lançamento — aluno ausente numa aula dada, professor atrasado, aula fora da sala — vira um caso na Central de Qualidade para conversar com o professor. Nada disso altera a folha de pagamento automaticamente.</p>
      {!status.configured&&status.can_manage&&<details className="rounded-xl border border-brand-border p-4 text-sm text-brand-muted"><summary className="cursor-pointer font-bold text-brand-text">Configuração da integração</summary><p className="mt-3">A administração técnica precisa configurar o aplicativo OAuth, a chave de proteção dos tokens e o endereço de retorno. Nunca cole senhas ou tokens nesta tela.</p><ul className="mt-2 list-disc pl-5">{status.missing_configuration.map((name:string)=><li key={name}>{name}</li>)}</ul></details>}
    </>}
  </div>;
}
