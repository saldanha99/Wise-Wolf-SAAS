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
 it('shows a stale-version refusal inside the document and keeps the form open',async()=>{
  rpc.mockImplementation((_name,args)=>Promise.resolve(args.p_action==='list'?{data:{ok:true,enabled:true,role:'TEACHER',actor_name:'Professor Fixture',terms:[term]},error:null}:{data:null,error:{message:'Confira a versão atual.'}}));render(<TeacherStudentTerms />);
  fireEvent.click(await screen.findByRole('button',{name:'Ler termo e comprovantes'}));const dialog=screen.getByRole('dialog');fireEvent.click(within(dialog).getByLabelText(/Li a via/));fireEvent.click(within(dialog).getByLabelText(/Tenho poderes/));fireEvent.change(within(dialog).getByRole('textbox'),{target:{value:'Professor Fixture'}});fireEvent.click(within(dialog).getByRole('button',{name:'Assinar esta versão'}));expect(await within(dialog).findByRole('alert')).toHaveTextContent('Confira a versão atual.');expect(screen.getByRole('dialog')).toBeInTheDocument();
 });
});
