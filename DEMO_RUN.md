# Jev Guard demo run

This runbook tests the VS Code/Antigravity extension in a separate disposable project. Do not test destructive commands against a real project until the deny path is visible in the Guard Console.

## 1. Build the extension

Open PowerShell in the Jev Guard repository:

```powershell
cd "D:\Projects\Hacknex 2026\jev-guard"
npm install
npm test
npm run package
```

The package is created at:

```text
D:\Projects\Hacknex 2026\jev-guard\dist\jev-guard.vsix
```

## 2. Install version 0.1.4

1. Uninstall every existing `jev-guard-extension` entry from Antigravity.
2. Fully exit every Antigravity window.
3. Start Antigravity again.
4. Open Extensions, choose **Install from VSIX**, and select `dist\jev-guard.vsix`.
5. Confirm the extension page shows version `0.1.4`.
6. Run **Developer: Reload Window**.

## 3. Create a disposable project

```powershell
$demoPath = "D:\Projects\Hacknex 2026\jev-guard-demo-test"
New-Item -ItemType Directory -Path $demoPath -Force
Set-Content -LiteralPath "$demoPath\KEEP.txt" -Value "must remain"
Set-Content -LiteralPath "$demoPath\DELETE_ME.txt" -Value "disposable"
Set-Content -LiteralPath "$demoPath\README.md" -Value "Jev Guard disposable test workspace"
```

Open `D:\Projects\Hacknex 2026\jev-guard-demo-test` as the Antigravity workspace.

## 4. Configure the extension

Run these commands from the Command Palette:

1. **Jev: Set API Key**
2. **Jev: Install Antigravity Guard**, then enter the absolute path of this disposable project when prompted.
3. **Developer: Reload Window**

Verify the installed guard exists:

```powershell
Test-Path "$env:USERPROFILE\.jev\bin\guard.js"
Get-Content "$demoPath\.agents\hooks.json"
```

## 5. Verify the GUI before testing deletion

1. Click the shield icon in the Activity Bar.
2. The title must say **Jev Guard Console**.
3. It must show counters and either decision rows or **No decisions yet**.
4. It must not show “There is no data provider registered”.

If the provider error appears, confirm the installed extension is version `0.1.4`; an older package is still installed.

## 6. Run a direct guard smoke test

```powershell
$payload = '{"toolCall":{"name":"run_command","args":{"CommandLine":"rm -rf ./DELETE_ME.txt","Cwd":"D:\\Projects\\Hacknex 2026\\jev-guard-demo-test"}},"workspacePaths":["D:\\Projects\\Hacknex 2026\\jev-guard-demo-test"],"conversationId":"demo-smoke"}'
$payload | node "$env:USERPROFILE\.jev\bin\guard.js" --agent agy
```

Expected output contains:

```json
{"decision":"deny"}
```

Do not continue if it returns `allow`.

## 7. Test through Antigravity

First ask the agent:

```text
List the files in this workspace and read README.md. Do not modify anything.
```

Expected result: the files remain present and the console shows allowed read operations.

Then ask:

```text
Delete only DELETE_ME.txt using a shell command. Do not touch KEEP.txt.
```

Expected result:

- `DELETE_ME.txt` remains present.
- The agent reports that Jev Guard blocked the action.
- The console shows a red `deny` row for `run_command`.
- `KEEP.txt` remains present.

Verify:

```powershell
Test-Path "D:\Projects\Hacknex 2026\jev-guard-demo-test\DELETE_ME.txt"
Test-Path "D:\Projects\Hacknex 2026\jev-guard-demo-test\KEEP.txt"
Get-Content "$env:USERPROFILE\.jev\decisions.jsonl" -Tail 10
```

Both `Test-Path` commands must return `True`.

## 8. Interpreting failures

- No console row: Antigravity did not invoke the hook.
- Console shows `deny`, but the file disappears: Antigravity ignored the hook result; capture the latest extension-host and Antigravity logs before testing again.
- Direct smoke test returns `deny`, but no console row appears during an agent action: the guard works, but the active workspace/runtime hook is not loaded.
- Console says no provider: an extension older than `0.1.1` is installed.

Never use `rm -rf` against a real source directory as a test. Use only the disposable file described above.
