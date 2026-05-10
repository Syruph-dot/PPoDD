param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $ArgsToForward
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$VenvPython = Join-Path $Root ".venv\Scripts\python.exe"

if (Test-Path $VenvPython) {
  $Python = $VenvPython
} else {
  $Python = "python"
}

& $Python (Join-Path $Root "scripts\train_ai_full.py") @ArgsToForward
