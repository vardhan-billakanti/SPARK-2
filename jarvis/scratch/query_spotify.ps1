Get-Process -Name Spotify -ErrorAction SilentlyContinue | ForEach-Object {
    [PSCustomObject]@{
        Id = $_.Id
        MainWindowTitle = $_.MainWindowTitle
        MainWindowHandle = $_.MainWindowHandle
        Responding = $_.Responding
    }
} | Format-Table -AutoSize
