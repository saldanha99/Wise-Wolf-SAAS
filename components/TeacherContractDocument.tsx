import React, { useRef } from 'react';
import { useReactToPrint } from 'react-to-print';
import { ShieldCheck } from 'lucide-react';

interface TeacherContractProps {
    teacherName: string;
    teacherRG: string;
    teacherCPF: string;
    teacherAddress: string;
    teacherBirthDate: string;
    contractCity: string; // Ex: Santa Isabel/SP
    contractDate: string; // Ex: 19 de agosto de 2025
    acceptedAt?: string;
    userIp?: string;
    subscriptionId?: string;
}

export function TeacherContractDocument({
    teacherName,
    teacherRG,
    teacherCPF,
    teacherAddress,
    teacherBirthDate,
    contractCity = "Santa Isabel/SP",
    contractDate,
    acceptedAt,
    userIp,
    subscriptionId
}: TeacherContractProps) {
    const componentRef = useRef(null);

    const handlePrint = useReactToPrint({
        content: () => componentRef.current,
        documentTitle: `Contrato_Professor_WiseWolf_${teacherName}`,
    });

    // Data atual se não fornecida
    const displayDate = contractDate || new Date().toLocaleDateString('pt-BR', {
        day: 'numeric', month: 'long', year: 'numeric'
    });

    return (
        <div className="flex flex-col items-center gap-6 p-8 bg-gray-100 min-h-screen">

            {/* Botão de Ação (Aparece apenas na tela) */}
            <div className="w-full max-w-[210mm] flex justify-end print:hidden">
                <button
                    onClick={handlePrint}
                    className="bg-[#002366] text-white px-6 py-2 rounded-lg font-bold hover:bg-[#001a4d] transition-all flex items-center gap-2"
                >
                    🖨️ Imprimir / Salvar PDF
                </button>
            </div>

            {/* Folha A4 do Contrato */}
            <div
                ref={componentRef}
                className="w-[210mm] min-h-[297mm] bg-white p-[25mm] shadow-2xl text-slate-900 text-sm leading-relaxed"
                style={{ fontFamily: 'Arial, sans-serif' }}
            >
                <style>{`
                    @import url('https://fonts.googleapis.com/css2?family=Dancing+Script:wght@400;700&family=Great+Vibes&display=swap');
                `}</style>
                {/* Cabeçalho */}
                <div className="flex justify-between items-center mb-8 border-b-2 border-[#002366] pb-4">
                    <div className="text-2xl font-black text-[#002366] tracking-tighter">
                        WISE WOLF <span className="text-red-600">LANGUAGE</span>
                    </div>
                    <div className="text-right text-xs text-gray-500">
                        Contrato de Prestação de Serviços Educacionais - Pessoa Física
                    </div>
                </div>

                <h1 className="text-center font-bold text-lg mb-8 uppercase">CONTRATO DE PRESTAÇÃO DE SERVIÇOS EDUCACIONAIS – PESSOA FÍSICA</h1>

                {/* Identificação das Partes */}
                <div className="mb-6 space-y-4 text-justify">
                    <p>
                        <strong>CONTRATANTE:</strong> Débora Alves Fernandes, brasileira, solteira, nascida em 23/03/1999, portadora do CPF nº 506.398.248-46, domiciliada na Rua Um, nº 256, Santa Isabel – SP, CEP 07500-000, doravante denominada <strong>“WISE WOLF”</strong>.
                    </p>
                    <p>
                        <strong>CONTRATADO:</strong> {teacherName}, brasileiro(a), nascido(a) em {teacherBirthDate}, portador(a) do RG nº {teacherRG}, CPF nº {teacherCPF}, domiciliado(a) em {teacherAddress}, doravante denominado <strong>“PROFESSOR”</strong>.
                    </p>
                </div>

                {/* Cláusulas */}
                <div className="space-y-4">
                    <div>
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 1ª – OBJETO</h3>
                        <p className="text-justify">
                            1.1 O presente contrato tem por objeto a prestação de serviços de aulas de inglês pelo CONTRATADO, sob orientação pedagógica e com materiais fornecidos pela CONTRATANTE.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 2ª – NATUREZA DA RELAÇÃO</h3>
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
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 3ª – REMUNERAÇÃO</h3>
                        <p className="text-justify">
                            3.1 Pelo serviço prestado, o CONTRATADO receberá o equivalente a 50% (cinquenta por cento) do valor efetivamente pago pelo aluno à CONTRATANTE, referente às aulas ministradas.
                        </p>
                        <p className="text-justify">
                            3.2 O pagamento será realizado até o dia 10 de cada mês, independentemente da regularidade do pagamento dos alunos à CONTRATANTE, via PIX ou transferência bancária.
                        </p>
                        <p className="text-justify">
                            3.3 O pagamento aqui ajustado constitui remuneração de serviço autônomo, não integrando qualquer verba de natureza trabalhista.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 4ª – OBRIGAÇÕES DO CONTRATADO</h3>
                        <p className="text-justify">
                            Ministrar as aulas de forma pontual e diligente. Utilizar o material pedagógico fornecido pela CONTRATANTE. Arcar com eventuais despesas pessoais necessárias à execução dos serviços (internet, transporte, equipamentos etc.). Manter sigilo sobre dados, informações, conteúdos e estratégias da CONTRATANTE e de seus alunos.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 5ª – OBRIGAÇÕES DA CONTRATANTE</h3>
                        <p className="text-justify">
                            Disponibilizar o material didático. Indicar os horários e turmas a serem atendidas. Realizar os repasses devidos na forma da Cláusula 3ª.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 6ª – PRAZO E RESCISÃO</h3>
                        <p className="text-justify">
                            6.1 O presente contrato é firmado por prazo indeterminado, vigorando enquanto houver interesse das partes.
                        </p>
                        <p className="text-justify">
                            6.2 Qualquer das partes poderá rescindir o contrato mediante aviso prévio de 15 (quinze) dias.
                        </p>
                        <p className="text-justify">
                            6.3 O descumprimento contratual autoriza a rescisão imediata, sem prejuízo de eventuais indenizações por perdas e danos.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 7ª – RESPONSABILIDADES TRIBUTÁRIAS</h3>
                        <p className="text-justify">
                            7.1 O CONTRATADO é responsável pelo recolhimento de seus próprios tributos e contribuições (inclusive INSS autônomo, se optar), não recaindo sobre a CONTRATANTE qualquer obrigação previdenciária, trabalhista ou tributária.
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 8ª – PROTEÇÃO DE DADOS (LGPD)</h3>
                        <p className="text-justify">
                            8.1 As partes autorizam a coleta e o tratamento de dados pessoais estritamente necessários à execução do contrato, nos termos da Lei 13.709/2018 (LGPD).
                        </p>
                    </div>

                    <div>
                        <h3 className="font-bold uppercase text-[#002366]">CLÁUSULA 9ª – DISPOSIÇÕES FINAIS</h3>
                        <p className="text-justify">
                            9.1 O presente instrumento não gera exclusividade, podendo o CONTRATADO prestar serviços a terceiros.
                        </p>
                        <p className="text-justify">
                            9.2 O foro eleito para dirimir eventuais controvérsias é o da Comarca de Santa Isabel/SP, com renúncia a qualquer outro.
                        </p>
                    </div>
                </div>

                <p className="mt-6 text-justify">
                    E, por estarem justos e contratados, assinam o presente instrumento em duas vias de igual teor, juntamente com duas testemunhas.
                </p>

                {/* Assinaturas */}
                <div className="mt-12 pt-8 border-t border-gray-300">
                    <p className="text-center mb-8">{contractCity}, {displayDate}.</p>

                    <div className="flex justify-between gap-8 mt-16 min-h-[120px]">
                        {/* Assinatura Wise Wolf */}
                        <div className="flex-1 flex flex-col items-center justify-end relative">
                            <div className="mb-2 flex flex-col items-center gap-1">
                                {/* Imagem de Assinatura (Mesma do aluno) */}
                                <img
                                    src="/director-signature.png"
                                    alt="Assinatura Diretor"
                                    className="h-16 object-contain"
                                />
                            </div>
                            <div className="border-t border-black pt-2 w-full text-center relative z-10">
                                <p className="font-bold text-[#002366]">DEBORA ALVES FERNANDES</p>
                                <p className="text-[10px] text-gray-500 uppercase tracking-wide">Contratante (Wise Wolf)</p>
                                <div className="flex items-center justify-center gap-1 text-[9px] text-emerald-600 font-bold mt-1 bg-emerald-50 py-0.5 rounded-full w-fit mx-auto px-2">
                                    <ShieldCheck size={10} /> Assinado Digitalmente
                                </div>
                            </div>
                        </div>

                        {/* Assinatura Professor */}
                        <div className="flex-1 flex flex-col items-center justify-end relative">
                            <div className="mb-2 text-center h-16 flex items-end justify-center relative w-full">
                                {acceptedAt ? (
                                    <>
                                        <span className="text-3xl text-slate-800 transform -rotate-1 relative z-10" style={{ fontFamily: '"Dancing Script", cursive' }}>
                                            {teacherName}
                                        </span>
                                        {/* Carimbo de Segurança */}
                                        <div className="absolute -right-4 top-0 border border-emerald-200 bg-emerald-50/80 p-1.5 rounded text-[8px] text-emerald-800 leading-tight w-24 opacity-80 rotate-3">
                                            <p className="font-bold">ASSINADO ELETRONICAMENTE</p>
                                            <p>Portal Wise Wolf</p>
                                            <p className="truncate">IP: {userIp || '---'}</p>
                                            <p className="truncate">ID: {subscriptionId?.substring(0, 8) || '---'}</p>
                                        </div>
                                    </>
                                ) : (
                                    <span className="text-slate-300 italic text-sm">Aguardando Assinatura...</span>
                                )}
                            </div>
                            <div className="border-t border-black pt-2 w-full text-center">
                                <p className="font-bold uppercase text-xs">{teacherName}</p>
                                <p className="text-[10px] text-slate-500 uppercase">CONTRATADO (Professor)</p>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Selo de Autenticação Digital */}
                {acceptedAt && (
                    <div className="mt-12 p-6 bg-slate-50 border border-slate-200 rounded-xl relative overflow-hidden">
                        <div className="flex items-center gap-6 relative z-10">
                            <div className="p-4 bg-emerald-100 text-emerald-600 rounded-full">
                                <ShieldCheck size={48} />
                            </div>
                            <div className="flex-1">
                                <h4 className="text-lg font-black text-[#002366] uppercase tracking-tighter mb-2">Autenticado Digitalmente</h4>
                                <div className="space-y-1 text-xs text-slate-600 font-mono">
                                    <p><strong>Assinado em:</strong> {new Date(acceptedAt).toLocaleString('pt-BR')}</p>
                                    <p><strong>IP de Registro:</strong> {userIp || 'Não registrado'}</p>
                                    <p><strong>Protocolo de Segurança:</strong> {subscriptionId || 'PENDING'}</p>
                                    <p className="text-[10px] text-slate-400 mt-2 italic">Este documento possui validade jurídica conforme MP 2.200-2/2001.</p>
                                </div>
                            </div>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
