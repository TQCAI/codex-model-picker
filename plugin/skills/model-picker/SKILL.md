---
name: model-picker
description: Open the external-model manager or launch a provider-specific Codex CLI session without changing the shared default provider.
---

Locate the user's clone of `TQCAI/codex-model-picker` before running commands; never assume the author's home directory. Read its README and local build reports. Replace `<PROJECT_DIR>` below with the verified absolute clone path.

Open management with `python3 <PROJECT_DIR>/picker.py manage` as a persistent process. It prints a loopback-only URL and opens the page. Keep the per-launch access token local.

The catalog is `~/.local/share/codex-model-picker/catalog.json`. Use `catalog.example.json` as a template. Credentials are environment-variable names or a local credential-file reference; never print the credential value or embed it in source, webpages, chat, or the app archive.

Launch an isolated CLI with `python3 <PROJECT_DIR>/picker.py cli --catalog <absolute-catalog-path> --provider <configured-provider-id> --model <configured-model-id> --cwd <user-requested-directory>`. Use an interactive terminal. The launcher uses `--no-daemon` and per-invocation overrides without rewriting the shared model/provider default.

The standard skill plugin cannot extend the native model menu. Native integration uses a separately generated, version-specific experimental app patch. Never equate plugin installation or a build manifest with native-menu installation or GUI validation. Inspect the installed app hash and local installer/build reports for actual state.

See README for prerequisites, signing limitations, preview checks, local package generation and recovery. Published source excludes official-app copies, installers, credentials, account profiles, logs and machine-specific receipts.
