import React, { useRef } from 'react';
import { useReactToPrint } from 'react-to-print';
import { ShieldCheck } from 'lucide-react';

interface TeacherContractProps {
    teacherName: string;
    teacherRG: string;
    teacherCPF: string;
    teacherAddress: string;
    teacherBirthDate: string;
    hourlyRate?: number; // Valor dinâmico vindo do gerador
    contractCity?: string; // Ex: Santa Isabel/SP
    contractDate?: string; // Ex: 19 de agosto de 2025
    acceptedAt?: string;
    userIp?: string;
    subscriptionId?: string;
    displayMode?: 'responsive' | 'a4';
    showPrintButton?: boolean;
    innerRef?: React.RefObject<HTMLDivElement>;
}

export function TeacherContractDocument({
    teacherName,
    teacherRG,
    teacherCPF,
    teacherAddress,
    teacherBirthDate,
    hourlyRate = 16, // Default se não fornecido
    contractCity = "Santa Isabel/SP",
    contractDate,
    acceptedAt,
    userIp,
    subscriptionId,
    displayMode = 'a4',
    showPrintButton = true,
    innerRef,
}: TeacherContractProps) {
    const componentRef = useRef<HTMLDivElement>(null);
    const documentRef = (innerRef || componentRef) as React.RefObject<HTMLDivElement>;
    const isResponsive = displayMode === 'responsive';

    const handlePrint = useReactToPrint({
        contentRef: documentRef,
        documentTitle: `Contrato_Professor_WiseWolf_${teacherName}`,
    });

    // Cálculos dinâmicos
    const finalHourlyRate = hourlyRate || 16;
    const halfHourlyRate = finalHourlyRate / 2;

    // Data do contrato: quando já assinado, CONGELA na data da assinatura (acceptedAt) —
    // acceptedAt tem PRIORIDADE sobre contractDate, senão um contractDate=hoje passado pelo
    // chamador (ex.: wizard de onboarding) sobrescrevia o congelamento e a data "atualizava"
    // todo dia. Só usa contractDate/hoje enquanto o contrato ainda não foi assinado.
    const displayDate = acceptedAt
        ? new Date(acceptedAt).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' })
        : (contractDate || new Date().toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }));

    return (
        <div className={`teacher-contract-outer flex w-full flex-col items-center gap-6 ${isResponsive ? 'bg-transparent p-0' : 'min-h-screen bg-gray-100 p-8'}`}>

            {/* Botão de Ação (Aparece apenas na tela) */}
            {showPrintButton && (
                <div className="w-full max-w-[210mm] flex justify-end print:hidden">
                    <button
                        type="button"
                        onClick={handlePrint}
                        className="bg-[#002366] text-white px-6 py-2 rounded-lg font-bold hover:bg-[#001a4d] transition-all flex items-center gap-2"
                    >
                        🖨️ Imprimir / Salvar PDF
                    </button>
                </div>
            )}

            {/* Folha A4 do Contrato */}
            <div
                ref={documentRef}
                className={isResponsive
                    ? 'teacher-contract-responsive w-full max-w-[210mm] overflow-hidden rounded-2xl bg-white p-4 text-[13px] leading-relaxed text-gray-800 shadow-sm sm:p-8 lg:p-[18mm] lg:text-[11px]'
                    : 'w-[210mm] min-h-[297mm] bg-white p-[25mm] shadow-2xl text-[11px] leading-relaxed text-gray-800'}
                style={{ fontFamily: 'Arial, sans-serif' }}
            >
                <style>{`
                    @import url('https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&family=Great+Vibes&display=swap');
                    @media (max-width: 639px) {
                        .teacher-contract-responsive p {
                            font-size: 0.8125rem !important;
                            line-height: 1.5 !important;
                            overflow-wrap: anywhere;
                        }
                        .teacher-contract-responsive h1 {
                            font-size: 1rem !important;
                            line-height: 1.35 !important;
                        }
                        .teacher-contract-responsive h3 {
                            font-size: 0.75rem !important;
                            line-height: 1.4 !important;
                        }
                        .teacher-contract-responsive .teacher-contract-header {
                            align-items: flex-start;
                            flex-direction: column;
                            gap: 0.75rem;
                        }
                        .teacher-contract-responsive .teacher-contract-header > :last-child {
                            text-align: left;
                        }
                        .teacher-contract-responsive .teacher-contract-signatures {
                            flex-direction: column;
                            gap: 2.5rem;
                        }
                        .teacher-contract-responsive .teacher-contract-seal {
                            align-items: flex-start;
                        }
                    }
                `}</style>
                {/* Cabeçalho */}
                <div className="teacher-contract-header flex justify-between items-center mb-6 border-b-2 border-[#002366] pb-2">
                    <div className="text-xl font-black text-[#002366] tracking-tighter">
                        WISE WOLF <span className="text-red-600">LANGUAGE</span>
                    </div>
                    <div className="text-right text-[10px] text-gray-500 uppercase font-bold">
                        Professor Autônomo
                    </div>
                </div>

                <h1 className="text-center font-bold text-md mb-6 uppercase border-y border-gray-200 py-2">CONTRATO DE PRESTAÇÃO DE SERVIÇOS – PROFESSOR AUTÔNOMO</h1>

                {/* Identificação das Partes */}
                <div className="mb-4 space-y-2 text-justify">
                    <p>
                        <strong>CONTRATANTE:</strong> Débora Alves Fernandes, brasileira, solteira, nascida em 23/03/1999, portadora do CPF nº 506.398.248-46, domiciliada na Rua Um, nº 256, Santa Isabel – SP, CEP 07500-000, doravante denominada <strong>“WISE WOLF”</strong>.
                    </p>
                    <p>
                        <strong>CONTRATADO:</strong> {teacherName || '---'}, brasileiro(a), nascido(a) em {teacherBirthDate || '---'}, portador(a) do RG nº {teacherRG || '---'}, CPF nº {teacherCPF || '---'}, domiciliado(a) em {teacherAddress || '---'}, doravante denominado <strong>“PROFESSOR”</strong>.
                    </p>
                </div>

                {/* Cláusulas */}
                <div className="space-y-3">
                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 1ª – OBJETO</h3>
                        <p className="text-justify">
                            1.1 O presente contrato tem por objeto a prestação de serviços de aulas de inglês pelo CONTRATADO, sob orientação pedagógica e com materiais fornecidos pela CONTRATANTE.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 2ª – NATUREZA DA RELAÇÃO</h3>
                        <p className="text-justify">
                            2.1 As partes reconhecem que a presente relação tem natureza exclusivamente civil, regida pelo Código Civil (arts. 593 a 609), inexistindo qualquer vínculo de emprego regido pela CLT.
                        </p>
                        <p className="text-justify">
                            2.2 O CONTRATADO declara ciência de que atuará como prestador de serviços autônomo, sem subordinação, sem exclusividade e sem direitos trabalhistas típicos (tais como férias, 13º salário, FGTS ou aviso prévio indenizado).
                        </p>
                        <p className="text-justify">
                            2.3 A jurisprudência do Tribunal Superior do Trabalho (TST) entende que a ausência dos requisitos dos arts. 2º e 3º da CLT (pessoalidade, habitualidade, subordinação e onerosidade como salário) afasta o vínculo empregatício, prevalecendo a autonomia da contratação civil.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 3ª – REMUNERAÇÃO</h3>
                        <p className="text-justify">3.1 Pelos serviços prestados, o CONTRATADO receberá:</p>
                        <div className="pl-4 space-y-1 mt-1">
                            <p>a) R$ {halfHourlyRate.toFixed(2).replace('.', ',')} por cada 30 (trinta) minutos de aula ministrada, equivalente a R$ {finalHourlyRate.toFixed(2).replace('.', ',')} por hora;</p>
                            <p>b) R$ {halfHourlyRate.toFixed(2).replace('.', ',')} por cada 30 (trinta) minutos de participação em treinamentos internos promovidos pela CONTRATANTE;</p>
                            <p>c) Bonificação de R$ 50,00 (cinquenta reais) por indicação de professor que venha a ser efetivamente contratado pela CONTRATANTE.</p>
                        </div>
                        <p className="text-justify mt-2">
                            3.2 O pagamento será realizado até o dia 10 (dez) de cada mês, via PIX ou transferência bancária, mediante apuração das atividades realizadas no mês anterior.
                        </p>
                        <p className="text-justify">
                            3.3 Os valores ajustados possuem natureza exclusivamente civil, referentes à prestação de serviços autônomos, não configurando salário ou qualquer verba de natureza trabalhista.
                        </p>
                        <p className="text-justify mt-2">
                            3.4 <strong>REMUNERAÇÃO PROGRESSIVA POR ASSIDUIDADE.</strong> O valor base por aula ministrada é de R$ 8,00 (oito reais). Caso o CONTRATADO complete 1 (um) mês consecutivo sem registrar falta — comparecendo e tendo a presença confirmada em todas as aulas do período —, passará a fazer jus à remuneração progressiva, apurada por aluno ativo, observada a ordem de antiguidade de matrícula:
                        </p>
                        <div className="pl-4 space-y-1 mt-1">
                            <p>a) do 5º ao 9º aluno ativo: R$ 9,50 (nove reais e cinquenta centavos) por aula;</p>
                            <p>b) do 10º aluno ativo em diante: R$ 10,50 (dez reais e cinquenta centavos) por aula.</p>
                        </div>
                        <p className="text-justify mt-2">
                            3.5 A remuneração progressiva permanece ativa enquanto mantida a assiduidade. O registro de 1 (uma) falta do CONTRATADO interrompe o benefício, retornando a remuneração ao valor base de R$ 8,00 por aula, até que o CONTRATADO complete novo período de 1 (um) mês consecutivo sem faltas, quando o benefício é automaticamente reativado.
                        </p>
                        <p className="text-justify">
                            3.6 Para fins de apuração da remuneração, somente serão contabilizadas as aulas com presença confirmada pelo aluno no link de confirmação enviado ou, na ausência de confirmação do aluno, mediante registro de presença realizado pelo próprio CONTRATADO (veredito do professor).
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 4ª – OBRIGAÇÕES DO CONTRATADO</h3>
                        <p className="text-justify">
                            Ministrar as aulas de forma pontual e diligente. Utilizar o material pedagógico fornecido pela CONTRATANTE. Arcar com eventuais despesas pessoais necessárias à execução dos serviços (internet, transporte, equipamentos etc.). Manter sigilo sobre dados, informações, conteúdos e estratégias da CONTRATANTE e de seus alunos.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 5ª – OBRIGAÇÕES DA CONTRATANTE</h3>
                        <p className="text-justify">
                            Disponibilizar o material didático. Sugerir horários e turmas, que poderão ser ajustados em comum acordo entre as partes.. Realizar os repasses devidos na forma da Cláusula 3ª.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 6ª – PRAZO, RESCISÃO E TRANSIÇÃO</h3>
                        <p className="text-justify">
                            6.1 O presente contrato é firmado por prazo indeterminado, vigorando enquanto houver interesse das partes.
                        </p>
                        <p className="text-justify">
                            6.2 Qualquer das partes poderá rescindir o contrato mediante aviso prévio de 30 (trinta) dias (art. 599 do Código Civil), período em que o CONTRATADO se compromete a manter as aulas em andamento e a colaborar com a transição ordenada dos alunos.
                        </p>
                        <p className="text-justify">
                            6.3 O descumprimento contratual autoriza a rescisão imediata, sem prejuízo de eventuais indenizações por perdas e danos.
                        </p>
                        <p className="text-justify">
                            6.4 CLÁUSULA PENAL (bilateral): a parte que rescindir sem cumprir o aviso prévio pagará à outra multa compensatória proporcional aos dias de aviso não cumpridos, limitada ao valor da média mensal dos 3 (três) últimos fechamentos do CONTRATADO (ou do último fechamento, se houver menos de três), nos termos dos arts. 408 a 416 do Código Civil, admitida a compensação com créditos existentes entre as partes.
                        </p>
                        <p className="text-justify">
                            6.5 BÔNUS DE TRANSIÇÃO: cumprido integralmente o aviso prévio, com participação ativa na transição dos alunos e lançamentos em dia, o CONTRATADO fará jus a bônus de 10% (dez por cento) sobre o valor do seu último fechamento mensal, pago junto ao acerto final.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 7ª – RESPONSABILIDADES TRIBUTÁRIAS E NOTA FISCAL</h3>
                        <p className="text-justify">
                            7.1 O CONTRATADO é responsável pelo recolhimento de seus próprios tributos e contribuições (inclusive INSS autônomo, se optar), não recaindo sobre a CONTRATANTE qualquer obrigação previdenciária, trabalhista ou tributária.
                        </p>
                        <p className="text-justify">
                            7.2 O CONTRATADO declara possuir (ou compromete-se a providenciar antes do primeiro repasse) inscrição ativa de pessoa jurídica — preferencialmente na condição de Microempreendedor Individual (MEI), em ocupação/CNAE compatível com o ensino de idiomas (ex.: 8593-7/00) — mantendo-a regular durante toda a vigência deste contrato.
                        </p>
                        <p className="text-justify">
                            7.3 Para cada fechamento mensal pago pela CONTRATANTE, o CONTRATADO emitirá Nota Fiscal de Serviço eletrônica (NFS-e, pelo Emissor Nacional — gov.br/nfse ou aplicativo MEI) em face da CONTRATANTE, no exato valor do fechamento, anexando o documento na plataforma em até 5 (cinco) dias úteis contados do recebimento.
                        </p>
                        <p className="text-justify">
                            7.4 A ausência reiterada da nota fiscal prevista na cláusula 7.3 autoriza a CONTRATANTE a suspender a liberação de novos repasses até a regularização, sem que isso configure mora ou inadimplemento da CONTRATANTE.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 8ª – PROTEÇÃO DE DADOS (LGPD)</h3>
                        <p className="text-justify">
                            8.1 As partes autorizam a coleta e o tratamento de dados pessoais estritamente necessários à execução do contrato, nos termos da Lei 13.709/2018 (LGPD).
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 9ª – DISPOSIÇÕES FINAIS</h3>
                        <p className="text-justify">
                            9.1 O presente instrumento não gera exclusividade, podendo o CONTRATADO prestar serviços a terceiros. 
                        </p>
                        <p className="text-justify">
                            9.2 O foro eleito para dirimir eventuais controvérsias é o da Comarca de Santa Isabel/SP, com renúncia a qualquer outro.
                        </p>
                        <p className="text-justify">
                            9.3: O CONTRATADO compromete-se a não contatar, captar ou prestar serviços educacionais diretamente a alunos ativos da CONTRATANTE durante a vigência deste contrato e pelo prazo de 6 (seis) meses após seu encerramento.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366] mb-1">CLÁUSULA 10ª – PROPRIEDADE INTELECTUAL E USO DE MATERIAL</h3>
                        <p className="text-justify">
                            10.1 Todo o material didático, metodológico, estratégico e visual disponibilizado pela CONTRATANTE, incluindo apostilas, slides, apresentações, roteiros de aula, gravações, identidade visual, logotipo, nome empresarial, marca “Wise Wolf”, bem como qualquer conteúdo desenvolvido no âmbito da escola, constitui propriedade intelectual exclusiva da CONTRATANTE.
                        </p>
                        <p className="text-justify">
                            10.2 O CONTRATADO compromete-se a utilizar referido material exclusivamente para a execução das aulas vinculadas à CONTRATANTE, sendo vedada sua reprodução, distribuição, compartilhamento, adaptação, comercialização ou utilização para fins próprios ou de terceiros.
                        </p>
                    </div>
                </div>

                <p className="mt-4 text-justify italic text-gray-500">
                    E, por estarem justos e contratados, assinam o presente instrumento em duas vias de igual teor, juntamente com duas testemunhas.
                </p>

                {/* Assinaturas */}
                <div className="mt-8 pt-4 border-t border-gray-100">
                    <p className="text-center mb-6">{contractCity}, {displayDate}.</p>

                    <div className="teacher-contract-signatures flex justify-between gap-8 mt-10 min-h-[100px]">
                        {/* Assinatura Wise Wolf */}
                        <div className="flex-1 flex flex-col items-center justify-end relative">
                            <div className="mb-2 flex flex-col items-center gap-1">
                                <img
                                    src="/director-signature.png"
                                    alt="Assinatura Diretor"
                                    className="h-12 object-contain"
                                />
                            </div>
                            <div className="border-t border-black pt-1 w-full text-center relative z-10">
                                <p className="font-bold text-[#002366] text-[10px]">DEBORA ALVES FERNANDES</p>
                                <p className="text-[8px] text-gray-500 uppercase tracking-wide">Contratante (Wise Wolf)</p>
                                <div className="flex items-center justify-center gap-1 text-[8px] text-emerald-600 font-bold mt-0.5 bg-emerald-50 py-0.5 rounded-full w-fit mx-auto px-2">
                                    <ShieldCheck size={8} /> Assinado Digitalmente
                                </div>
                            </div>
                        </div>

                        {/* Assinatura Professor */}
                        <div className="flex-1 flex flex-col items-center justify-end relative">
                            <div className="mb-2 text-center h-12 flex items-end justify-center relative w-full">
                                {acceptedAt ? (
                                    <>
                                        <span className="text-2xl text-gray-800 transform -rotate-1 relative z-10" style={{ fontFamily: '"Dancing Script", cursive' }}>
                                            {teacherName}
                                        </span>
                                        <div className="absolute -right-2 top-0 border border-emerald-200 bg-emerald-50/80 p-1 rounded text-[7px] text-emerald-800 leading-tight w-20 opacity-80 rotate-3">
                                            <p className="font-bold">ASSINADO ELETRONICAMENTE</p>
                                            <p>IP: {userIp || '---'}</p>
                                        </div>
                                    </>
                                ) : (
                                    <span className="text-slate-300 italic text-[10px]">Aguardando Assinatura...</span>
                                )}
                            </div>
                            <div className="border-t border-black pt-1 w-full text-center">
                                <p className="font-bold uppercase text-[10px]">{teacherName || 'Professor'}</p>
                                <p className="text-[8px] text-gray-500 uppercase">CONTRATADO</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Selo de Autenticação Digital */}
                {acceptedAt && (
                    <div className="teacher-contract-seal mt-8 p-4 bg-gray-50 border border-gray-200 rounded-xl relative overflow-hidden flex items-center gap-4">
                        <div className="p-2 bg-emerald-100 text-emerald-600 rounded-full">
                            <ShieldCheck size={32} />
                        </div>
                        <div className="flex-1">
                            <h4 className="text-sm font-black text-[#002366] uppercase tracking-tighter mb-1">Contrato Autenticado</h4>
                            <div className="space-y-0.5 text-[9px] text-gray-500 font-mono">
                                <p><strong>Data:</strong> {new Date(acceptedAt).toLocaleString('pt-BR')}</p>
                                <p><strong>IP:</strong> {userIp || 'Não registrado'}</p>
                                <p><strong>ID:</strong> {subscriptionId || 'PENDING'}</p>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
