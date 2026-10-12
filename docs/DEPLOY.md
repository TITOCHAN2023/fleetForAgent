# Moved

- [English](en/deploy.md)
- [中文](zh/deploy.md)

## Hosted Hub deployment boundary

The hosted deployment workflow verifies the checkout before making Cloudflare credentials available, accepts only `main`, and targets the GitHub `production` environment. It deploys the exact attested JavaScript file with `--no-bundle`, so deployment does not rebuild a different script after hashing it.

Configure protection for the `production` environment and `main` branch in GitHub, and keep a Cloudflare token with only the account and Worker deployment permissions needed in that environment's secrets. Adding `environment: production` to YAML does **not** enable required reviewers or branch protection by itself. These account settings must be verified by the repository owner; the code change does not configure them.

Browser requests carrying `fleet_session` must have a matching configured Hub Origin for state-changing requests (or a same-origin Referer for older clients without Origin). Sibling subdomains are rejected even when cookies are SameSite. Native token-authenticated Agent and Tool traffic does not depend on browser headers. This protects browser writes; `/source` metadata and an attestation are not proof that a compromised Hub or Cloudflare account is trustworthy.
