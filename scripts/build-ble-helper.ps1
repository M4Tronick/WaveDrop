# Compiles native/ble-helper.cs into assets/ble-helper.exe with the C# compiler
# that ships with .NET Framework 4.x. WinRT types come from the Windows SDK
# union metadata when installed, otherwise from System32\WinMetadata.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
$union = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\UnionMetadata\10.*\Windows.winmd" -ErrorAction SilentlyContinue |
  Sort-Object FullName | Select-Object -Last 1
$refs = @(if ($union) { $union.FullName } else { (Get-ChildItem "$env:WINDIR\System32\WinMetadata\*.winmd").FullName })
$refs += 'System.Runtime', 'System.Runtime.WindowsRuntime', 'System.Runtime.InteropServices.WindowsRuntime', 'System.Threading.Tasks' |
  ForEach-Object { "$fw\$_.dll" }
# A response file sidesteps PowerShell 5.1's quoting of native arguments.
$rsp = Join-Path $env:TEMP 'wavedrop-ble-helper.rsp'
$lines = @('/nologo', '/optimize+', '/target:exe', '/platform:anycpu', "/out:`"$root\assets\ble-helper.exe`"")
$lines += $refs | ForEach-Object { "/r:`"$_`"" }
$lines += "`"$root\native\ble-helper.cs`""
Set-Content -Path $rsp -Value $lines -Encoding ASCII
& "$fw\csc.exe" "@$rsp"
if ($LASTEXITCODE -ne 0) { throw "csc failed ($LASTEXITCODE)" }
"built $root\assets\ble-helper.exe"
