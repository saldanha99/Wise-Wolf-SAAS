import {
  legalSignatureLocation,
  materializeLegalSchoolInfo,
  storedLegalSignatureLocation,
  TENANT_LEGAL_ASSETS_BUCKET,
} from "./tenant-legal-assets.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const tenantId = "tenant-a";
const assetId = "00000000-0000-4000-8000-000000000001";

Deno.test("aceita apenas caminhos juridicos do proprio tenant", () => {
  const privatePath =
    `${tenantId}/legal-representative-signature/${assetId}.png`;
  assert(
    legalSignatureLocation(privatePath, tenantId)?.bucket ===
      TENANT_LEGAL_ASSETS_BUCKET,
    "caminho privado nao foi reconhecido",
  );
  for (
    const invalid of [
      `tenant-b/legal-representative-signature/${assetId}.png`,
      `${tenantId}/signature/${assetId}.webp`,
      `${tenantId}/logo/${assetId}.png`,
      `${tenantId}/legal-representative-signature/not-a-uuid.png`,
      `${tenantId}/legal-representative-signature/${assetId}.svg`,
    ]
  ) {
    assert(
      !legalSignatureLocation(invalid, tenantId),
      `${invalid} deveria falhar`,
    );
  }
});

Deno.test("rejeita URL publica legada e exige reupload privado", () => {
  const legacyUrl =
    `https://api.example.test/storage/v1/object/public/tenant-branding/${tenantId}/signature/${assetId}.jpg`;
  assert(
    !storedLegalSignatureLocation(
      { legalRepresentativeSignatureUrl: legacyUrl },
      tenantId,
    ),
    "URL publica legada nao pode ser materializada",
  );
  assert(
    !storedLegalSignatureLocation(
      {
        legalRepresentativeSignatureUrl:
          "https://tracker.invalid/signature.png",
      },
      tenantId,
    ),
    "URL externa nunca pode virar assinatura confiavel",
  );
});

Deno.test("materializa URL curta sem devolver o caminho no fluxo publico", async () => {
  const path = `${tenantId}/legal-representative-signature/${assetId}.png`;
  let signedBucket = "";
  let signedPath = "";
  let signedTtl = 0;
  const admin = {
    storage: {
      from(bucket: string) {
        signedBucket = bucket;
        return {
          createSignedUrl(candidatePath: string, ttl: number) {
            signedPath = candidatePath;
            signedTtl = ttl;
            return Promise.resolve({
              data: {
                signedUrl: "https://signed.example.test/object?token=short",
              },
              error: null,
            });
          },
        };
      },
    },
  };
  const result = await materializeLegalSchoolInfo(
    admin as never,
    tenantId,
    {
      legalName: "School A",
      legalRepresentativeSignaturePath: path,
      signatureUrl: "https://untrusted.invalid/old.png",
    },
  );
  assert(signedBucket === TENANT_LEGAL_ASSETS_BUCKET, "bucket incorreto");
  assert(signedPath === path, "path incorreto");
  assert(signedTtl === 900, "URL precisa ter validade curta");
  assert(
    result?.legalRepresentativeSignatureUrl ===
      "https://signed.example.test/object?token=short",
    "URL assinada nao foi entregue",
  );
  assert(
    !("legalRepresentativeSignaturePath" in (result || {})),
    "fluxo publico nao deve expor caminho interno",
  );
  assert(!("signatureUrl" in (result || {})), "alias legado nao foi removido");
});

Deno.test("troca a origem interna pela API publica sem alterar path ou token", async () => {
  const path = `${tenantId}/legal-representative-signature/${assetId}.png`;
  const admin = {
    storage: {
      from() {
        return {
          createSignedUrl() {
            return Promise.resolve({
              data: {
                signedUrl:
                  `http://kong:8000/storage/v1/object/sign/${TENANT_LEGAL_ASSETS_BUCKET}/${path}?token=short`,
              },
              error: null,
            });
          },
        };
      },
    },
  };

  const result = await materializeLegalSchoolInfo(
    admin as never,
    tenantId,
    { legalRepresentativeSignaturePath: path },
    { publicBaseUrl: "https://api.example.test" },
  );

  assert(
    result?.legalRepresentativeSignatureUrl ===
      `https://api.example.test/storage/v1/object/sign/${TENANT_LEGAL_ASSETS_BUCKET}/${path}?token=short`,
    "a URL assinada precisa usar a origem publica configurada",
  );
});
