import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';

type Evidence = { id:string;subject_role:string;full_name:string;scheduled_start_at:string;first_join_at:string|null;late_minutes:number|null;evidence_status:string;report_id:string };
type Origin = { id:string;name:string;source:string;created_at:string;origin:Record<string, string> };
type Channel = { channel:string;enabled:boolean;late_minutes:number };
type Notice = { id:string;channel:string;status:string;last_error:string|null;created_at:string };
const when=(v:string|null)=>v?new Date(v).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo',dateStyle:'short',timeStyle:'short'}):'Não identificado';
const channels:Record<string,string>={teacher_attendance:'Atrasos de professores',student_attendance:'Atrasos de alunos',lead_source:'Origem dos leads'};
const states:Record<string,string>={PENDING:'Pendente',CLAIMED:'Preparando envio',SUBMITTING:'Envio a conferir',ACCEPTED:'Aceito pelo provedor',UNKNOWN:'Resultado a conferir',REJECTED:'Recusado pelo provedor',SUPPRESSED:'Envio impedido pela conferência'};
const label:Record<string,string>={PAID:'Tráfego pago',ORGANIC_SEARCH:'Busca orgânica',REFERRAL:'Referência externa',TAGGED:'Link UTM',WHATSAPP_UNKNOWN:'WhatsApp / campanha desconhecida',DIRECT_UNKNOWN:'Direto / não identificado'};
export default function SchoolOperationsEvidence(){
 const today=new Date().toLocaleDateString('en-CA',{timeZone:'America/Sao_Paulo'});
 const [from,setFrom]=useState(today),[to,setTo]=useState(today),[data,setData]=useState<{channels:Channel[];attendance:Evidence[];origins:Origin[];notifications:Notice[]}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 async function load(){setBusy(true);setError('');setData(null);const r=await supabase.rpc('school_operations_evidence_log',{p_from:from,p_to:to});if(r.error)setError('Não foi possível carregar os registros. Confira sua permissão e use até 32 dias.');else setData(r.data);setBusy(false);}
 useEffect(()=>{let alive=true;setBusy(true);setError('');setData(null);void supabase.rpc('school_operations_evidence_log',{p_from:from,p_to:to}).then(r=>{if(!alive)return;if(r.error)setError('Não foi possível carregar os registros. Confira sua permissão e use até 32 dias.');else setData(r.data);setBusy(false);});return()=>{alive=false;};},[from,to]);
 return <section data-tour="school-operations-evidence" className="space-y-4 rounded-xl border p-5">
  <h2 className="text-lg font-bold">Registros de aula e origem dos leads</h2>
  <p className="text-sm">Relatório nativo do Meet, conferido após o fim da reunião. Identidade ou horário desconhecidos ficam sem conclusão. O aluno não responder ao acompanhamento não confirma a realização da aula.</p>
  <p className="text-sm">Os grupos privados habilitados recebem os avisos após a conferência do relatório. A evidência detalhada permanece aqui por até 90 dias. Registro técnico não gera multa, desconto ou decisão automática.</p>
  {data&&<p className="text-sm">{data.channels?.filter(c=>c.enabled).map(c=>`${channels[c.channel]||c.channel}${c.channel==='lead_source'?'':` (a partir de ${c.late_minutes} min)`}`).join(' · ')||'Nenhum canal de aviso habilitado.'}</p>}
  <div className="flex flex-wrap gap-3"><label>De <input aria-label="Início dos registros" type="date" value={from} onChange={e=>setFrom(e.target.value)} /></label><label>Até <input aria-label="Fim dos registros" type="date" value={to} onChange={e=>setTo(e.target.value)} /></label><button disabled={busy} onClick={()=>void load()} className="underline">Atualizar registros</button></div>
  {error&&<p role="alert">{error}</p>}{busy&&<p>Carregando registros…</p>}
  <h3 className="font-bold">Presença e pontualidade</h3>
  <div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Pessoa</th><th>Aula prevista</th><th>Primeira entrada</th><th>Registro</th></tr></thead><tbody>{data?.attendance.map(e=><tr key={e.id} className="border-t"><td className="py-2">{e.full_name} · {e.subject_role==='TEACHER'?'Professor':'Aluno'}</td><td>{when(e.scheduled_start_at)}</td><td>{when(e.first_join_at)}</td><td>{e.evidence_status==='MEASURED'?e.late_minutes===0?'Entrada no horário ou antes':`${e.late_minutes} min de atraso`:'Sem identidade/horário comprovados'}<br/><span className="text-xs">Relatório {e.report_id}</span></td></tr>)}</tbody></table></div>
  {data?.attendance.length===0&&<p className="text-sm">Sem relatório conferido neste período. A ausência de registro não comprova falta.</p>}
  <h3 className="font-bold">Origem dos contatos</h3><p className="text-xs">Canal observado e local de entrada são informações diferentes: um anúncio pode levar a um artigo do blog. Os dados antigos só mostram o que foi capturado na época.</p>
  <div className="overflow-auto"><table className="w-full text-left text-sm"><thead><tr><th>Contato</th><th>Canal / entrada</th><th>Campanha</th><th>Página / referência</th></tr></thead><tbody>{data?.origins.map(l=><tr key={l.id} className="border-t"><td className="py-2">{l.name}<br/>{when(l.created_at)}</td><td>{label[l.origin.channel]||'Não identificado'}<br/>{l.origin.surface==='BLOG'?'Blog · ':''}{l.source}</td><td>{l.origin.utm_campaign||'Não informada'}<br/>{l.origin.utm_source} / {l.origin.utm_medium}</td><td>{l.origin.first_landing_path||l.origin.landing_path||'Não informada'}{l.origin.last_landing_path&&l.origin.last_landing_path!==l.origin.first_landing_path&&<><br/>Contato: {l.origin.last_landing_path}</>}<br/>{l.origin.first_referrer_host||l.origin.referrer_host||'Referência não informada'}</td></tr>)}</tbody></table></div>
  <details><summary>Avisos enviados e pendências</summary>{data?.notifications.map(n=><p key={n.id} className="text-xs">{when(n.created_at)} · {channels[n.channel]||n.channel} · {states[n.status]||n.status}{n.last_error?` · ${n.last_error}`:''}</p>)}<p className="text-xs">Aceito pelo provedor não comprova leitura. Resultados incertos exigem conferência e não são reenviados automaticamente.</p></details>
 </section>;
}
