# managed-by oncue shape/daily
Set-Location -LiteralPath 'C:\tmp'
& 'C:\usr\bin\true' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\daily.log' -Append -Encoding utf8
exit $LASTEXITCODE
