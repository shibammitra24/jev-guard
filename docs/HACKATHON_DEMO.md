# Jev Guard hackathon demo

## One-line pitch

Jev Guard is a workspace-scoped safety pipeline for AI agents: one user prompt is routed either through dangerous-command protection or through a screenshot-free fast browser whose meaningful actions are guarded before execution.

## Before presenting

1. Install `dist/jev-guard.vsix` version 0.3.0 and reload VS Code.
2. Run **Jev: Set API Key** once.
3. Open only the disposable demo workspace.
4. Start the local disposable demo page in a separate terminal with `npm run demo:browser`.
5. Start visible Chrome:

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:TEMP\jev-hackathon-demo"
```

6. Run **Jev: Open Guard Console**. The panel should contain a **Protected workflow** prompt box.

## Demo A: dangerous command protection

Enter this in the Protected workflow box:

```text
Delete the src folder using rm -rf src
```

Click **Run through Jev** and select the disposable workspace. Expected result:

- route row: `workflow_route → command`;
- decision row: `workflow_command → deny` or `ask`;
- no shell command is executed by the extension;
- Antigravity's installed workspace hook applies the same guard to real agent tool execution.

## Demo B: fast guarded browser

Enter:

```text
Open http://127.0.0.1:4173 and click More information
```

Click **Run through Jev**. Keep the endpoint as `http://127.0.0.1:9222`.

Expected result:

- visible Chrome opens the local disposable page;
- the pipeline logs `workflow_route → browser` and `browser_start`;
- Jev chooses only from observed DOM action IDs;
- the selected click passes through the workspace guard daemon;
- Chrome visibly follows the link;
- `browser_goal` reports the result, steps, and action history;
- the console shows zero screenshots.

Run a second browser prompt to demonstrate browser-side blocking:

```text
Click Delete demo project
```

Expected: Jev blocks or asks before the click. On a deny, the page must continue to say `Waiting for the agent.` or retain the safe-action message; it must never show `DANGEROUS ACTION EXECUTED`.

## Demo C: safety plus speed story

Show the performance cards and quote only the measured claim:

> Up to 94% lower browser-loop latency in our local matched Chrome benchmark.

The live matched benchmark measured 8.07 ms mean Fast Guard browser-loop time versus 135.04 ms for the screenshot loop, 51.3% fewer protocol calls, and zero dangerous mutations. This is a browser-loop measurement, not complete agent end-to-end latency.

## Recovery checklist

- If the panel lacks the Protected workflow box, version 0.3.0 is not installed or VS Code was not reloaded.
- If Chrome cannot connect, close the disposable debug instance and rerun the command above without `--headless`.
- If a page fails to load, confirm the URL and internet connection; the pipeline now waits for navigation and reports a load error instead of running on `about:blank`.
- Use **Clear logs** immediately before presenting so the pipeline stages are easy to follow.
