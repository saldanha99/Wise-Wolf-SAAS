[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256Hex {
  param([Parameter(Mandatory = $true)][string]$LiteralPath)

  $stream = $null
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $stream = [IO.File]::OpenRead($LiteralPath)
    return (($sha256.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '')
  }
  finally {
    if ($stream) { $stream.Dispose() }
    $sha256.Dispose()
  }
}

$projectDir = Split-Path -Parent $PSScriptRoot
$stagingDir = Join-Path $projectDir 'deploy\vps\staging'
$stage = $null
$archive = $null
$apiUrl = (& ssh wisewolf-vps "grep '^SUPABASE_PUBLIC_URL=' /opt/wisewolf/supabase-docker/.env | head -n 1 | cut -d= -f2-").Trim()
if ($LASTEXITCODE -ne 0) {
  throw 'Não foi possível obter a configuração pública de build da VPS.'
}
$anonKey = (& ssh wisewolf-vps "grep '^ANON_KEY=' /opt/wisewolf/supabase-docker/.env | head -n 1 | cut -d= -f2-").Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($apiUrl) -or [string]::IsNullOrWhiteSpace($anonKey)) {
  throw 'A configuração pública de build está incompleta.'
}

$apiUri = $null
$allowedApiPaths = @('/', '/auth/v1', '/auth/v1/')
if (-not [Uri]::TryCreate($apiUrl, [UriKind]::Absolute, [ref]$apiUri) -or
    $apiUri.Scheme -ne 'https' -or
    $apiUri.Host -ne 'api.wisewolflanguage.com.br' -or
    $apiUri.Query -or
    $apiUri.Fragment -or
    $allowedApiPaths -notcontains $apiUri.AbsolutePath) {
  throw 'SUPABASE_PUBLIC_URL deve apontar para a origem HTTPS da API pública ou para o caminho legado /auth/v1.'
}

# supabase-js acrescenta /auth/v1, /rest/v1 e demais caminhos de serviço.
# Sempre compile com a origem para impedir segmentos duplicados.
$env:VITE_SUPABASE_URL = $apiUri.GetLeftPart([UriPartial]::Authority)
$env:VITE_SUPABASE_ANON_KEY = $anonKey
Push-Location $projectDir
try {
  & npm run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'Typecheck falhou.' }
  & npm test
  if ($LASTEXITCODE -ne 0) { throw 'Testes falharam.' }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Build falhou.' }

  $hash = (Get-Sha256Hex -LiteralPath (Join-Path $projectDir 'dist\index.html')).Substring(0, 12)
  $releaseId = "$((Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ'))-$hash"
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $stage = Join-Path $tempRoot "wisewolf-staging-$releaseId"
  if (-not ([IO.Path]::GetFullPath($stage).StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase))) {
    throw 'Diretório temporário inválido.'
  }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -Recurse -LiteralPath (Join-Path $projectDir 'dist') -Destination (Join-Path $stage 'dist')
  Copy-Item -LiteralPath (Join-Path $stagingDir 'docker-compose.yml') -Destination $stage
  Copy-Item -LiteralPath (Join-Path $stagingDir 'nginx.conf') -Destination $stage
  $archive = "$stage.tar.gz"
  & tar --force-local -czf $archive -C $stage .
  if ($LASTEXITCODE -ne 0) { throw 'Empacotamento falhou.' }

  & scp $archive "wisewolf-vps:/tmp/wisewolf-staging-$releaseId.tar.gz"
  if ($LASTEXITCODE -ne 0) { throw 'Envio da release falhou.' }
  & scp (Join-Path $stagingDir 'release.sh') 'wisewolf-vps:/tmp/wisewolf-staging-release.sh'
  if ($LASTEXITCODE -ne 0) { throw 'Envio do publicador falhou.' }
  & ssh wisewolf-vps "bash /tmp/wisewolf-staging-release.sh $releaseId"
  if ($LASTEXITCODE -ne 0) { throw 'Publicação na VPS falhou.' }

  $response = Invoke-WebRequest -UseBasicParsing -Uri 'https://wisewolf-staging.2timeweb.com.br/' -TimeoutSec 30
  if ($response.StatusCode -ne 200 -or $response.Headers['X-Robots-Tag'] -notmatch 'noindex') {
    throw 'A validação pública do staging falhou.'
  }
  $authResponse = Invoke-WebRequest -UseBasicParsing -Uri 'https://api.wisewolflanguage.com.br/auth/v1/settings' -Headers @{ apikey = $anonKey } -TimeoutSec 30
  if ($authResponse.StatusCode -ne 200 -or $authResponse.Headers['Content-Type'] -notmatch 'application/json') {
    throw 'A validação pública da rota de autenticação falhou.'
  }
  Write-Output "Staging publicado: https://wisewolf-staging.2timeweb.com.br ($releaseId)"
}
finally {
  Remove-Item Env:VITE_SUPABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:VITE_SUPABASE_ANON_KEY -ErrorAction SilentlyContinue
  if ($stage -and (Test-Path -LiteralPath $stage)) {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if ($resolvedStage.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()), [StringComparison]::OrdinalIgnoreCase) -and
        (Split-Path -Leaf $resolvedStage).StartsWith('wisewolf-staging-', [StringComparison]::Ordinal)) {
      Remove-Item -Recurse -Force -LiteralPath $resolvedStage
    }
  }
  if ($archive -and (Test-Path -LiteralPath $archive)) {
    Remove-Item -Force -LiteralPath $archive
  }
  Pop-Location
}
