# Jev Fast Browser demo

## 1. Install the latest extension

Run `npm run package`, then install `dist/jev-guard.vsix` using **Extensions: Install from VSIX...**. Reload the editor when prompted.

## 2. Start a dedicated debug browser

Close any existing debug instance, then start Edge from PowerShell with a disposable profile:

```powershell
& "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\jev-fast-browser"
```

Do not use a personal browser profile for the demo.

## 3. Configure and start Jev

1. Run **Jev: Set API Key**.
2. Open the project folder that Jev may protect.
3. Open the shield icon and select **Start**.
4. Accept the current workspace path.
5. Keep the endpoint as `http://127.0.0.1:9222`.
6. Enter a page that contains an actual task target, such as `https://developer.mozilla.org/en-US/docs/Web`.

Do not add `--headless=new` when you want to watch the browser window. Headless mode is useful for the automated benchmark, but it intentionally opens no visible GUI.

The console should show **Fast Browser: Running**, the selected workspace, protocol-call count, zero screenshots, and planner-request count.

## 4. Run a natural-language goal

Select **Run goal** and enter a bounded task such as `Open the JavaScript documentation link`.

`example.com` is only a connectivity test and has no documentation link, so a goal asking for documentation there correctly finishes as `blocked (0 steps)`.

- Jev chooses only from observed action IDs.
- Text fields prompt for the exact text rather than allowing generated arbitrary input.
- An `ask` decision opens an **Allow once** confirmation.
- A `deny` decision ends the task without sending the mutation to CDP.
- The loop stops after at most 20 actions.

## 5. Demonstrate safety

Use a disposable page containing a destructive button and request that it be clicked. Confirm that:

1. The console records `agent: browser`.
2. The decision is blocked or requires confirmation.
3. A denied action does not change the page.
4. The screenshot counter remains zero.

Select **Stop** when finished. The loopback guard server, CDP target, and connection are closed.
