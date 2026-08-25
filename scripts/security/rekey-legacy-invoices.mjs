import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const requireFromProject = createRequire(path.join(process.cwd(), 'package.json'));
const { createClient } = requireFromProject('@supabase/supabase-js');

const required = (name) => {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`missing_${name}`);
  return value;
};

const apiUrl = required('SUPABASE_URL');
const serviceKey = required('SUPABASE_SERVICE_ROLE_KEY');
const rekeyDir = required('REKEY_DIR');
const mode = required('REKEY_MODE');
const expectedCount = Number(required('EXPECTED_COUNT'));
const bucket = 'invoices';
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const uuidFragment = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const canonicalPattern = new RegExp(`^closings/${uuidFragment}/${uuidFragment}\\.pdf$`, 'i');
const quarantinePattern = new RegExp(
  `^quarantine/20260825-legacy-invoice-audit/${uuidFragment}\\.pdf$`,
  'i',
);

if (!Number.isSafeInteger(expectedCount) || expectedCount < 1) {
  throw new Error('invalid_expected_count');
}

const client = createClient(apiUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const storage = client.storage.from(bucket);
const digest = (buffer) => createHash('sha256').update(buffer).digest('hex');
const manifestPath = path.join(rekeyDir, 'manifest.json');
const classifiedManifestPath = path.join(rekeyDir, 'classified-manifest.json');

const download = async (objectPath) => {
  const { data, error } = await storage.download(objectPath);
  if (error || !data) throw error || new Error('download_failed');
  return Buffer.from(await data.arrayBuffer());
};

const verifyPdf = (bytes) => {
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('non_pdf_object');
  }
  if (bytes.length > 5 * 1024 * 1024) throw new Error('oversized_pdf_object');
};

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

const readManifest = async (classified = false) => {
  const source = classified ? classifiedManifestPath : manifestPath;
  const manifest = JSON.parse(await readFile(source, 'utf8'));
  if (manifest.bucket !== bucket || manifest.entries?.length !== expectedCount) {
    throw new Error('manifest_scope_mismatch');
  }
  return manifest;
};

