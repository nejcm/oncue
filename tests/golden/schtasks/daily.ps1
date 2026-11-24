# managed-by oncue shape/daily
Set-Location -LiteralPath 'C:\tmp'
try {
  & 'C:\usr\bin\true' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\daily.log' -Append -Encoding utf8
} catch {
  "$_" | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\daily.log' -Append -Encoding utf8
  exit 1
}
exit $LASTEXITCODE
