import {describe,it,expect} from 'vitest';
import {termCanSign,termAgenda,type IndividualTerm} from './teacherStudentTerms';
const term:IndividualTerm={id:'fixture',version:1,student_name:'Aluno Fixture',teacher_name:'Professor Fixture',mode:'RECURRING',starts_on:'2026-11-01',ends_on:null,slots:[{day:1,time:'18:00',date:null},{day:1,time:'18:30',date:null}],status:'PROPOSED',phase:'SCHOOL_PENDING',content_hash:'fixture-hash'};
describe('individual service term signing boundary',()=>{
 it('keeps school and teacher manifestations separate',()=>{expect(termCanSign('SCHOOL_ADMIN',term)).toBe(true);expect(termCanSign('TEACHER',term)).toBe(false);expect(termCanSign('COORDINATOR',term)).toBe(false);expect(termCanSign('STUDENT',term)).toBe(false);expect(termCanSign('TEACHER',{...term,phase:'TEACHER_PENDING'})).toBe(true);expect(termCanSign('SCHOOL_ADMIN',{...term,phase:'TEACHER_PENDING'})).toBe(false);});
 it('cannot offer signatures on completed, withdrawn, unidentified or closed versions',()=>{for(const patch of [{status:'EXECUTED'},{status:'REVOKED'},{phase:'IDENTITY_PENDING'},{retired_at:'2026-11-02'},{content_hash:''}])expect(termCanSign('SCHOOL_ADMIN',{...term,...patch})).toBe(false);});
 it('shows each duration unit and dates without converting the timezone',()=>{expect(termAgenda(term.slots)).toBe('Segunda às 18:00 (30 min) · Segunda às 18:30 (30 min)');expect(termAgenda([{day:2,time:'18:00',date:'2026-11-10'}])).toBe('10/11/2026 às 18:00 (30 min)');});
});
