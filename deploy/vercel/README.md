# Vercel website deployment

The public website is a static deployment from the repository's `web/`
directory. The root `vercel.json` skips dependency installation and build
steps, publishes `web/`, and proxies browser-facing API and download routes to
the GKE registry at `api.tokenwidget.app`.

## Import settings

Import `SergioChan/token-meter` into Vercel with these settings:

- Framework Preset: `Other`
- Root Directory: repository root
- Install Command: use the repository setting (disabled)
- Build Command: use the repository setting (disabled)
- Output Directory: use the repository setting (`web`)
- Environment variables: none

The deployment can be previewed on its generated Vercel URL before attaching
the production domain. API-backed pages require `api.tokenwidget.app` to be
live because the rewrite destination is intentionally fixed to that origin.

## Domains

Attach these domains in the Vercel project:

```text
tokenwidget.app
www.tokenwidget.app
```

Use the DNS records shown by Vercel for the apex and `www` domains. Do not copy
historical Vercel IP addresses from documentation. The API uses a separate
Google Cloud Load Balancer record documented in `deploy/gke/README.md`.

## Verification

After DNS and TLS are active, verify:

```bash
curl -fsS https://tokenwidget.app/
curl -fsS https://tokenwidget.app/api/v1/health
curl -fsS https://tokenwidget.app/api/v1/leaderboard
curl -fsS https://tokenwidget.app/install.sh
```

`/api/v1/latest` and `/download/*` return `404` until a real signed and
notarized release artifact is published. Do not advertise a successful binary
download before that release exists.
