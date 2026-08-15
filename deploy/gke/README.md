# GKE registry deployment

The production registry runs in the `token-widget` namespace on GKE Autopilot.
It connects to the private Cloud SQL instance through the Cloud SQL Auth Proxy
and exposes `api.tokenwidget.app` through a GCE Ingress and Google-managed TLS
certificate.

Required Google Cloud resources:

- Project: `tworld-473700`
- Region: `us-west1`
- GKE cluster: `autopilot-cluster-tradar`
- Cloud SQL instance: `token-widget`
- Artifact Registry repository: `token-widget`
- Google service account: `token-widget-registry@tworld-473700.iam.gserviceaccount.com`
- Global static IP: `token-widget-api`

The manifest intentionally does not contain database credentials. Create the
runtime secret directly in the cluster:

```bash
kubectl -n token-widget create secret generic token-widget-database \
  --from-literal=database-url='postgresql://USER:PASSWORD@127.0.0.1:5432/token_widget'
```

Build and push a unique Git-revision tag before applying the workload:

```bash
REVISION="git-$(git rev-parse --short HEAD)"
IMAGE="us-west1-docker.pkg.dev/tworld-473700/token-widget/registry"

gcloud builds submit \
  --project tworld-473700 \
  --tag "${IMAGE}:${REVISION}"

gcloud artifacts docker images describe \
  "${IMAGE}:${REVISION}" \
  --project tworld-473700 \
  --format='value(image_summary.digest)'
```

Pin the returned `sha256:...` digest in `token-widget.yaml`. Artifact Registry
tags are immutable in production, and the Deployment uses a digest so a
recorded revision always resolves to the same image. Validate and apply:

```bash
kubectl apply --server-side --dry-run=server -f deploy/gke/token-widget.yaml

kubectl apply -f deploy/gke/token-widget.yaml
kubectl -n token-widget rollout status deployment/token-widget-registry
```

The manifest intentionally keeps `TOKEN_WIDGET_PROFILE_READS=0`. For the
multi-device Profile upgrade, follow
[the staged migration runbook](../../docs/multi-device-migration.md); do not
flip that flag merely because the new image is healthy.

The Ingress uses the reserved global address `34.102.136.142`. Create this DNS
record after the registry Pod and database health check pass:

```text
api.tokenwidget.app  A  34.102.136.142
```

The managed certificate remains in `Provisioning` until public DNS points to
the Ingress address. Do not enable the desktop registry URL until HTTPS is
active and the public API smoke test passes.
