$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'start-devnet.ps1')
$script:passed = 0
function Assert-Equal($Actual, $Expected) {
    if ($Actual -cne $Expected) { throw "Expected '$Expected', got '$Actual'" }
    $script:passed++
}
function Assert-Throws([scriptblock]$Action, [string]$Pattern) {
    try { & $Action; throw 'Expected an exception' }
    catch {
        if ($_.Exception.Message -notmatch $Pattern) { throw }
        $script:passed++
    }
}
Assert-Equal ((ConvertFrom-ZyronWslList 0 "Ubuntu-24.04`r`nDebian`r`n" '') -join ',') 'Ubuntu-24.04,Debian'
Assert-Equal ((ConvertFrom-ZyronWslList 0 (([string][char]0xFEFF) + "Ubuntu`0`r`n") '') -join ',') 'Ubuntu'
Assert-Equal ((ConvertFrom-ZyronWslList 0 "docker-desktop`nrancher-desktop-data`nDebian" '') -join ',') 'Debian'
Assert-Equal (Select-ZyronDistribution @('Ubuntu-24.04') '') 'Ubuntu-24.04'
Assert-Equal (Select-ZyronDistribution @('Debian') '') 'Debian'
Assert-Equal (Select-ZyronDistribution @('Ubuntu-22.04','Ubuntu-24.04') '') 'Ubuntu-24.04'
Assert-Equal (Select-ZyronDistribution @('Ubuntu','Ubuntu-24.04') '') 'Ubuntu'
Assert-Equal (Select-ZyronDistribution @('Custom Linux','Ubuntu') 'Custom Linux') 'Custom Linux'
Assert-Throws { Select-ZyronDistribution @('Ubuntu-24.04') 'Ubuntu' } 'not installed'
Assert-Throws { Select-ZyronDistribution @() '' } 'wsl --install -d Ubuntu'
Assert-Throws { Select-ZyronDistribution @('Fedora') '' } 'explicitly'
Assert-Throws { ConvertFrom-ZyronWslList 1 '' 'E_ACCESSDENIED' } 'not evidence.*missing'
Assert-Throws { ConvertFrom-ZyronWslList 1 'Ubuntu' 'service failure' } 'discovery failed'
# Test actual native PowerShell -> Bash argument handling, including CRLF and
# shell metacharacters in a repository path, without running package installers.
$bash = Join-Path $env:ProgramFiles 'Git\bin\bash.exe'
if (-not (Test-Path -LiteralPath $bash)) { throw 'Git Bash is required for the command transport regression.' }
$pathFixture = '/mnt/c/project with spaces/quote''&$(echo BAD)'
$scriptFixture = 'printf %s "$ZYRON_SOURCE_B64" | base64 --decode' + "`r`n"
$command = ConvertTo-ZyronBootstrapCommand $pathFixture $scriptFixture
$actual = & $bash -c $command
if ($LASTEXITCODE -ne 0) { throw 'Bash command transport failed.' }
Assert-Equal ($actual -join "`n") $pathFixture
# Exercise orchestration without requiring a WSL VM or starting a validator.
$script:called = $false
function Get-ZyronWslList { param($Executable) throw 'E_ACCESSDENIED discovery sentinel' }
function Select-ZyronDistribution { param($Names,$Requested) $script:called = $true; return 'Ubuntu' }
Assert-Throws { Start-ZyronDevnet '' } 'E_ACCESSDENIED discovery sentinel'
Assert-Equal $script:called $false
Write-Host "$script:passed Windows devnet regression assertions passed."
