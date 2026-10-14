$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$portableReport = Get-Content -LiteralPath (Join-Path $workspace 'artifacts/portable.json') -Raw -Encoding utf8 | ConvertFrom-Json
$executable = (Resolve-Path -LiteralPath $portableReport.executablePath).Path
$shortcutPath = Join-Path (Split-Path -Parent $executable) 'MoneyComing-Test.lnk'
$reportPath = Join-Path $workspace 'artifacts/shortcut.json'
$launchCwd = [System.IO.Path]::GetTempPath().TrimEnd('\')
$report = [ordered]@{
    passed = $false
    shortcut = $shortcutPath
    target = $executable
    workingDirectory = $launchCwd
    actualShortcutLaunch = $false
    processId = $null
    windowTitle = $null
    gracefulClose = $false
}
$launched = $null
try {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $executable
    $shortcut.WorkingDirectory = $launchCwd
    $shortcut.Description = 'MoneyComing portable acceptance test'
    $shortcut.Save()
    $saved = $wsh.CreateShortcut($shortcutPath)
    if ($saved.TargetPath -ne $executable -or $saved.WorkingDirectory.TrimEnd('\') -ne $launchCwd) {
        throw 'Saved shortcut target or working directory differs from requested values.'
    }
    # This is the interactive GUI under test: its window must be visible for title verification.
    $launched = Start-Process -FilePath $shortcutPath -WorkingDirectory $launchCwd -WindowStyle Normal -PassThru
    if ($null -eq $launched) { throw 'Shortcut launch did not return an owned process handle.' }
    $report.actualShortcutLaunch = $true
    $report.processId = $launched.Id
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $launched.Refresh()
        if ($launched.HasExited) { throw 'Launched executable exited before its application window appeared.' }
        if ($launched.MainWindowTitle -match 'MoneyComing') { break }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    $report.windowTitle = $launched.MainWindowTitle
    if ($report.windowTitle -notmatch 'MoneyComing') { throw 'Expected MoneyComing application window did not appear.' }
    if ($launched.Path -ne $executable) { throw 'Launched process does not belong to the tested portable executable.' }
    $report.passed = $true
} catch {
    $report.error = $_.Exception.Message
} finally {
    if ($null -ne $launched) {
        $launched.Refresh()
        if (-not $launched.HasExited) {
            $null = $launched.CloseMainWindow()
            $report.gracefulClose = $launched.WaitForExit(10000)
            if (-not $report.gracefulClose) {
                # Only terminate the specific process returned from this shortcut launch.
                Stop-Process -Id $launched.Id -Force
                $report.forcedOwnedProcessClose = $true
            }
        } else { $report.gracefulClose = $true }
    }
    $json = $report | ConvertTo-Json -Depth 5
    Set-Content -LiteralPath $reportPath -Value $json -Encoding utf8
    Write-Output $json
}
if (-not $report.passed) { exit 1 }
