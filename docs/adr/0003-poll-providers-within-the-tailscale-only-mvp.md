# Poll providers within the Tailscale-only MVP

Suplex will poll a configured provider only while an issue awaits pull-request, CI, or release status, rather than expose public webhook endpoints. This preserves the local Tailscale-only deployment boundary; durable timers and typed connectivity retries make the resulting delay and outage state explicit.