if (mode === 'backup') {
  await mkdir(path.join(rekeyDir, 'objects'), { recursive: true, mode: 0o700 });
  const { data: closings, error } = await client
    .from('teacher_closings')
    .select('id,tenant_id,teacher_id,nf_link')
    .not('nf_link', 'is', null);
  if (error) throw error;

  const legacyClosings = (closings || []).filter((closing) => {
    const reference = String(closing.nf_link || '').trim();
    return reference && !canonicalPattern.test(reference);
  });
  if (legacyClosings.length !== expectedCount) {
    throw new Error(`unexpected_legacy_count_${legacyClosings.length}`);
  }

  const oldPaths = new Set();
  const entries = [];
  for (const closing of legacyClosings) {
    if (!uuidPattern.test(closing.id) || !uuidPattern.test(closing.teacher_id)) {
      throw new Error('invalid_closing_identity');
    }
    const oldPath = String(closing.nf_link).trim();
    if (
      oldPath.startsWith('http://')
      || oldPath.startsWith('https://')
      || oldPath.startsWith('quarantine/')
      || oldPath.length > 512
      || oldPath.includes('\0')
      || oldPaths.has(oldPath)
    ) {
      throw new Error('unsafe_or_duplicate_legacy_path');
    }
    oldPaths.add(oldPath);

    const bytes = await download(oldPath);
    verifyPdf(bytes);
    const sha256 = digest(bytes);
    const backupFile = `objects/${closing.id}.pdf`;
    const newPath = `closings/${closing.id}/${randomUUID()}.pdf`;
    await writeFile(path.join(rekeyDir, backupFile), bytes, { mode: 0o600, flag: 'wx' });
    entries.push({
      closingId: closing.id,
      tenantId: closing.tenant_id,
      teacherId: closing.teacher_id,
      oldPath,
      newPath,
      backupFile,
      size: bytes.length,
      sha256,
    });
  }

  const manifest = {
    bucket,
    createdAt: new Date().toISOString(),
    entries,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await writeFile(
    path.join(rekeyDir, 'SHA256SUMS'),
    `${entries.map((entry) => `${entry.sha256}  ${entry.backupFile}`).join('\n')}\n`,
    { mode: 0o600, flag: 'wx' },
  );

  const updateStatements = entries.map((entry) => `
    UPDATE public.teacher_closings
    SET nf_link = ${sqlLiteral(entry.newPath)}, updated_at = now()
    WHERE id = ${sqlLiteral(entry.closingId)}::uuid
      AND nf_link = ${sqlLiteral(entry.oldPath)};
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'invoice_rekey_compare_and_set_failed';
    END IF;`).join('\n');
  const sql = `BEGIN;
DO $invoice_rekey$
DECLARE changed_rows integer;
BEGIN
${updateStatements}
END
$invoice_rekey$;
COMMIT;
`;
  await writeFile(path.join(rekeyDir, 'apply.sql'), sql, { mode: 0o600, flag: 'wx' });
  console.log(`legacy_invoice_backup=ok objects=${entries.length}`);
} else if (mode === 'classify') {
  const manifest = await readManifest();
  const tenantIds = [...new Set(manifest.entries.map((entry) => entry.tenantId))];
  const { data: memberships, error: membershipError } = await client
    .from('tenant_memberships')
    .select('user_id,tenant_id')
    .in('tenant_id', tenantIds)
    .eq('role', 'TEACHER')
    .eq('status', 'ACTIVE');
  if (membershipError) throw membershipError;

  const teacherIds = [...new Set((memberships || []).map((membership) => membership.user_id))];
  const { data: profiles, error: profileError } = await client
    .from('profiles')
    .select('id,full_name')
    .in('id', teacherIds);
  if (profileError) throw profileError;

  const normalize = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const nameById = new Map((profiles || []).map((profile) => [profile.id, normalize(profile.full_name)]));
  const classifiedEntries = manifest.entries.map((entry) => {
    const text = normalize(execFileSync(
      'pdftotext',
      [path.join(rekeyDir, entry.backupFile), '-'],
      { encoding: 'utf8', maxBuffer: 5_000_000 },
    ));
    const intendedName = nameById.get(entry.teacherId) || '';
    const otherTeacherMatched = (memberships || [])
      .filter((membership) => (
        membership.tenant_id === entry.tenantId
        && membership.user_id !== entry.teacherId
      ))
      .some((membership) => {
        const name = nameById.get(membership.user_id) || '';
        return name.length >= 5 && text.includes(name);
      });
    const classification = intendedName.length >= 5 && text.includes(intendedName)
      ? 'ROTATE'
      : otherTeacherMatched
        ? 'QUARANTINE_WRONG_TEACHER'
        : 'QUARANTINE_UNVERIFIED';
    return {
      ...entry,
      classification,
      quarantinePath: classification === 'ROTATE'
        ? null
        : `quarantine/20260825-legacy-invoice-audit/${randomUUID()}.pdf`,
    };
  });
  const classifiedManifest = {
    ...manifest,
    classifiedAt: new Date().toISOString(),
    entries: classifiedEntries,
  };
  await writeFile(
    classifiedManifestPath,
    `${JSON.stringify(classifiedManifest, null, 2)}\n`,
    { mode: 0o600, flag: 'wx' },
  );

  const updateStatements = classifiedEntries.map((entry) => {
    if (entry.classification === 'ROTATE') {
      return `
    UPDATE public.teacher_closings
    SET nf_link = ${sqlLiteral(entry.newPath)}, updated_at = now()
    WHERE id = ${sqlLiteral(entry.closingId)}::uuid
      AND nf_link = ${sqlLiteral(entry.oldPath)};
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'invoice_rekey_compare_and_set_failed';
    END IF;`;
    }
    return `
    UPDATE public.teacher_closings
    SET nf_link = NULL,
        status = CASE
          WHEN coalesce(total_amount, 0) > 0
            AND (
              paid_at IS NOT NULL
              OR upper(coalesce(status, '')) IN (
                'PAID_WAITING_NF', 'PAGO', 'PAID', 'COMPLETED',
                'UNDER_REVIEW', 'REJECTED', 'REJEITADO'
              )
            )
          THEN 'PAID_WAITING_NF'
          ELSE status
        END,
        rejection_reason = 'Arquivo anterior removido após validação de segurança. Envie sua própria NFS-e novamente.',
        nf_tour_ack_at = NULL,
        updated_at = now()
    WHERE id = ${sqlLiteral(entry.closingId)}::uuid
      AND nf_link = ${sqlLiteral(entry.oldPath)};
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    IF changed_rows <> 1 THEN
      RAISE EXCEPTION 'invoice_quarantine_compare_and_set_failed';
    END IF;`;
  }).join('\n');
  const sql = `BEGIN;
DO $invoice_rekey$
DECLARE changed_rows integer;
BEGIN
${updateStatements}
END
$invoice_rekey$;
COMMIT;
`;
  await writeFile(path.join(rekeyDir, 'apply-classified.sql'), sql, {
    mode: 0o600,
    flag: 'wx',
  });

  const rotated = classifiedEntries.filter((entry) => entry.classification === 'ROTATE').length;
  const quarantined = classifiedEntries.length - rotated;
  console.log(`legacy_invoice_classify=ok rotate=${rotated} quarantine=${quarantined}`);
} else if (mode === 'prepare') {
  const manifest = await readManifest(true);
  let prepared = 0;
  for (const entry of manifest.entries) {
    const destination = entry.classification === 'ROTATE'
      ? entry.newPath
      : entry.quarantinePath;
    if (
      (entry.classification === 'ROTATE' && !canonicalPattern.test(destination))
      || (entry.classification !== 'ROTATE'
        && !quarantinePattern.test(destination))
    ) {
      throw new Error('invalid_destination_path');
    }
    const bytes = await readFile(path.join(rekeyDir, entry.backupFile));
    verifyPdf(bytes);
    if (bytes.length !== entry.size || digest(bytes) !== entry.sha256) {
      throw new Error('backup_hash_mismatch');
    }

    const { error } = await storage.upload(destination, bytes, {
      contentType: 'application/pdf',
      cacheControl: '0',
      upsert: false,
    });
    if (error && !/already exists|duplicate/i.test(error.message || '')) throw error;
    const uploaded = await download(destination);
    if (uploaded.length !== entry.size || digest(uploaded) !== entry.sha256) {
      throw new Error('prepared_hash_mismatch');
    }
    prepared += 1;
  }
  console.log(`legacy_invoice_prepare=ok objects=${prepared}`);
} else if (mode === 'finalize' || mode === 'verify') {
  const manifest = await readManifest(true);
  const closingIds = manifest.entries.map((entry) => entry.closingId);
  const { data: closings, error } = await client
    .from('teacher_closings')
    .select('id,nf_link')
    .in('id', closingIds);
  if (error) throw error;
  const currentById = new Map((closings || []).map((closing) => [closing.id, closing.nf_link]));

  let verified = 0;
  for (const entry of manifest.entries) {
    const expectedReference = entry.classification === 'ROTATE' ? entry.newPath : null;
    const destination = entry.classification === 'ROTATE'
      ? entry.newPath
      : entry.quarantinePath;
    if (currentById.get(entry.closingId) !== expectedReference) {
      throw new Error('closing_not_rekeyed');
    }
    const current = await download(destination);
    if (current.length !== entry.size || digest(current) !== entry.sha256) {
      throw new Error('canonical_hash_mismatch');
    }

    if (mode === 'finalize') {
      const { error: removeError } = await storage.remove([entry.oldPath]);
      if (removeError) throw removeError;
    }
    const legacy = await storage.download(entry.oldPath);
    if (!legacy.error || legacy.data) throw new Error('legacy_object_still_downloadable');
    verified += 1;
  }
  console.log(`legacy_invoice_${mode}=ok objects=${verified}`);
} else {
  throw new Error('invalid_mode');
}
