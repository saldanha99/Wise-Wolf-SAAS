export type TermSlot = { day:number;time:string;date:string|null };
export type IndividualTerm = {
 id:string;version:number;student_name:string;teacher_name:string;source_kind?:string;mode:'RECURRING'|'DATED';starts_on:string;ends_on:string|null;slots:TermSlot[];
 status:string;phase:string;body?:string;content_hash?:string;unit_rate?:number;school_signed_at?:string|null;teacher_signed_at?:string|null;school_typed_name?:string|null;teacher_typed_name?:string|null;
 family_confirmed_at?:string|null;schedule_hash?:string;retired_at?:string|null;closed_reason?:string|null;events?:{event:string;created_at:string;content_hash:string}[];
};
export type IndividualTermsData = {ok:boolean;role:string;tenant_id?:string;actor_name:string;general_contract_accepted?:boolean;enabled:boolean;terms:IndividualTerm[];identity?:ProviderDetails|null};
export type ProviderDetails = {companyName:string;cnpj:string;companyAddress:string;representativeCpf:string};
export const individualTermPhase:Record<string,string>={IDENTITY_PENDING:'Dados da empresa pendentes',SCHOOL_PENDING:'Aguardando assinatura da escola',TEACHER_PENDING:'Aguardando assinatura do professor',FAMILY_PENDING:'Aguardando confirmação da agenda',EXECUTED:'Termo assinado e agenda confirmada',PROPOSED:'Proposta pendente',DECLINED:'Recusado pelo professor',REVOKED:'Proposta retirada',SUPERSEDED:'Substituído por nova versão',TERMINATED:'Atendimento encerrado'};
export function termAgenda(slots:TermSlot[]):string {
 const days=['Domingo','Segunda','Terça','Quarta','Quinta','Sexta','Sábado'];
 return slots.map(s=>`${s.date?s.date.split('-').reverse().join('/'):days[s.day]} às ${s.time} (30 min)`).join(' · ');
}
export function termCanSign(role:string,term:IndividualTerm):boolean{
 return term.status==='PROPOSED' && Boolean(term.content_hash) && !term.retired_at && (role==='SCHOOL_ADMIN'?term.phase==='SCHOOL_PENDING':role==='TEACHER'&&term.phase==='TEACHER_PENDING');
}
export async function downloadIndividualTermPdf(term:IndividualTerm):Promise<void>{
 if(!term.body||!term.content_hash)throw new Error('A via integral não está disponível para esta conta.');
 const {jsPDF}=await import('jspdf');
 const pdf=new jsPDF({unit:'mm',format:'a4'});const width=174;let y=28;
 const header=()=>{pdf.setFillColor(20,36,59);pdf.rect(0,0,210,17,'F');pdf.setTextColor(255,255,255);pdf.setFont('helvetica','bold');pdf.setFontSize(12);pdf.text('TERMO INDIVIDUAL DE AULAS',18,11);pdf.setTextColor(20,36,59);};header();
 pdf.setFont('helvetica','normal');pdf.setFontSize(10);
 const evidence=[`Escola: ${term.school_typed_name||'Pendente'} | ${term.school_signed_at||'Sem assinatura'}`,`Prestador: ${term.teacher_typed_name||'Pendente'} | ${term.teacher_signed_at||'Sem assinatura'}`,`Agenda da família: ${term.family_confirmed_at||'Pendente'}`,`Estado: ${individualTermPhase[term.phase]||term.phase}`,`SHA-256 do texto integral: ${term.content_hash}`];
 for(const paragraph of [term.body,'## Comprovantes de manifestação',...evidence]){
  for(const raw of paragraph.split('\n')){
   const heading=/^#{1,2}\s/.test(raw);const text=raw.replace(/^#{1,2}\s/,'');
   if(heading){if(y>255){pdf.addPage();header();y=28;}y+=3;pdf.setFont('helvetica','bold');pdf.setFontSize(12);}else{pdf.setFont('helvetica','normal');pdf.setFontSize(10);}
   const lines=pdf.splitTextToSize(text,width) as string[];
   for(const line of lines){if(y>273){pdf.addPage();header();pdf.setFont('helvetica',heading?'bold':'normal');pdf.setFontSize(heading?12:10);y=28;}pdf.text(line,18,y);y+=heading?5.5:4.7;}if(!text)y+=2;
  }y+=3;
 }

 const total=pdf.getNumberOfPages();for(let i=1;i<=total;i++){pdf.setPage(i);pdf.setFontSize(8);pdf.setTextColor(90);pdf.text(`Via ${term.id} | revisão ${term.version} | página ${i}/${total}`,18,288);}
 pdf.save(`Termo_individual_${term.id}_v${term.version}.pdf`);
}
