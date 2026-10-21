# Maintainer handoff

Read README.md before changing patch/build/install code. This is a fixed-version experimental native client patch, not an official model-menu extension.

- Keep exact anchor and integrity checks; do not remove them to force compatibility.
- Preserve existing file-tree resources and installed signing entitlements. Do not assume a factory-signed app can use the preview signing scheme.
- A successful signature, startup, API or wire-level check is not proof of actual native menu interaction. Report each verification scope accurately.
- Build and test isolated copies before replacing an installed app. The user must complete any necessary system authorization; never force-terminate their running chats.
- Publish source through an explicit allowlist. Never commit official application binaries/frameworks, local installers, credentials, real catalogs, profiles, logs, generated reports or installation receipts.
- Use placeholders and caller-resolved paths in examples. Do not restore author-specific home directories.

- History controls must update durable paginated history and the model-visible request. Test request bodies and backend restart; DOM hiding is insufficient. Reuse native thread/revert for truncation and preserve full turn/tool groups for single-turn removal. Never edit real user chats during tests.
