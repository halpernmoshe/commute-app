# commute-app

Hands-free voice front end for a personal research agent (ElevenLabs Agents). Static page, no server. See the design notes in the private research-wiki repo.

When the drive is stopped, **Export diagnostics** downloads a bounded client lifecycle log for troubleshooting. It records timestamps, app build, connection and retry state, conversation/tool identifiers, and device connectivity state; it excludes conversation text, tool arguments/results, credentials, and raw service URLs.
