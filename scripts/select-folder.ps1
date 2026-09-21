Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Roadwave - MP3 dosyalarinin kaydedilecegi klasoru secin'
$dialog.ShowNewFolderButton = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.Show()
try {
    if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::Write($dialog.SelectedPath)
    }
} finally {
    $dialog.Dispose()
    $owner.Close()
    $owner.Dispose()
}
