/**
 * sign-contract — Generates HMAC, PDF, and registers the signature.
 *
 * 1. Receives payload with contract text, user IP, CPF, and visual signature.
 * 2. Computes HMAC of the evidence payload.
 * 3. Calls submit_enrollment_signature RPC.
 * 4. Generates PDF with pdf-lib.
 * 5. Uploads PDF to Supabase Storage.
 * 6. Returns signature ID and PDF URL.
 */

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.21.0";
import { PDFDocument, StandardFonts, rgb } from 'https://cdn.skypack.dev/pdf-lib';
import { createHash, createHmac } from "https://deno.land/std@0.168.0/crypto/mod.ts";

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const HMAC_SECRET = Deno.env.get('HMAC_SECRET') || 'default-secret-do-not-use-in-prod';

serve(async (req) => {
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
            { auth: { autoRefreshToken: false, persistSession: false } }
        );

        // 1. Extract inputs
        const body = await req.json();
        const {
            tenant_id,
            prospect_id,
            tentative_enrollment_id,
            contract_text,
            signer_full_name,
            signer_cpf,
            signer_email,
            signer_phone,
            signer_user_agent,
            signer_geo,
            otp_method,
            otp_code,
            acceptance_text,
            visual_signature_data,
            is_guardian_signature
        } = body;

        const signer_ip = req.headers.get('x-forwarded-for') || req.headers.get('cf-connecting-ip') || '127.0.0.1';

        // 2. Compute Contract Hash
        const contractHashStr = await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(contract_text)
        );
        const contract_hash = Array.from(new Uint8Array(contractHashStr))
            .map(b => b.toString(16).padStart(2, '0')).join('');

        // 3. Prepare Evidence Payload and HMAC
        const evidence_payload = {
            ip: signer_ip,
            userAgent: signer_user_agent,
            geo: signer_geo,
            timestamp: new Date().toISOString(),
            cpf: signer_cpf, // Raw CPF is included in evidence before hashing
            email: signer_email,
            phone: signer_phone,
            contract_hash
        };

        const evidence_hmac = createHmac("sha256", HMAC_SECRET)
            .update(JSON.stringify(evidence_payload))
            .toString("hex");

        // 4. Call RPC to submit signature securely
        const { data: rpcResult, error: rpcError } = await supabaseAdmin.rpc('submit_enrollment_signature', {
            p_tenant_id: tenant_id,
            p_prospect_id: prospect_id,
            p_tentative_enrollment_id: tentative_enrollment_id,
            p_contract_text: contract_text,
            p_contract_hash: contract_hash,
            p_signer_full_name: signer_full_name,
            p_signer_cpf: signer_cpf,
            p_signer_email: signer_email,
            p_signer_phone: signer_phone,
            p_signer_ip: signer_ip,
            p_signer_user_agent: signer_user_agent,
            p_signer_geo: signer_geo,
            p_otp_method: otp_method,
            p_otp_code: otp_code,
            p_acceptance_text: acceptance_text,
            p_visual_signature_data: visual_signature_data,
            p_evidence_payload: evidence_payload,
            p_evidence_hmac: evidence_hmac,
            p_is_guardian_signature: is_guardian_signature || false
        });

        if (rpcError) throw rpcError;
        if (!rpcResult.success) {
            throw new Error(`Signature rejection: ${rpcResult.error}`);
        }

        const signatureId = rpcResult.signature_id;

        // 5. Generate PDF
        const pdfDoc = await PDFDocument.create();
        let page = pdfDoc.addPage([595.28, 841.89]); // A4
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        
        let yPos = 800;
        const margin = 50;
        const drawText = (text: string, size = 12) => {
            if (yPos < 50) {
                page = pdfDoc.addPage([595.28, 841.89]);
                yPos = 800;
            }
            page.drawText(text, { x: margin, y: yPos, size, font, color: rgb(0,0,0) });
            yPos -= (size + 5);
        };

        drawText(`Contrato de Matricula - Wise Wolf`, 18);
        yPos -= 20;

        // Simple text wrap
        const words = contract_text.split(' ');
        let currentLine = '';
        for (const word of words) {
            if (currentLine.length + word.length > 80) {
                drawText(currentLine, 10);
                currentLine = word + ' ';
            } else {
                currentLine += word + ' ';
            }
        }
        if (currentLine) drawText(currentLine, 10);

        yPos -= 30;
        drawText(`Assinado Eletronicamente por: ${signer_full_name}`, 12);
        drawText(`CPF: ***.***.***-**`, 12); // Masked on PDF
        drawText(`IP: ${signer_ip}`, 10);
        drawText(`Data: ${evidence_payload.timestamp}`, 10);
        drawText(`Hash de Evidencia (HMAC): ${evidence_hmac.substring(0, 32)}...`, 10);

        const pdfBytes = await pdfDoc.save();

        // 6. Upload PDF to Storage
        const fileName = `${tenant_id}/${signatureId}.pdf`;
        const { error: uploadError } = await supabaseAdmin
            .storage
            .from('contracts')
            .upload(fileName, pdfBytes, {
                contentType: 'application/pdf',
                upsert: true
            });

        let pdfUrl = null;
        if (!uploadError) {
            pdfUrl = fileName; // Store the relative path instead of publicUrl since bucket is private

            // Update signature with pdf URL
            await supabaseAdmin.from('enrollment_signatures')
                .update({ pdf_url: pdfUrl })
                .eq('id', signatureId);
        } else {
            console.error("PDF Upload Error:", uploadError);
        }

        return new Response(
            JSON.stringify({ success: true, signature_id: signatureId, pdf_url: pdfUrl }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 }
        );

    } catch (err: any) {
        console.error("Sign-contract error:", err);
        return new Response(
            JSON.stringify({ error: err.message }),
            { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
        );
    }
});
