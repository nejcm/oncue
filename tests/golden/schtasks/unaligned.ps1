# managed-by oncue shape/unaligned
Set-Location -LiteralPath 'C:\tmp'
& 'C:\usr\bin\true' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\unaligned.log' -Append -Encoding utf8
exit $LASTEXITCODE
