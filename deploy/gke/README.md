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

Build and push the immutable version tag before applying the workload:

```bash
gcloud builds submit \
  --project tworld-473700 \
  --tag us-west1-docker.pkg.dev/tworld-473700/token-widget/registry:0.2.0

kubectl apply -f deploy/gke/token-widget.yaml
kubectl -n token-widget rollout status deployment/token-widget-registry
```

After the Ingress receives the reserved address, create this DNS record:

```text
api.tokenwidget.app  A  <token-widget-api address>
```

The managed certificate remains in `Provisioning` until public DNS points to
the Ingress address. Do not enable the desktop registry URL until HTTPS is
active and the public API smoke test passes.
