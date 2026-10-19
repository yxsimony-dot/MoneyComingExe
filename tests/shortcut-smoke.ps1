$ErrorActionPreference = 'Stop'
$workspace = Split-Path -Parent $PSScriptRoot
$portableReportPath = Join-Path $workspace 'artifacts/portable.json'
if ($env:MONEYCOMING_EXE) {
    $executable = (Resolve-Path -LiteralPath $env:MONEYCOMING_EXE).Path
} elseif (Test-Path -LiteralPath (Join-Path $workspace 'release/win-unpacked/MoneyComing.exe')) {
    $executable = (Resolve-Path -LiteralPath (Join-Path $workspace 'release/win-unpacked/MoneyComing.exe')).Path
} else {
    $portableReport = Get-Content -LiteralPath $portableReportPath -Raw -Encoding utf8 | ConvertFrom-Json
    $executable = (Resolve-Path -LiteralPath $portableReport.executablePath).Path
}
$shortcutPath = Join-Path ([System.IO.Path]::GetTempPath()) "MoneyComing-Test-$PID.lnk"
$reportPath = Join-Path $workspace 'artifacts/shortcut.json'
$launchCwd = [System.IO.Path]::GetTempPath().TrimEnd('\')
$testArguments = '--test-window-offscreen'
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;

[StructLayout(LayoutKind.Sequential)]
public struct MoneyComingWindowRect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
}

public static class MoneyComingNativeWindow {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool GetWindowRect(IntPtr windowHandle, out MoneyComingWindowRect rectangle);
}
'@

function Test-AreaIntersection {
    param(
        [Parameter(Mandatory = $true)] [object] $Left,
        [Parameter(Mandatory = $true)] [object] $Right
    )
    return $Left.X -lt ($Right.X + $Right.Width) -and
        ($Left.X + $Left.Width) -gt $Right.X -and
        $Left.Y -lt ($Right.Y + $Right.Height) -and
        ($Left.Y + $Left.Height) -gt $Right.Y
}

function Assert-RectangleOutsideDisplays {
    param(
        [Parameter(Mandatory = $true)] [object] $WindowBounds,
        [Parameter(Mandatory = $true)] [object[]] $DisplayBounds,
        [string] $Label = 'Window'
    )
    if ($DisplayBounds.Count -eq 0) { throw "$Label cannot be checked without display bounds." }
    foreach ($display in $DisplayBounds) {
        if (Test-AreaIntersection -Left $WindowBounds -Right $display) {
            throw "$Label intersects display bounds: $($display | ConvertTo-Json -Compress)"
        }
    }
}

$displayBounds = @(
    [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        [pscustomobject]@{
            X = $_.Bounds.X
            Y = $_.Bounds.Y
            Width = $_.Bounds.Width
            Height = $_.Bounds.Height
        }
    }
)
$report = [ordered]@{
    passed = $false
    shortcut = $shortcutPath
    target = $executable
    workingDirectory = $launchCwd
    arguments = $testArguments
    actualShortcutLaunch = $false
    processId = $null
    windowTitle = $null
    windowBounds = $null
    displayBounds = $displayBounds
    offscreen = $false
    intersectingRectangleRejected = $false
    gracefulClose = $false
    ownedProcessExited = $false
}
$launched = $null
try {
    $wsh = New-Object -ComObject WScript.Shell
    $shortcut = $wsh.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $executable
    $shortcut.WorkingDirectory = $launchCwd
    $shortcut.Arguments = $testArguments
    $shortcut.Description = 'MoneyComing portable acceptance test'
    $shortcut.Save()
    $saved = $wsh.CreateShortcut($shortcutPath)
    if ($saved.TargetPath -ne $executable -or
        $saved.WorkingDirectory.TrimEnd('\') -ne $launchCwd -or
        $saved.Arguments -ne $testArguments) {
        throw 'Saved shortcut target, working directory, or arguments differ from requested values.'
    }
    $launched = Start-Process -FilePath $shortcutPath -WorkingDirectory $launchCwd -PassThru
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
    if ($launched.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Expected MoneyComing main window handle is unavailable.' }
    $nativeBounds = New-Object MoneyComingWindowRect
    if (-not [MoneyComingNativeWindow]::GetWindowRect($launched.MainWindowHandle, [ref] $nativeBounds)) {
        throw "GetWindowRect failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."
    }
    $windowBounds = [pscustomobject]@{
        X = $nativeBounds.Left
        Y = $nativeBounds.Top
        Width = $nativeBounds.Right - $nativeBounds.Left
        Height = $nativeBounds.Bottom - $nativeBounds.Top
    }
    $report.windowBounds = $windowBounds

    $controlledOverlap = [pscustomobject]@{
        X = $displayBounds[0].X
        Y = $displayBounds[0].Y
        Width = [Math]::Min(100, $displayBounds[0].Width)
        Height = [Math]::Min(100, $displayBounds[0].Height)
    }
    try {
        Assert-RectangleOutsideDisplays -WindowBounds $controlledOverlap -DisplayBounds $displayBounds -Label 'Controlled overlap'
    } catch {
        $report.intersectingRectangleRejected = $true
    }
    if (-not $report.intersectingRectangleRejected) {
        throw 'The offscreen assertion accepted a controlled rectangle that intersects a display.'
    }

    Assert-RectangleOutsideDisplays -WindowBounds $windowBounds -DisplayBounds $displayBounds -Label 'MoneyComing window'
    $report.offscreen = $true
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
                $launched.WaitForExit(10000)
                $report.forcedOwnedProcessClose = $true
            }
        } else { $report.gracefulClose = $true }
        $launched.Refresh()
        $report.ownedProcessExited = $launched.HasExited
        if (-not $report.ownedProcessExited) {
            $report.passed = $false
            $report.error = 'The owned MoneyComing test process did not exit during cleanup.'
        }
    }
    $json = $report | ConvertTo-Json -Depth 8
    Set-Content -LiteralPath $reportPath -Value $json -Encoding utf8
    Write-Output $json
    Remove-Item -LiteralPath $shortcutPath -Force -ErrorAction SilentlyContinue
}
if (-not $report.passed) { exit 1 }
