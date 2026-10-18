# Security reporting

Do not place credentials, private source payloads, personal data or exploit details in a public issue or contribution receipt.

Use this repository's [private vulnerability reporting route](https://github.com/Pick-Your-AI/pick-your-ai-leaderboard/security/advisories): **Security and quality → Advisories → Report a vulnerability**. Private vulnerability reporting was enabled and read back for this repository on 2026-10-18. It sends a private report to the repository's existing maintainer/security authority; it does not publish an advisory. Accounts with existing admin or security permissions can create a draft security advisory instead.

Include the affected revision, a minimal reproduction and the observed impact. Minimize sensitive material even in a private report; never include usable credentials or unrelated personal/customer data. If the private control is unavailable, use an existing verified private maintainer contact or open a non-sensitive coordination issue asking for a private route, without vulnerability details. No security email address, notification-delivery result or response-time commitment is asserted here.

GitHub's [private reporting instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/report-privately) describe the reporter and administrator paths. The [repository governance decision](docs/repository-governance.md) records the bounded setup and access review. Actual incident response and production operations retain their separate acceptance work.

The repository contains planning tools and runtime code for source ingestion, public reads, protected controls and the browser application. Review the relevant implementation and its scoped test evidence when assessing a security control. Production source authorization, incident ownership, privacy handling and operational drills remain tracked in the [delivery plan](docs/DELIVERY_PLAN.md); local code and synthetic checks do not establish those operational gates. A proposed security control is not an implemented mitigation. The public leaderboard must not count private security reports or expose the content of such reports.
