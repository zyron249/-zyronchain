param([string]$Distribution)
$ErrorActionPreference = 'Stop'

function ConvertFrom-ZyronWslList {
    param([int]$ExitCode, [string]$Output, [string]$ErrorOutput)
    if ($ExitCode -ne 0) {
        throw "WSL distribution discovery failed (exit $ExitCode). This is not evidence that Ubuntu is missing.`n$Output`n$ErrorOutput"
    }
    @($Output.Replace([string][char]0, '') -split '\r?\n' |
        ForEach-Object { $_.Trim().TrimStart([char]0xFEFF) } |
        Where-Object { $_ -and $_ -notmatch '^(docker-desktop|rancher-desktop)(-data)?$' })
}

function Select-ZyronDistribution {
    param([string[]]$Names, [string]$Requested)
    if ($Requested) {
        if ($Names -cnotcontains $Requested) { throw "The requested distribution '$Requested' is not installed." }
        return $Requested
    }
    if ($Names -contains 'Ubuntu') { return 'Ubuntu' }
    $ubuntu = @($Names | Where-Object { $_ -match '^Ubuntu-' } | Sort-Object -Descending)
    if ($ubuntu.Count) { return $ubuntu[0] }
    if ($Names -contains 'Debian') { return 'Debian' }
    if (-not $Names.Count) {
        throw 'No user Linux distribution is installed. Install Ubuntu with: wsl --install -d Ubuntu . Complete its username/password setup, then reopen START-DEVNET.cmd.'
    }
    throw "No Ubuntu or Debian distribution was found. Installed: $($Names -join ', '). Use -Distribution to select a configured Linux environment explicitly."
}

function Get-ZyronWslList {
    param([string]$Executable)
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.Arguments = '--list --quiet'
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [System.Text.Encoding]::Unicode
    $info.StandardErrorEncoding = [System.Text.Encoding]::Unicode
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(30000)) {
            $process.Kill()
            throw 'WSL distribution discovery timed out.'
        }
        ConvertFrom-ZyronWslList $process.ExitCode $stdout.Result $stderr.Result
    } finally { $process.Dispose() }
}

function ConvertTo-ZyronBootstrapCommand {
    param([string]$SourcePath, [string]$Script)
    $sourceBytes = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($SourcePath))
    $payload = "export ZYRON_SOURCE_B64=$sourceBytes`n" + $Script.Replace("`r`n", "`n")
    $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($payload))
    # Only base64 data crosses Windows PowerShell's native argument quoting.
    return "printf %s $encoded | base64 --decode | bash"
}

function Start-ZyronDevnet {
    param([string]$Requested)
    $wsl = Join-Path $env:ProgramFiles 'WSL\wsl.exe'
    if (-not (Test-Path -LiteralPath $wsl)) { $wsl = (Get-Command wsl.exe -ErrorAction Stop).Source }
    $names = @(Get-ZyronWslList $wsl)
    $selected = Select-ZyronDistribution $names $Requested
    Write-Host "Using WSL distribution: $selected"
    $bootstrap = Join-Path $PSScriptRoot 'wsl-devnet.sh'
    if (-not (Test-Path -LiteralPath $bootstrap)) { throw 'The companion wsl-devnet.sh file is missing.' }
    $source = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $linuxPath = & $wsl --distribution $selected --exec wslpath -a $source
    if ($LASTEXITCODE -ne 0) { throw 'WSL could not resolve the launcher path. Complete Linux first-run setup.' }
    $linuxPath = ($linuxPath -join "`n").Trim()
    if (-not $linuxPath.StartsWith('/')) { throw 'WSL returned an invalid launcher path.' }
    $command = ConvertTo-ZyronBootstrapCommand $linuxPath ([IO.File]::ReadAllText($bootstrap))
    & $wsl --distribution $selected --exec bash -c $command
    if ($LASTEXITCODE -ne 0) { throw "Linux startup failed (exit $LASTEXITCODE)." }
}

if ($MyInvocation.InvocationName -ne '.') {
    try { Start-ZyronDevnet $Distribution }
    catch { Write-Host $_.Exception.Message; exit 1 }
}
