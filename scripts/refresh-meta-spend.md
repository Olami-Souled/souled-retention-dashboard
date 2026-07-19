# Refreshing the Meta spend cache

The dashboard reads daily Souled Meta spend from `data/meta_spend.json`
(`spend_by_day`: `{ "YYYY-MM-DD": number }`). Data comes from the **direct Meta
Marketing API** (Windsor.ai was retired in July 2026 — it overstated spend by
~15%, so these numbers are now the accurate Ads Manager figures).

## Automatic (default)

The GitHub Actions workflow `.github/workflows/refresh-meta-spend.yml` runs daily
(04:20 UTC) and on-demand (`workflow_dispatch`). It runs
`node scripts/refresh-meta-spend.js`, which pulls daily account-level spend and
commits `data/meta_spend.json` when it changes. Requires the repo secret
`FACEBOOK_ADS_TOKEN` (permanent System User token, `ads_read`).

## Manual

```bash
FACEBOOK_ADS_TOKEN=... node scripts/refresh-meta-spend.js            # since existing earliest
FACEBOOK_ADS_TOKEN=... node scripts/refresh-meta-spend.js --since 2024-09-01
```

Then commit and push `data/meta_spend.json` so the deployed dashboard picks it up.
