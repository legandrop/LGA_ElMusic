$ErrorActionPreference = 'Stop'
$securityModule = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module $securityModule -ErrorAction Stop
$repoRoot = Split-Path -Parent $PSScriptRoot
$pythonLocal = Join-Path $repoRoot 'tools\python_runtime\windows\python.exe'
if (-not (Test-Path -LiteralPath $pythonLocal -PathType Leaf)) {
    throw 'Falta el runtime Python local verificado; no se usará un Python global.'
}
$promptSetting = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\PowerShell\1\ShellIds' -Name ConsolePrompting -ErrorAction SilentlyContinue
if ($promptSetting.ConsolePrompting -eq 1) {
    throw 'Este host configuró credenciales por consola. Usar el login TTY; no se modificará el registro.'
}
if ($args -contains '--check') {
    @{ Ready = $true; PowerShell = $PSVersionTable.PSVersion.ToString(); CredentialCommand = (Get-Command Get-Credential).Name } | ConvertTo-Json
    return
}
Write-Host 'Castlabs EVS: cuenta existente del responsable de la firma.'
Write-Host 'Ingresá el Account Name elegido en el Mac. Pegá la contraseña en el diálogo con Ctrl+V.'
Write-Host 'Los usuarios de El Music reciben la app firmada; no necesitan Castlabs.'
$credential = $null
$networkCredential = $null
$payload = $null
$payloadBytes = $null
$loginProcess = $null
try {
    $credential = Get-Credential -Message 'Castlabs EVS: Account Name y contraseña de la cuenta existente. Login para firmar El Music.'
    if ($null -eq $credential) { Write-Host 'Login cancelado.'; return }
    $networkCredential = $credential.GetNetworkCredential()
    $payload = @{ accountName = $credential.UserName; password = $networkCredential.Password } | ConvertTo-Json -Compress
    $loginProcess = [Diagnostics.Process]::new()
    $loginProcess.StartInfo.FileName = $pythonLocal
    $wrapper = Join-Path $PSScriptRoot 'evs-win.py'
    $loginProcess.StartInfo.Arguments = '-I -B "' + $wrapper + '" account-pipe'
    $loginProcess.StartInfo.WorkingDirectory = $repoRoot
    $loginProcess.StartInfo.UseShellExecute = $false
    $loginProcess.StartInfo.CreateNoWindow = $true
    $loginProcess.StartInfo.RedirectStandardInput = $true
    $loginProcess.StartInfo.RedirectStandardOutput = $true
    $loginProcess.StartInfo.RedirectStandardError = $true
    [void]$loginProcess.Start()
    $outputTask = $loginProcess.StandardOutput.ReadToEndAsync()
    $errorTask = $loginProcess.StandardError.ReadToEndAsync()
    $payloadBytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $loginProcess.StandardInput.BaseStream.Write($payloadBytes, 0, $payloadBytes.Length)
    $loginProcess.StandardInput.Close()
    [Array]::Clear($payloadBytes, 0, $payloadBytes.Length)
    $payloadBytes = $null
    $payload = $null
    $loginProcess.WaitForExit()
    $safeOutput = $outputTask.GetAwaiter().GetResult()
    [void]$errorTask.GetAwaiter().GetResult()
    try { $status = $safeOutput | ConvertFrom-Json } catch { throw 'Resultado de login no verificable; no se mostrará salida privada.' }
    if ($loginProcess.ExitCode -eq 0 -and $status.ok -eq $true) {
        Write-Host 'Login terminado. Ya se puede seguir con la firma.'
    } else {
        $messages = @{
            'invalid-credentials' = 'Castlabs rechazó el usuario o la contraseña. Revisá el Account Name y la clave.'
            'account-not-found' = 'Castlabs no encontró ese Account Name.'
            'account-not-confirmed' = 'La cuenta requiere confirmación del correo.'
            'password-reset-required' = 'Castlabs requiere restablecer la contraseña de esta cuenta.'
            'rate-limited' = 'Castlabs limitó los intentos. Esperar antes de volver a intentar.'
            'invalid-input' = 'Datos de entrada inválidos.'
            'connection-error' = 'No se pudo conectar. Revisar la conexión o el firewall.'
            'unknown-error' = 'Castlabs devolvió otro error. No se completó el login.'
        }
        $message = $messages[[string]$status.category]
        if ($null -eq $message) { $message = $messages['unknown-error'] }
        Write-Host $message -ForegroundColor Red
    }
} finally {
    if ($null -ne $payloadBytes) { [Array]::Clear($payloadBytes, 0, $payloadBytes.Length) }
    $payload = $networkCredential = $null
    if ($null -ne $credential) { $credential.Password.Dispose() }
    $credential = $null
    if ($null -ne $loginProcess) { $loginProcess.Dispose() }
}
