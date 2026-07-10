# FreeBuddy anonymous telemetry

FreeBuddy uses PostHog to count anonymous installations and understand which app
versions and desktop platforms remain active. Telemetry is enabled by default and
can be disabled at any time in **Settings → General → Anonymous usage data**.

## Events

- `app_first_launch`: sent once when an installation first starts with telemetry enabled.
- `app_launched`: sent once per application process start.
- `app_updated`: sent after the installed FreeBuddy version changes.

Every event contains only a random installation UUID, FreeBuddy version, operating
system, CPU architecture, and whether the app is a packaged release. GeoIP lookup is
disabled. FreeBuddy does not send account information, conversations, prompts, file
paths, workspace contents, agent output, or source code.

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
