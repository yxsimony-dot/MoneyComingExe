$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$outputName = 'release-signed-test-' + [guid]::NewGuid().ToString('N')
$output = Join-Path $root $outputName
$pfx = Join-Path ([IO.Path]::GetTempPath()) (
  'moneycoming-signing-' + [guid]::NewGuid().ToString('N') + '.pfx'
)
$rootCertificateFile = $pfx + '.root.pem'
$rootKeyFile = $pfx + '.root.key.pem'
$certificateFile = $pfx + '.leaf.pem'
$keyFile = $pfx + '.leaf.key.pem'
$requestFile = $pfx + '.leaf.csr'
$serialFile = $pfx + '.root.srl'
$extensionsFile = $pfx + '.extensions.cnf'
$passwordText = [guid]::NewGuid().ToString('N')
$certificate = $null
$rootCertificate = $null

try {
  $openssl = 'C:\Program Files\Git\usr\bin\openssl.exe'
  & $openssl req `
    -x509 `
    -newkey rsa:2048 `
    -keyout $rootKeyFile `
    -out $rootCertificateFile `
    -days 2 `
    -nodes `
    -subj '/CN=MoneyComing Test Root' `
    -addext 'basicConstraints=critical,CA:TRUE' `
    -addext 'keyUsage=critical,keyCertSign,cRLSign'
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & $openssl req `
    -newkey rsa:2048 `
    -keyout $keyFile `
    -out $requestFile `
    -nodes `
    -subj '/CN=MoneyComing Test Signing'
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  @'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=codeSigning
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
'@ | Set-Content -LiteralPath $extensionsFile -Encoding ascii

  & $openssl x509 `
    -req `
    -in $requestFile `
    -CA $rootCertificateFile `
    -CAkey $rootKeyFile `
    -CAcreateserial `
    -out $certificateFile `
    -days 2 `
    -sha256 `
    -extfile $extensionsFile
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  & $openssl pkcs12 `
    -export `
    -out $pfx `
    -inkey $keyFile `
    -in $certificateFile `
    -certfile $rootCertificateFile `
    -passout "pass:$passwordText"
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }

  $certificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
    $certificateFile
  )
  $rootCertificate = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
    $rootCertificateFile
  )

  $env:Path = 'C:\Program Files\nodejs;' + $env:Path
  $env:CSC_LINK = $pfx
  $env:CSC_KEY_PASSWORD = $passwordText

  Push-Location $root
  try {
    & '.\node_modules\.bin\electron-builder.cmd' `
      --win nsis `
      --publish never `
      "--config.directories.output=$outputName"
    if ($LASTEXITCODE -ne 0) {
      exit $LASTEXITCODE
    }
  } finally {
    Pop-Location
  }

  $installers = @(Get-ChildItem -LiteralPath $output -File -Filter 'MoneyComing-Setup-*.exe')
  if ($installers.Count -ne 1) {
    throw "Expected exactly one NSIS installer, found $($installers.Count)."
  }
  $installer = $installers[0]
  $app = Join-Path $output 'win-unpacked\MoneyComing.exe'
  $env:MONEYCOMING_SIGN_TARGETS = @($installer.FullName, $app) | ConvertTo-Json -Compress
  $env:MONEYCOMING_SIGN_ROOT = $rootCertificateFile
  $env:MONEYCOMING_SIGN_THUMBPRINT = $certificate.Thumbprint
  $verificationJson = & powershell.exe `
    -NoProfile `
    -NonInteractive `
    -Command @'
$paths = $env:MONEYCOMING_SIGN_TARGETS | ConvertFrom-Json
$root = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(
  $env:MONEYCOMING_SIGN_ROOT
)
$paths | ForEach-Object {
  $signature = Get-AuthenticodeSignature -LiteralPath $_
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $null = $chain.ChainPolicy.ExtraStore.Add($root)
  $chain.ChainPolicy.RevocationMode =
    [System.Security.Cryptography.X509Certificates.X509RevocationMode]::NoCheck
  $chain.ChainPolicy.VerificationFlags =
    [System.Security.Cryptography.X509Certificates.X509VerificationFlags]::AllowUnknownCertificateAuthority
  $chainValid = $signature.SignerCertificate -and $chain.Build($signature.SignerCertificate)
  $chainRoot = if ($chain.ChainElements.Count -gt 0) {
    $chain.ChainElements[$chain.ChainElements.Count - 1].Certificate.Thumbprint
  } else {
    $null
  }
  $valid = (
    $signature.Status.ToString() -in @('Valid', 'UnknownError') -and
    $signature.SignerCertificate.Thumbprint -eq $env:MONEYCOMING_SIGN_THUMBPRINT -and
    $chainValid -and
    $chainRoot -eq $root.Thumbprint
  )
  [pscustomobject]@{
    File = $_
    Status = $signature.Status.ToString()
    Subject = $signature.SignerCertificate.Subject
    Thumbprint = $signature.SignerCertificate.Thumbprint
    ChainValid = $chainValid
    Verification = if ($valid) { 'ValidTestChain' } else { 'Invalid' }
  }
} | ConvertTo-Json -Compress
'@
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
  $results = $verificationJson | ConvertFrom-Json
  $verificationJson
  if (($results | Where-Object Verification -ne 'ValidTestChain').Count -ne 0) {
    throw 'Signed artifact verification failed.'
  }

  [pscustomobject]@{
    signed = $true
    installer = $true
    executable = $true
    subject = $certificate.Subject
    thumbprint = $certificate.Thumbprint
  } | ConvertTo-Json -Compress
} finally {
  Remove-Item Env:CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:MONEYCOMING_SIGN_TARGETS -ErrorAction SilentlyContinue
  Remove-Item Env:MONEYCOMING_SIGN_ROOT -ErrorAction SilentlyContinue
  Remove-Item Env:MONEYCOMING_SIGN_THUMBPRINT -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $pfx -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $rootCertificateFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $rootKeyFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $certificateFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $keyFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $requestFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $serialFile -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $extensionsFile -Force -ErrorAction SilentlyContinue

  $outputFullPath = [IO.Path]::GetFullPath($output)
  $rootPrefix = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) +
    [IO.Path]::DirectorySeparatorChar
  if (
    $outputFullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase) -and
    (Split-Path $outputFullPath -Leaf) -like 'release-signed-test-*'
  ) {
    Remove-Item -LiteralPath $outputFullPath -Recurse -Force -ErrorAction SilentlyContinue
  }
}
