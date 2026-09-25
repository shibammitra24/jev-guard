# Jev Fast Browser demo

## 1. Install the latest extension

Run `npm run package`, then install `dist/jev-guard.vsix` using **Extensions: Install from VSIX...**. Reload the editor when prompted.

## 2. Configure Jev

1. Run **Jev: Set API Key**.
2. Open the project folder that Jev may protect.
3. Run **Jev: Install Antigravity Guard** and accept the current workspace path.

There is no browser to start by hand. The workspace sidecar activates automatically, and Jev launches an isolated, visible Chrome window (Edge if Chrome is not installed) with a disposable profile only when a browser task arrives.

## 3. Give a browser task in Antigravity's chat

Type a bounded task that includes the full URL into Antigravity's normal prompt window, for example:

`Open https://developer.mozilla.org/en-US/docs/Web and open the JavaScript documentation link`

Antigravity calls `browser_subagent`; the Jev hook hands the task to Jev Fast Browser, which runs it and returns the result to the agent marked `[JEV FAST BROWSER RESULT]`. If the task has no URL, Jev asks the agent to retry with one.

The Guard Console prompt box accepts the same kind of task as a secondary entry point.

- Jev chooses only from observed action IDs.
- From Antigravity's chat, text entry, submission and any `ask` decision stop the task with a reason (no confirmation UI is available to a hook). From the Guard Console prompt box, an `ask` opens an **Allow once** confirmation and text fields prompt for the exact text.
- A `deny` decision ends the task without sending the mutation to CDP.
- The loop stops after at most 20 actions.

The **Console Logs** table shows the hand-off, each Jev decision, and the final `done`/`blocked`/`failed` result, with zero screenshots.

## 4. Demonstrate safety

Use a disposable page containing a destructive button and request that it be clicked. Confirm that:

1. The console records `agent: browser`.
2. The decision is blocked or requires confirmation.
3. A denied action does not change the page.
4. The screenshot counter remains zero.

Select **Stop** when finished to close the browser window, CDP target, and connection.
