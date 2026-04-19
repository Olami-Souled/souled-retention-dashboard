# Refreshing the Meta spend cache

The dashboard reads daily Souled Meta spend from `data/meta_spend.json`. There's no live Meta API hook on the server (Railway doesn't have access to the Windsor.ai MCP, and we don't have a Windsor REST API key wired up). Refresh manually when needed:

## Option A — via Claude (easiest)

Ask Claude in this project:

> Refresh the Meta spend cache up to today.

Claude will:
1. Use the Windsor.ai MCP (`mcp__a739fb41…__get_data`) with `connector="facebook"`, `accounts=["548376353109705"]`, `fields=["date","spend"]`, and a date range covering whatever's missing or stale.
2. Merge into `data/meta_spend.json` (preserving the existing structure and adding new days).
3. Commit and push so Railway picks up the new data.

## Option B — manually via Windsor.ai web UI

1. Log in to Windsor.ai.
2. Open the Souled Facebook account (548376353109705).
3. Export `date, spend` for the date range you want.
4. Convert into the JSON shape used in `data/meta_spend.json` (`spend_by_day`: `{ "YYYY-MM-DD": number }`).
5. Update the `latest` and `fetched_at` fields, commit, and push.

## Option C — wire up Windsor REST API (long-term fix)

If we ever want the server to refresh on its own:
1. Create a Windsor.ai API key for the account.
2. Add `WINDSOR_API_KEY` to `.env` locally and to Railway env vars.
3. Replace this static cache with a server-side fetch (with 1-hour TTL) calling Windsor's REST API: `POST https://windsor.ai/api/v1/...`.
