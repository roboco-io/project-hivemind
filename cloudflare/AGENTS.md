# Hivemind Project Rules

- Implement Cloudflare first, then implement the AWS backend. Do not deploy AWS as a substitute for an unverified Cloudflare backend.
- Use official Codex and Claude Code CLIs with the user's subscription authentication. Do not replace this with API billing or AI Gateway provider keys.
- For AWS work, use profile `roboco`, region `ap-northeast-2` unless explicitly overridden, and AWS CDK for infrastructure.
- Use Cloudflare's native declarative Wrangler configuration for its Worker, Durable Object and container bindings; keep the later AWS infrastructure in CDK.
- Keep platform-specific execution, state, artifact and credential storage behind explicit backend boundaries. Share job and snapshot contracts across backends.
- Label local Docker, Cloudflare and AWS evidence separately. A passing local check cannot satisfy a remote platform's feasibility gate.
- Preserve credential-stream serialization, official internal subagents and subscription-free parallel build/test containers.
- Never print, commit, bake into images or include subscription credentials in normal artifacts. Cloudflare account credentials are separate from model subscription credentials.
- Cloudflare exec may inherit capabilities despite UID 1000. Drop inheritable, ambient and bounding capabilities and set no-new-privileges before running coding or compute processes. Keep the CLI sandbox enabled and verify file boundaries remotely.
