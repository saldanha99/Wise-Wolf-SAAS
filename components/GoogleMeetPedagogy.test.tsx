import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GoogleMeetSettings from './GoogleMeetSettings';
import LessonPedagogicalSummary from './LessonPedagogicalSummary';
const invoke=vi.hoisted(()=>vi.fn());
vi.mock('../lib/googleMeet',()=>({googleMeetAction:invoke}));
// O cartão do teto de IA (direção) lê o gasto por RPC direta.
const rpc=vi.hoisted(()=>vi.fn(()=>Promise.resolve({data:null,error:{message:'fixture'}})));
vi.mock('../lib/supabase',()=>({supabase:{rpc}}));
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
    // Sem aceite a sala da escola não é oferecida (o app usa o link de sempre).
    expect(screen.queryByText(/Entrar na sala oficial/)).toBeNull();
    expect(screen.queryByRole('button',{name:/Concluir configuração da sala|Criar sala oficial/})).toBeNull();
  });
  it('revogação com o desligar ainda pendente: nada de sala oficial, e o erro diz quando tenta de novo',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,
      session:{documentation_consent:false,documentation_blocked:true},
      room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',space_name:'spaces/x',artifacts_state:'ENABLED',
        artifacts_error_code:'google_rate_limited',artifacts_next_attempt_at:'2026-09-26T15:30:00Z'}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByTestId('artifacts-error');
    expect(screen.queryByText(/Entrar na sala oficial/)).toBeNull();
    expect(screen.getByTestId('artifacts-error').textContent).toMatch(/desligar a transcrição falhou/);
    expect(screen.getByTestId('artifacts-error').textContent).toMatch(/Nova tentativa automática às 12:30/);
    expect(screen.getByText(/revogou o registro antes do fim desta aula/)).toBeTruthy();
  });
  it('sala já no estado do aceite não mostra erro velho de tentativa',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,
      session:{documentation_consent:false},
      room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',space_name:'spaces/x',artifacts_state:'DISABLED',
        artifacts_error_code:'google_resource_unavailable'}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByTestId('artifacts-disabled');
    expect(screen.queryByTestId('artifacts-error')).toBeNull();
  });
  it('conta do professor trocada: a sala segue com o link e avisa o acerto do coanfitrião',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,
      room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',space_name:'spaces/x',artifacts_state:'ENABLED',
        cohost_sync_pending:true,cohost_error_code:'google_rate_limited',cohost_next_attempt_at:'2026-09-26T15:30:00Z'}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByTestId('cohost-sync');
    expect(screen.getByRole('link',{name:/Entrar na sala oficial/})).toHaveAttribute('href','https://meet.google.com/abc-defg-hij');
    expect(screen.getByTestId('cohost-sync').textContent).toMatch(/Nova tentativa automática às 12:30/);
  });
});
describe('A sala acompanha a troca de professor (20260928110000)',()=>{
  beforeEach(()=>invoke.mockReset());
  const handover={from_teacher_name:'Flávio',to_teacher_name:'Bruna',cause:'COVERAGE',at:'2026-09-28T12:00:00Z',documentation_ready:true,after_lesson:false};
  it('aula coberta com a conta da substituta ainda entrando: sem sala oficial, diz quem entra e quem sai',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,teacher_handover:handover,
      room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',space_name:'spaces/x',artifacts_state:'ENABLED',
        cohost_sync_pending:true,teacher_handover_pending:true,cohost_error_code:'google_rate_limited',cohost_next_attempt_at:'2026-09-26T15:30:00Z'}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByTestId('handover-cohost');
    expect(screen.getByTestId('teacher-handover').textContent).toMatch(/Aula passada de Flávio para Bruna em .* \(cobertura confirmada\)\. Quem revisa o resumo desta aula é quem a deu\./);
    expect(screen.getByTestId('handover-cohost').textContent).toMatch(/A conta Google de Bruna entra como coanfitriã desta sala e a de Flávio sai\. Até isso acontecer, o link da sala não é mandado a ninguém/);
    expect(screen.getByTestId('handover-cohost').textContent).toMatch(/Nova tentativa automática às 12:30/);
    // O aluno esperaria numa sala que só o ausente abre: nada de "Entrar na sala oficial".
    expect(screen.queryByText(/Entrar na sala oficial/)).toBeNull();
    expect(screen.queryByTestId('cohost-sync')).toBeNull();
  });
  it('depois do acerto a sala volta a ser oferecida',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,teacher_handover:handover,
      room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',space_name:'spaces/x',artifacts_state:'ENABLED',
        cohost_sync_pending:false,teacher_handover_pending:false}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByTestId('teacher-handover');
    expect(screen.getByRole('link',{name:/Entrar na sala oficial/})).toHaveAttribute('href','https://meet.google.com/abc-defg-hij');
    expect(screen.queryByTestId('handover-cohost')).toBeNull();
  });
  it('substituto sem conta ou sem termo: explica que a transcrição fica desligada e a aula segue pelo link de sempre',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,teacher_handover:{...handover,documentation_ready:false},
      session:{documentation_consent:false,documentation_blocked:true,documentation_blocked_reason:'HANDOVER_UNCONSENTED'},
      room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',space_name:'spaces/x',artifacts_state:'ENABLED',teacher_handover_pending:true}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText(/Esta aula passou para Bruna, que ainda não confirmou a conta Google ou não autorizou a versão vigente do termo/);
    expect(screen.queryByText(/revogou o registro/)).toBeNull();
    expect(screen.queryByText(/Entrar na sala oficial/)).toBeNull();
    // Sem aceite, não se promete o acerto do coanfitrião.
    expect(screen.queryByTestId('handover-cohost')).toBeNull();
  });
  it('aula dada por outro professor ainda sem a troca: diz o motivo, não "revogou"',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,
      session:{documentation_consent:false,documentation_blocked:true,documentation_blocked_reason:'TAUGHT_BY_OTHER'},
      room:{state:'READY',meeting_uri:'https://meet.google.com/abc-defg-hij',space_name:'spaces/x',artifacts_state:'ENABLED'}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText(/Esta aula é dada por outro professor e a sessão ainda não passou para ele/);
    expect(screen.queryByText(/revogou o registro/)).toBeNull();
    expect(screen.queryByTestId('teacher-handover')).toBeNull();
  });
  it('presença: a conta de quem passou a aula aparece como tal, não como aluno',async()=>{
    invoke.mockResolvedValue({...detail(),raw_access:true,teacher_handover:handover,
      attendance:{teacher_first_join_at:'2026-09-26T13:02:00Z',teacher_seconds:1680,student_first_join_at:'2026-09-26T13:03:00Z',student_seconds:1620,parse_error:null,
        participants:[{role:'OTHER_TEACHER',name:'Flávio',joinedAt:'2026-09-26T13:00:00Z',leftAt:'2026-09-26T13:05:00Z',durationSeconds:300},
          {role:'TEACHER',name:'Bruna',joinedAt:'2026-09-26T13:02:00Z',leftAt:'2026-09-26T13:30:00Z',durationSeconds:1680}]}});
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText('Presença pelo relatório do Google');
    expect(screen.getByText(/Professor que passou a aula: Flávio/)).toBeTruthy();
    expect(screen.getByText(/Professor: Bruna/)).toBeTruthy();
  });
});
describe('Resumo automático por IA na tela da aula',()=>{
  const aiDetail=(extra:Record<string,unknown>={})=>({...detail(),raw_access:true,summary_ai_enabled:true,summary_ai_model:'google/gemini-3.6-flash',
    summary_ai_pricing:{estimated_usd:0.021,max_output_tokens:8000},...extra});
  it('teto do mês atingido: avisa que o automático não sai e o manual continua com aceite de custo',async()=>{
    invoke.mockResolvedValue(aiDetail({summary_ai_budget:{cap_reached:true,paused:false,last_generation:null}}));
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByTestId('summary-cap-reached');
    const button=screen.getByRole('button',{name:'Gerar rascunho estruturado'}) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('generate_summary',expect.objectContaining({acceptApiUsage:true,sessionId:'session'})));
  });
  it('rascunho da IA já existe: diz que só sai outro com fonte nova; mostra até quando aprovar',async()=>{
    invoke.mockResolvedValue(aiDetail({summaries:[{id:'ai-id',version:2,status:'PROPOSED',origin:'GEMINI_API',source_artifact_ids:['artifact'],
      content:{narrative:'Rascunho',lesson_objective:'',recommended_next_step:'',content_practiced:[],recurring_errors:[],strengths_observed:[],homework_assigned:'',uncertainties:[],
        evidence:[{artifact_id:'artifact',quote:'Exercícios de inglês.'}]}}]}));
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText(/já tem rascunho da IA/);
    expect(screen.queryByTestId('summary-cap-reached')).toBeNull();
    expect(screen.getByTestId('summary-deadline').textContent).toMatch(/Aprovar até 12\/12\/2026/);
  });
  it('tentativa automática que falhou aparece com o motivo em português',async()=>{
    invoke.mockResolvedValue(aiDetail({summary_ai_budget:{cap_reached:false,last_generation:{trigger:'AUTOMATIC',status:'FAILED',error_code:'invalid_summary_evidence'}}}));
    render(<LessonPedagogicalSummary sessionId="session"/>);
    await screen.findByText(/nenhuma citação do rascunho conferia com a transcrição/);
  });
});
