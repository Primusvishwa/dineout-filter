# Dineout, sorted properly

A restaurant discount filter for Swiggy Dineout, built because Swiggy's own filter lumps
everything from 10% to 40% into a single bucket. This one separates every tier, so a 45%
deal doesn't hide behind a wall of 10% ones.

**Live:** https://dineout-filter.vercel.app

## What it does

- **Discount tiers, separated** — 10–19%, 20–29%, 30–39%, 40–49%, 50%+, each individually
  selectable rather than collapsed into one range
- **Location search** — type any area and the whole list re-centres on it, with distances
  measured from there
- **Filters** — cuisine, cost for two (six brackets), minimum rating, maximum distance
- **Sorting** — by discount, rating, or distance
- **Multi-city** — works anywhere Swiggy Dineout operates (Bengaluru, Chennai, Hyderabad,
  Mumbai, Delhi and ~40 more). Nothing in the code is city-specific.

Discount figures are Swiggy's pre-book and vendor offers only. Bank and card offers are
deliberately excluded, since they aren't available to everyone.

## How it works

Swiggy's own MCP server exposes a `search_restaurants_dineout` tool, but it returns an
empty payload for every query (see [Notes](#notes)). So the data comes from Swiggy's
public Dineout pages instead.

```
browser ──▶ /api/places       ──▶ Swiggy place-autocomplete
        └─▶ /api/restaurants  ──▶ Swiggy Dineout listing pages
```

Two details make this work:

**The location cookie.** Swiggy's listing pages re-rank around a `userLocation` cookie
rather than a URL parameter. `fetch()` can't set a cookie for another origin, so the
serverless function does it. That's also why the API exists at all — the browser can't
call swiggy.com directly because of CORS.

**The session warm-up.** Swiggy's WAF rejects requests that arrive without the cookies a
normal page load hands out. The function does a warm-up GET first, keeps that cookie jar,
and replays it — re-warming and retrying once if a request still comes back 403.

Restaurant data is parsed out of the `__NEXT_DATA__ ` blob embedded in each server-rendered
page, deduplicated across six listing pages, and cached for 10 minutes per location.

Place search uses Swiggy's autocomplete for suggestions. Turning a chosen suggestion into
coordinates normally uses Swiggy's `address-recommend`, but that endpoint is blocked from
datacenter IPs, so it falls back to OpenStreetMap — which lands within about half a
kilometre of Swiggy's own coordinates, well inside what matters for distance ranking.

## Running locally

```bash
npm install
npm run dev
```

`swiggy-proxy.js` is a dev-only Vite plugin that serves the exact same handlers Vercel runs
in production, so local and deployed behaviour can't drift apart.

## Notes

- **No "open now" filter.** It existed, and worked, but it cost one extra request per
  restaurant — about 56 requests per search instead of 6. That got Vercel's shared egress
  IPs rate-limited by Swiggy within minutes. Dropping it took searches from ~6s to under 2s
  and made the whole thing sustainable.
- **This depends on Swiggy's rate limits staying where they are.** If searches start
  failing, that's why. The fix would be to pre-fetch a set of areas and ship them as static
  JSON, removing the runtime dependency entirely.
- Ratings shown as `0` are restaurants Swiggy has no rating for yet.

## Stack

React + Vite, deployed on Vercel with two Node serverless functions. No database, no keys,
no environment variables.
