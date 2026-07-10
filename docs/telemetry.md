# FreeBuddy anonymous telemetry

FreeBuddy uses PostHog to count anonymous installations and understand which app
versions, desktop platforms, and core product flows remain active. Telemetry is
enabled by default and can be disabled at any time in **Settings → General →
Anonymous usage data**.

## Events

- `app_first_launch`: sent once when an installation first starts with telemetry enabled.
- `app_launched`: sent once per application process start.
- `app_updated`: sent after the installed FreeBuddy version changes.
- `conversation_created`: records the selected adapter, approval mode, and whether
  a workspace was selected.
- `agent_run_started`: records adapter, run context, resume/attachment flags,
  attachment count, approval mode, and workspace presence.
- `agent_run_finished`: records adapter, terminal status, duration, safe numeric
  exit code, and a bounded error category when applicable.
- `workflow_run_started`: records team source, template, phase/step/agent counts,
  loop limit, and workspace presence.
- `workflow_run_finished`: records terminal status, duration, aggregate step/agent/
  failure/loop counts, team source, template, and workspace presence.
- `agent_setup_completed`: records adapter, check/install action, outcome, and a
  bounded error category when applicable.

Every event contains only a random installation UUID, FreeBuddy version, operating
system, CPU architecture, schema version, and whether the app is a packaged release.
Adapters are restricted to a known list and unknown values become `custom`. Errors
are reduced to categories such as `network_error`; raw messages are never sent.
GeoIP lookup is disabled. FreeBuddy does not send account information, conversation
or workflow content, prompts, names, commands, file paths, workspace contents,
environment variables, agent output, tool input/output, or source code.

Disabling telemetry stops the PostHog client immediately. The installation UUID is
stored locally in FreeBuddy's settings database and is not derived from hardware.

## Release configuration

Set `FREEBUDDY_POSTHOG_KEY` to the PostHog project API key during the release build.
Set `FREEBUDDY_POSTHOG_HOST` only when using the EU cloud or a self-hosted endpoint;
it defaults to `https://us.i.posthog.com`. The build writes these values to the
packaged main-process output. No PostHog key is exposed to renderer code.

For GitHub releases, add `FREEBUDDY_POSTHOG_KEY` as an Actions secret and optionally
add `FREEBUDDY_POSTHOG_HOST` as an Actions variable. Builds without a project key
remain functional and silently disable telemetry.
