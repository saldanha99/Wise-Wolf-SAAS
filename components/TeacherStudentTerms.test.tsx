import React from 'react';
import {render,screen,fireEvent,waitFor,within} from '@testing-library/react';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import TeacherStudentTerms from './TeacherStudentTerms';
const {rpc}=vi.hoisted(()=>({rpc:vi.fn()}));vi.mock('../lib/supabase',()=>({supabase:{rpc}}));
const term={id:'term-fixture',version:2,student_name:'Aluno Fixture',teacher_name:'Professor Fixture',mode:'RECURRING',starts_on:'2026-11-01',slots:[{day:1,time:'18:00',date:null}],status:'PROPOSED',phase:'TEACHER_PENDING',content_hash:'immutable-version-hash',body:'Texto integral reservado com honorários e agenda.',school_signed_at:'2026-10-27T18:00:00Z',school_typed_name:'Diretor Fixture',events:[]};
beforeEach(()=>{rpc.mockReset();});
describe('individual terms screen',()=>{
 it('requires the current text, typed name and separate declarations before sending the teacher signature',async()=>{
  rpc.mockResolvedValue({data:{ok:true,enabled:true,role:'TEACHER',actor_name:'Professor Fixture',terms:[term]},error:null});render(<TeacherStudentTerms />);
  fireEvent.click(await screen.findByRole('button',{name:'Ler termo e comprovantes'}));const dialog=screen.getByRole('dialog');expect(within(dialog).getByText(term.body)).toBeInTheDocument();expect(within(dialog).getByRole('textbox')).toHaveValue('');
  fireEvent.click(within(dialog).getByLabelText(/Li a via integral/));fireEvent.click(within(dialog).getByLabelText(/Tenho poderes/));fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'Professor Fixture'}});fireEvent.click(within(dialog).getByRole('button',{name:'Assinar esta versão'}));
  await waitFor(()=>expect(rpc).toHaveBeenCalledWith('teacher_student_terms',{p_action:'sign',p_id:'term-fixture',p_payload:{accepted:true,has_authority:true,typed_name:'Professor Fixture',content_hash:'immutable-version-hash'}}));
 });
 it('family confirms only the schedule hash without access to professional signature or remuneration',async()=>{
  rpc.mockResolvedValue({data:{ok:true,enabled:true,role:'STUDENT',actor_name:'Aluno Fixture',terms:[{...term,body:undefined,content_hash:undefined,schedule_hash:'schedule-only-hash',phase:'FAMILY_PENDING'}]},error:null});render(<TeacherStudentTerms />);
  fireEvent.click(await screen.findByRole('button',{name:'Conferir e confirmar agenda'}));const dialog=screen.getByRole('dialog');expect(within(dialog).queryByText(term.body)).not.toBeInTheDocument();expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
  fireEvent.click(within(dialog).getByLabelText(/Conferi os horários/));fireEvent.click(within(dialog).getByRole('button',{name:'Confirmar agenda'}));await waitFor(()=>expect(rpc).toHaveBeenCalledWith('teacher_student_terms',{p_action:'family_confirm',p_id:'term-fixture',p_payload:{confirmed:true,schedule_hash:'schedule-only-hash'}}));
 });
 describe('recorte da ficha do aluno',()=>{
  const school={...term,student_id:'aluno-a',phase:'SCHOOL_PENDING'};
  const list=(terms:unknown[],role='SCHOOL_ADMIN')=>({data:{ok:true,enabled:true,role,actor_name:'Direção Fixture',terms},error:null});
  it('mostra só o termo pendente daquele aluno, sem as ferramentas da tela geral',async()=>{
   rpc.mockResolvedValue(list([school,{...school,id:'de-outro',student_id:'aluno-b',student_name:'Outro Aluno'},{...school,id:'executado',status:'EXECUTED',phase:'EXECUTED'}]));
   render(<TeacherStudentTerms studentId="aluno-a" />);
   expect(await screen.findByText('Termo pendente deste aluno')).toBeInTheDocument();
   expect(screen.getByText('Aguardando assinatura da escola')).toBeInTheDocument();
   expect(screen.getAllByRole('article')).toHaveLength(1);
   expect(screen.queryByText(/Outro Aluno/)).not.toBeInTheDocument();
   expect(screen.queryByRole('button',{name:'Preparar atendimento manual ou reposição'})).not.toBeInTheDocument();
  });
  it('não ocupa espaço na ficha de quem não tem pendência',async()=>{
   rpc.mockResolvedValue(list([{...school,status:'EXECUTED',phase:'EXECUTED'}]));
   const {container}=render(<TeacherStudentTerms studentId="aluno-a" />);
   await waitFor(()=>expect(rpc).toHaveBeenCalled());
   await waitFor(()=>expect(container).toBeEmptyDOMElement());
  });
  it('confirma a assinatura e avisa quando as aulas entram na agenda',async()=>{
   let signed=false;
   rpc.mockImplementation((_name,args)=>{if(args.p_action==='sign'){signed=true;return Promise.resolve({data:{ok:true,phase:'EXECUTED'},error:null});}return Promise.resolve(list([signed?{...school,status:'EXECUTED',phase:'EXECUTED'}:school]));});
   render(<TeacherStudentTerms studentId="aluno-a" />);
   fireEvent.click(await screen.findByRole('button',{name:'Ler termo e comprovantes'}));const dialog=screen.getByRole('dialog');
   fireEvent.click(within(dialog).getByLabelText(/Li a via integral/));fireEvent.click(within(dialog).getByLabelText(/Tenho poderes/));fireEvent.change(within(dialog).getByLabelText(/Digite seu nome completo/),{target:{value:'Direção Fixture'}});fireEvent.click(within(dialog).getByRole('button',{name:'Assinar esta versão'}));
   expect(await screen.findByRole('status')).toHaveTextContent('As aulas fixas entram na agenda em até 2 minutos');
  });
 });
 it('shows a stale-version refusal inside the document and keeps the form open',async()=>{
  rpc.mockImplementation((_name,args)=>Promise.resolve(args.p_action==='list'?{data:{ok:true,enabled:true,role:'TEACHER',actor_name:'Professor Fixture',terms:[term]},error:null}:{data:null,error:{message:'Confira a versão atual.'}}));render(<TeacherStudentTerms />);
  fireEvent.click(await screen.findByRole('button',{name:'Ler termo e comprovantes'}));const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByLabelText(/Li a via/));fireEvent.click(within(dialog).getByLabelText(/Tenho poderes/));fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'Professor Fixture'}});fireEvent.click(within(dialog).getByRole('button',{name:'Assinar esta versão'}));expect(await within(dialog).findByRole('alert')).toHaveTextContent('Confira a versão atual.');expect(screen.getByRole('dialog')).toBeInTheDocument();
 });
});
