# Configured public target

`https://leaderboard.pickyour.ai` is the configured target in the product plan and environment example. Retaining that value supports consistent local development and testing; it is not a verified user-approval receipt for DNS, public deployment or data transmission. It does not provision DNS, approve a hosting provider or budget, appoint an operator, or authorize a public launch.

The public UI uses same-origin `/api/v1` by default. A deployed reverse proxy must route that prefix to the public read service and `/controls/` to the authenticated controls service. The separately registered browser OAuth application's exact callback is `https://leaderboard.pickyour.ai/controls/auth/callback`; the GitHub App used for read-only collection remains a separate credential and permission boundary.

The environment example contains non-secret deployment targets alongside local development values. These are examples, not automatically loaded hosting configuration. Runtime startup must still verify its protected approved configuration, installed-source capabilities, public source policy and actual identity provider. Synthetic mode remains restricted to loopback.

DNS/TLS, provider capacity and cost, operating and moderation owners, retention/recovery commitments, real source probes, participant accessibility evidence and release acceptance remain their respective issue gates. A configured domain does not accept proposed answers to those questions.
