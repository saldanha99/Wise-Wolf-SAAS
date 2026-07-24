# Frontend proxy for the `system` cutover

These files describe the missing `system.wisewolflanguage.com.br` route without
assuming the VPS Compose service name, Docker network, Traefik entry points, or
ACME resolver.

## Files

- `nginx-spa.conf` is the frontend container configuration. It serves both
  `app` and `system`, rewrites client-side routes to `index.html`, prevents stale
  HTML/service-worker caching, and keeps fingerprinted Vite assets immutable.
- `traefik-system.labels.yml` is a label mapping to merge into the **existing**
  frontend service that already serves `app.wisewolflanguage.com.br`. It adds a
  dedicated HTTPS router, HTTP-to-HTTPS redirect, TLS, and baseline headers.

The label file is intentionally not a standalone Compose override. Creating a
second guessed service or network would be less safe than extending the known
working `app` service.

## Required deployment values

Before merging the labels, determine these values from the working `app` router:

- `TRAEFIK_FRONTEND_SERVICE`: its Traefik service name.
- `TRAEFIK_CERT_RESOLVER`: the resolver already used for the valid `app`
  certificate.
- `TRAEFIK_HTTP_ENTRYPOINT` and `TRAEFIK_HTTPS_ENTRYPOINT` only when the VPS does
  not use the conventional `web` and `websecure` names.

Do not replace the required-variable expressions with guessed names. Compose
must fail closed when either required value is absent.

## Read-only preflight

After the VPS Compose file has incorporated the fragment, validate the rendered
configuration before recreating any container:

```sh
docker compose config --quiet
```

After deployment, validate routing while preserving the production hostname and
without changing public DNS:

```sh
curl --resolve system.wisewolflanguage.com.br:443:187.127.46.251 \
  --fail --show-error --silent --output /dev/null --dump-header - \
  https://system.wisewolflanguage.com.br/

curl --resolve system.wisewolflanguage.com.br:443:187.127.46.251 \
  --fail --show-error --silent --output /dev/null --dump-header - \
  https://system.wisewolflanguage.com.br/login
```

Both requests must validate TLS normally and return the SPA, not Traefik's
default certificate or a `404`. Do not add `--insecure` to the acceptance test.

If the existing resolver uses HTTP-01 or TLS-ALPN-01, it cannot pre-issue the
certificate while public DNS still points elsewhere. Use the already configured
DNS-01 resolver (if available) or plan certificate issuance as part of the DNS
window; do not consider a default/self-signed certificate ready for cutover.
