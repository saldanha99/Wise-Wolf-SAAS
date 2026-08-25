# Frontend proxy for `system` and the Hub

These files describe the `system.wisewolflanguage.com.br` and
`hub.wisewolflanguage.com.br` routes without assuming the VPS Compose service
name, Docker network, Traefik entry points, or ACME resolver.

## Files

- `nginx-spa.conf` is the frontend container configuration. It serves `app`,
  `system` and `hub`, maps every public Hub landing plus `/seja-professor` and
  `/new-saas` to build-time HTML, returns a real `404` with `noindex` for unknown
  Hub routes, prevents stale HTML/service-worker caching, and keeps fingerprinted
  Vite assets immutable.
- `traefik-system.labels.yml` is a label mapping to merge into the **existing**
  frontend service that already serves `app.wisewolflanguage.com.br`. It adds a
  dedicated HTTPS router, HTTP-to-HTTPS redirect, TLS, and baseline headers.
- `traefik-hub.labels.yml` adds the Hub through a separate router and certificate
  lifecycle. Do not merge it until the Hub DNS record resolves to the VPS.
- `docker-compose.hub.override.yml` is the audited production override for the
  current `/opt/wisewolf/frontend` stack. The activation script installs it as
  `docker-compose.override.yml`, which makes later `docker compose` releases
  preserve the dedicated Hub router automatically.
- `../activate-hub-public.sh` performs the guarded, idempotent activation. It
  can use an already published A record or create it with a new zone-scoped
  Cloudflare token supplied only through a private file.

The regular VPS release includes `nginx-spa.conf` in the checksummed artifact,
validates it with the exact frontend image, and swaps or restores it in the same
transaction as the built frontend. This keeps `/hub/*` SEO routing active even
before the optional dedicated-domain router is enabled. The release and the
domain-activation flow share the Hub activation lock, so they cannot replace the
proxy concurrently.

After the dedicated DNS cutover, both URL families consolidate SEO signals on
`hub.wisewolflanguage.com.br/*`. The `system.wisewolflanguage.com.br/hub/*`
routes remain as compatibility entries, but their canonicals point to the
dedicated Hub host.

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

## Secure activation

Never reuse a token pasted into a chat, ticket, terminal history or log. Revoke
it and create a new Cloudflare API token limited to this zone with only
`Zone:Read` and `DNS:Edit`. R2/S3 access keys cannot manage DNS and must not be
given to the activation script.

If the A record has already been created in the Cloudflare dashboard, activate
the proxy after public propagation:

```sh
RUN=yes deploy/vps/activate-hub-public.sh
```

To let the script create the missing DNS-only A record, store a newly issued
zone-scoped token outside the repository and protect it before activation:

```sh
chmod 600 /secure/path/cloudflare-dns-token
RUN=yes HUB_CREATE_DNS=yes \
  CLOUDFLARE_API_TOKEN_FILE=/secure/path/cloudflare-dns-token \
  deploy/vps/activate-hub-public.sh
```

For an account-scoped API token, also set the 32-character account identifier:

```sh
RUN=yes HUB_CREATE_DNS=yes \
  CLOUDFLARE_ACCOUNT_ID=your_account_id \
  CLOUDFLARE_API_TOKEN_FILE=/secure/path/cloudflare-dns-token \
  deploy/vps/activate-hub-public.sh
```

The script verifies account tokens through the account token endpoint and user
tokens through the user token endpoint before reading or changing DNS.

The script never accepts the token on the command line or stores it on the VPS.
It refuses conflicting records, validates both `1.1.1.1` and `8.8.8.8`, checks
the existing HTTP-01 resolver, validates Compose and Nginx before the change,
keeps a backup, and automatically restores the previous proxy on failure.

The intended dedicated Hub hostname is `hub.wisewolflanguage.com.br`. The spelling
`hub.wiseowllanguage.com.br` belongs to a different base domain and must not be
configured as an alias unless ownership of that domain is independently proven.

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

After the Hub DNS record resolves to the VPS and its labels have been merged,
validate the dedicated route separately:

```sh
curl --fail --show-error --silent --output /dev/null --dump-header - \
  https://hub.wisewolflanguage.com.br/

curl --fail --show-error --silent --output /dev/null --dump-header - \
  https://hub.wisewolflanguage.com.br/biblioteca
```

If the existing resolver uses HTTP-01 or TLS-ALPN-01, it cannot pre-issue the
certificate while public DNS still points elsewhere. Use the already configured
DNS-01 resolver (if available) or plan certificate issuance as part of the DNS
window; do not consider a default/self-signed certificate ready for cutover.
