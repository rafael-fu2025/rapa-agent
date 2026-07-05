# Generates a cryptographically random 64-char hex string suitable for APP_SECRET.
# Usage:  .\gen-secret.ps1
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RNGCryptoServiceProvider]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
[System.BitConverter]::ToString($bytes) -replace '-', ''
