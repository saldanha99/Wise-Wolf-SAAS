import React, { useRef } from 'react';
import { useReactToPrint } from 'react-to-print';
import { ShieldCheck } from 'lucide-react';


interface ContractProps {
    studentName: string;
    studentCPF: string;
    studentAddress: string;
    studentEmail: string;
    studentPhone: string;
    planName: string; // Ex: Plano Semestral
    planValue: string; // Ex: 149,90
    totalValue: string; // Ex: 1.678,80
    planDuration: number; // Meses
    startDate: string;
    endDate: string;
    dueDay: number;
    classFrequency: number | string;
    acceptedAt?: string;
    userIp?: string;
    subscriptionId?: string;
}

export function ContractDocument({
    studentName,
    studentCPF,
    studentAddress,
    studentEmail,
    studentPhone,
    planName,
    planValue,
    totalValue,
    planDuration,
    startDate,
    endDate,
    dueDay,

    classFrequency,
    acceptedAt,
    userIp,
    subscriptionId
}: ContractProps) {
    const componentRef = useRef(null);

    const handlePrint = useReactToPrint({
        content: () => componentRef.current,
        documentTitle: `Contrato_WiseWolf_${studentName}`,
    });

    // Data atual formatada para assinatura
    const today = new Date().toLocaleDateString('pt-BR', {
        day: 'numeric', month: 'long', year: 'numeric'
    });

    return (
        <div className="flex flex-col items-center gap-6 p-8 bg-gray-100 min-h-screen">

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
                        Contrato de Prestação de Serviços Educacionais
                    </div>
                </div>

                {/* Identificação das Partes */}
                <div className="mb-6 space-y-2">
                    <p><strong>CONTRATANTE:</strong> {studentName.toUpperCase()}</p>
                    <p>CPF: {studentCPF} | Endereço: {studentAddress}</p>
                    <p>Email: {studentEmail} | Tel: {studentPhone}</p>
                </div>

                <div className="mb-6 space-y-2">
                    <p><strong>CONTRATADA:</strong> WISE WOLF LANGUAGE (CNPJ: 55.806.029/0001-57)</p>
                    <p>Endereço: Rua Um, 256 - Recanto do Céu - Santa Isabel/SP</p>
                    <p>Contato: wisewolflanguage@gmail.com | (11) 97168-1451</p>
                </div>

                {/* Cláusulas */}
                <h3 className="font-bold mb-2 uppercase text-[#002366]">Cláusula 1 - Do Objeto</h3>
                <p className="mb-4 text-justify">
                    O presente contrato tem por objetivo a prestação de serviços educacionais pela Wise Wolf Language ao CONTRATANTE, consistindo em aulas de inglês online, com duração de 30 minutos, ministradas <strong>{classFrequency} vezes por semana</strong>, além de acesso à plataforma de materiais.
                </p>

                <h3 className="font-bold mb-2 uppercase text-[#002366]">Cláusula 2 - Duração</h3>
                <p className="mb-4 text-justify">
                    O contrato terá vigência de <strong>{planDuration} {planDuration === 1 ? 'mês' : 'meses'}</strong>, iniciando em {startDate} e terminando em {endDate}. O CONTRATANTE concorda com a renovação automática salvo manifestação em contrário.
                </p>

                <h3 className="font-bold mb-2 uppercase text-[#002366]">Cláusula 3 - Valor e Pagamento</h3>
                <p className="mb-4 text-justify">
                    O valor total do contrato é de <strong>R$ {totalValue}</strong>, que será pago em <strong>{planDuration} parcelas mensais de R$ {planValue}</strong>, referente ao {planName}. A cobrança será efetuada preferencialmente no dia <strong>{dueDay}</strong> de cada mês.
                </p>

                <h3 className="font-bold mb-2 uppercase text-[#002366]">Cláusula 4 - Obrigações do Contratante</h3>
                <p className="mb-4 text-justify">
                    Compromete-se o CONTRATANTE a: I) Possuir os equipamentos necessários (computador/celular e internet) para acesso às aulas; II) Cumprir os pagamentos nas datas acordadas; III) Comunicar ausências com antecedência mínima de 24 horas para direito à reposição (limitado a 1 por mês).
                </p>

                <h3 className="font-bold mb-2 uppercase text-[#002366]">Cláusula 5 - Direitos da Contratada</h3>
                <p className="mb-4 text-justify">
                    A CONTRATADA poderá: I) Substituir professores titulares em caso de impedimentos; II) Suspender o acesso à plataforma e aulas em caso de inadimplência superior a 7 (sete) dias; III) Reajustar valores anualmente pelo IGPM.
                </p>

                <h3 className="font-bold mb-2 uppercase text-[#002366]">Cláusula 6 - Cancelamento</h3>
                <p className="mb-4 text-justify">
                    Caso o CONTRATANTE opte por cancelar o contrato antes do término da vigência, será aplicada uma <strong>multa rescisória de 30%</strong> sobre o valor restante do contrato, a fim de compensar prejuízos administrativos.
                </p>

                <h3 className="font-bold mb-2 uppercase text-[#002366]">Cláusula 7 - Foro</h3>
                <p className="mb-8 text-justify">
                    As partes elegem o foro da comarca de Santa Isabel - SP para dirimir quaisquer dúvidas oriundas deste contrato.
                </p>

                {/* Assinaturas */}
                <div className="mt-12 pt-8 border-t border-gray-300">
                    <p className="text-center mb-8">Santa Isabel - SP, {today}</p>

                    <div className="flex justify-between gap-8 mt-16 min-h-[120px]">
                        {/* Assinatura Wise Wolf */}
                        {/* Assinatura Wise Wolf (Imagem Oficial) */}
                        <div className="flex-1 flex flex-col items-center justify-end relative">
                            {/* Assinatura Cursiva do Diretor e Carimbo Digital */}
                            <div className="mb-2 flex flex-col items-center gap-1">
                                <img
                                    src="/director-signature.png"
                                    alt="Assinatura Diretor"
                                    className="h-16 object-contain"
                                />
                            </div>
                            <div className="border-t border-black pt-2 w-full text-center relative z-10">
                                <p className="font-bold text-[#002366]">WISE WOLF LANGUAGE</p>
                                <p className="text-[10px] text-gray-500 uppercase tracking-wide">CNPJ: 55.806.029/0001-57</p>
                                <div className="flex items-center justify-center gap-1 text-[9px] text-emerald-600 font-bold mt-1 bg-emerald-50 py-0.5 rounded-full w-fit mx-auto px-2">
                                    <ShieldCheck size={10} /> Assinado Digitalmente
                                </div>
                            </div>
                        </div>

                        {/* Assinatura Aluno */}
                        {/* Assinatura Aluno */}
                        <div className="flex-1 flex flex-col items-center justify-end relative">
                            {/* Assinatura Cursiva do Aluno */}
                            <div className="mb-2 text-center h-16 flex items-end justify-center relative w-full">
                                {acceptedAt ? (
                                    <>
                                        <span className="text-3xl text-slate-800 transform -rotate-1 relative z-10" style={{ fontFamily: '"Dancing Script", cursive' }}>
                                            {studentName}
                                        </span>
                                        {/* Carimbo de Segurança ao lado */}
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
                                <p className="font-bold uppercase text-xs">{studentName}</p>
                                <p className="text-[10px] text-slate-500 uppercase">CONTRATANTE</p>
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
                        {/* Marca d'água */}
                        <div className="absolute -right-10 -bottom-10 text-slate-200/50 rotate-[-15deg]">
                            <ShieldCheck size={180} />
                        </div>
                    </div>
                )}

            </div>

        </div>
    );
}
