# managed-by oncue shape/timeout
Set-Location -LiteralPath 'C:\tmp'
try {
  & 'C:\usr\bin\true' 2>&1 | ForEach-Object { "$_" } | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\timeout.log' -Append -Encoding utf8
} catch {
  "$_" | Out-File -LiteralPath 'C:\Users\u\AppData\Local\oncue\shape\timeout.log' -Append -Encoding utf8
  exit 1
}
exit $LASTEXITCODE
