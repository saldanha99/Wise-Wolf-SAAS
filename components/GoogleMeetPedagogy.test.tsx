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
describe('Parte 2: troca de conta central, transcrição bruta e documentação desligada',()=>{
  const statusWith=(rooms:number)=>({configured:true,enabled:true,can_manage:true,rooms_count:rooms,
    connection:{status:'CONNECTED',organizer_email:'escola@example.com'},missing_configuration:[],summary_ai_enabled:false});
  it('reconectar com salas pede confirmação e não autoriza troca; trocar de conta é pedido à parte',async()=>{
    invoke.mockImplementation((action)=>Promise.resolve(action==='status'?statusWith(3):{authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?x=1'}));
    const confirm=vi.spyOn(window,'confirm');
    render(<GoogleMeetSettings tenantId="fixture"/>);
    await screen.findByText(/3 sala\(s\) criada\(s\) por ela/);
    confirm.mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole('button',{name:'Reconectar conta central'}));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(String(confirm.mock.calls[0][0])).toMatch(/MESMA conta/);
    expect(invoke.mock.calls.map(([action])=>action)).toEqual(['status']);
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button',{name:'Reconectar conta central'}));
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('connect',{tenantId:'fixture'}));
    confirm.mockReturnValueOnce(true);
    fireEvent.click(screen.getByRole('button',{name:'Trocar para outra conta'}));
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('connect',{tenantId:'fixture',allow_replace:true}));
    expect(String(confirm.mock.calls[2][0])).toMatch(/deixam de ser importadas/);
    confirm.mockRestore();
  });
  it('sem salas criadas, reconectar não pergunta nada e não há troca de conta',async()=>{
    invoke.mockImplementation((action)=>Promise.resolve(action==='status'?statusWith(0):{authorization_url:'https://accounts.google.com/o/oauth2/v2/auth?x=1'}));
    const confirm=vi.spyOn(window,'confirm');
    render(<GoogleMeetSettings tenantId="fixture"/>);
    fireEvent.click(await screen.findByRole('button',{name:'Reconectar conta central'}));
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('connect',{tenantId:'fixture'}));
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('button',{name:'Trocar para outra conta'})).toBeNull();
    confirm.mockRestore();
  });
  it('quem não vê a fonte recebe só o resumo aprovado, sem fontes nem botões de revisão',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:false,artifacts:[],attendance:null,summaries:[{id:'ok-id',version:2,status:'VERIFIED',origin:'HUMAN_REVIEW',
      content:{narrative:'Praticou pedidos no restaurante.',lesson_objective:'Pedir comida',recommended_next_step:'Reservar mesa por telefone',content_practiced:['Pedidos'],recurring_errors:[],strengths_observed:[],homework_assigned:'',uncertainties:[],evidence:[]}}]});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByTestId('approved-summary');
    expect(screen.getByText(/Reservar mesa por telefone/)).toBeTruthy();
    expect(screen.getByText(/ficam só com o professor da aula, a coordenação e a direção/)).toBeTruthy();
    expect(screen.queryByText(/Fontes importadas/)).toBeNull();
    expect(screen.queryByRole('button',{name:'Aprovar e atualizar memória do aluno'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Importar transcrição e notas'})).toBeNull();
  });
  it('professor da aula vê a presença do relatório e a sala com transcrição desligada',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,
      session:{documentation_consent:false},
      room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',space_name:'spaces/x',artifacts_state:'DISABLED',artifacts_changed_at:'2026-09-26T15:00:00Z'},
      attendance:{teacher_first_join_at:'2026-09-26T13:04:00Z',teacher_seconds:1680,student_first_join_at:'2026-09-26T13:06:00Z',student_seconds:1500,parse_error:null,
        participants:[{role:'TEACHER',name:'Professora',joinedAt:'2026-09-26T13:04:00Z',leftAt:'2026-09-26T13:32:00Z',durationSeconds:1680}]}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText('Presença pelo relatório do Google');
    expect(screen.getByText(/Professor: entrou 10:04 · 28 min/)).toBeTruthy();
    expect(screen.getByTestId('artifacts-disabled').textContent).toMatch(/Transcrição e anotações desligadas nesta sala/);
    expect(screen.getByText(/autorização de registro desta aula foi retirada/)).toBeTruthy();
  });
});
