# managed-by oncue hostile/argv-win
$env:A = '$x %i "q" ''s'' \ & <> `n'
$env:EMPTY = ''
$env:UNI = '日本'
Set-Location -LiteralPath 'C:\Users\u\dir with spaces\100%'
& 'C:\Program Files\my tools\run.exe' '$env:HOME' '%PATH%' 'it''s' '‘‘curly’’' 'a&b<c>d|e' 'back\slash' 'ünïcödé ✓' '$(calc)' '`tick' 'a b' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\logs\my job %.log' -Append -Encoding utf8
exit $LASTEXITCODE
