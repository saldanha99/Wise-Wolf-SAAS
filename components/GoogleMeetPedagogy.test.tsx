import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GoogleMeetSettings from './GoogleMeetSettings';
import LessonPedagogicalSummary from './LessonPedagogicalSummary';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('../lib/googleMeet',()=>({googleMeetAction:invoke}));
beforeEach(()=>invoke.mockReset());
const detail=()=>({session:{documentation_consent:true},room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij'},
  enabled:true,summary_ai_enabled:false,artifacts:[{id:'artifact',kind:'SMART_NOTES',source_text:'Exercícios de inglês.',imported_at:'2026-09-12T12:00:00Z',expires_at:'2026-12-12T12:00:00Z'}],
  summaries:[{id:'draft-id',version:1,status:'PROPOSED',origin:'GOOGLE_SMART_NOTES',content:{narrative:'Exercícios de inglês.',lesson_objective:'',recommended_next_step:'',content_practiced:[],recurring_errors:[],strengths_observed:[],homework_assigned:'',uncertainties:[],evidence:[]}}]});
describe('Google Meet documentation readiness and human review',()=>{
  it('shows setup pending and does not manufacture a connected account or room',async()=>{
    invoke.mockResolvedValue({configured:false,enabled:false,connection:null,can_manage:true,missing_configuration:['GOOGLE_MEET_OAUTH_CLIENT_ID'],summary_ai_enabled:false});
    render(<GoogleMeetSettings tenantId="fixture"/>);
    await screen.findByText('Configuração pendente');
    expect((screen.getByRole('button',{name:'Conectar conta central'}) as HTMLButtonElement).disabled).toBe(true);
    expect(invoke.mock.calls.map(([action])=>action)).toEqual(['status']);
  });
  it('native notes do not become verified facts before an explicit complete review',async()=>{
    invoke.mockImplementation((action)=>Promise.resolve(action==='session_detail'?detail():{ok:true}));
    render(<LessonPedagogicalSummary sessionId="session" tenantId="fixture"/>);
    await screen.findByText('Resumo da aula');
    const approve=screen.getByRole('button',{name:'Aprovar e atualizar memória do aluno'}) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Objetivo trabalhado'),{target:{value:'Pedir direções'}});
    fireEvent.change(screen.getByLabelText('Próximo passo'),{target:{value:'Praticar com um mapa'}});
    fireEvent.click(approve);
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('review_summary',expect.objectContaining({status:'VERIFIED',parentVersionId:'draft-id',content:expect.objectContaining({lesson_objective:'Pedir direções'})})));
  });
  it('does not display approval success when the authoritative endpoint fails',async()=>{
    invoke.mockResolvedValue(detail());
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText('Resumo da aula');
    invoke.mockRejectedValueOnce(new Error('Revisão não salva'));
    fireEvent.click(screen.getByRole('button',{name:'Registrar rejeição'}));
    await screen.findByRole('alert');
    expect(screen.queryByText('Revisão registrada.')).toBeNull();
  });
  it('shows additional API estimate and requires cost acknowledgment before generation',async()=>{
    const data={...detail(),summary_ai_enabled:true,summary_ai_model:'configured-model',summary_ai_pricing:{estimated_usd:0.014,max_output_tokens:6000}};
    invoke.mockResolvedValue(data);
    render(<LessonPedagogicalSummary sessionId="session"/>);
    const button=await screen.findByRole('button',{name:'Gerar rascunho estruturado'}) as HTMLButtonElement;
    expect(button.disabled).toBe(true);expect(screen.getByText(/US\$ 0.0140/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button.disabled).toBe(false);
    expect(invoke.mock.calls.map(([action])=>action)).toEqual(['session_detail']);
  });
});
describe('Situação de cada documento e sala que o Google não criou',()=>{
  it('mostra o documento que falhou, o vazio e a transcrição montada pelas falas',async()=>{
    invoke.mockResolvedValue({...detail(),room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',sync_status:'PENDING'},imports:[
      {provider_name:'conferenceRecords/c/smartNotes/n',kind:'SMART_NOTES',status:'FAILED',source:null,last_error_code:'google_document_permission_required',failed_attempts:2},
      {provider_name:'conferenceRecords/c/transcripts/t',kind:'TRANSCRIPT',status:'IMPORTED',source:'MEET_ENTRIES',last_error_code:'google_document_unavailable',failed_attempts:0},
      {provider_name:'conferenceRecords/d/transcripts/t2',kind:'TRANSCRIPT',status:'EMPTY',source:'DRIVE_EXPORT',last_error_code:null,failed_attempts:0},
    ]});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText('Situação dos documentos');
    expect(screen.getByText(/Não importado: a conta da escola não tem acesso ao documento/)).toBeTruthy();
    expect(screen.getByText(/Importada pelas falas da reunião \(o Google Docs não entregou o arquivo\)/)).toBeTruthy();
    expect(screen.getByText(/Sem fala registrada/)).toBeTruthy();
  });
  it('sala FAILED: diz o motivo, a próxima tentativa e oferece tentar de novo',async()=>{
    invoke.mockResolvedValue({...detail(),room:{state:'FAILED',last_error_code:'google_permission_or_edition_required',next_attempt_at:'2026-09-26T15:30:00Z'},artifacts:[],summaries:[],imports:[]});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText(/O Google não criou a sala \(o Google não liberou o recurso para esta conta\)/);
    expect(screen.getByText(/Nova tentativa automática às 12:30/)).toBeTruthy();
    expect(screen.getByText(/a aula usa o link de sempre/)).toBeTruthy();
    expect((screen.getByRole('button',{name:'Tentar criar a sala de novo'}) as HTMLButtonElement).disabled).toBe(false);
  });
});
