// Shared Swiggy Dineout scraping logic, used by both the Vercel serverless functions
// and the Vite dev middleware so the two can't drift apart.

const ORIGIN = "https://www.swiggy.com";
const NEXT_DATA = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Each of these re-ranks around whatever location the cookie carries. Kept deliberately
// short: every extra page is another round trip inside the function's time budget.
const LISTING_PATHS = [
  "/dineout",
  "/buffet-restaurants-dineout-near-me",
  "/rooftop-restaurants-dineout-near-me",
  "/microbrewery-restaurants-dineout-near-me",
  "/fine-dining-restaurants-dineout-near-me",
  "/casual-dining-restaurants-dineout-near-me",
];

const CACHE_TTL_MS = 10 * 60 * 1000;

// Warm instances reuse this; cold starts rebuild it. Harmless either way.
const cache = new Map();

const BROWSER_HEADERS = {
  "User-Agent": UA,
  "Accept-Language": "en-GB,en;q=0.9",
  "sec-ch-ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

// Swiggy's WAF rejects API calls that arrive without the session cookies a page load
// hands out, so we keep a jar from a warm-up GET and replay it.
let sessionJar = "";

async function warmUp() {
  const res = await fetch(ORIGIN + "/dineout", {
    headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml" },
  });
  const cookies = res.headers.getSetCookie?.() ?? [];
  sessionJar = cookies.map((c) => c.split(";")[0]).filter(Boolean).join("; ");
  return res;
}

function locationCookie(loc) {
  const value = encodeURIComponent(
    JSON.stringify({ lat: loc.lat, lng: loc.lng, address: loc.address })
  );
  return `userLocation=${value}; location=${value}`;
}

async function getHtml(path, loc, retry = true) {
  if (!sessionJar) await warmUp();
  const res = await fetch(ORIGIN + path, {
    headers: {
      ...BROWSER_HEADERS,
      Accept: "text/html,application/xhtml+xml",
      Cookie: `${sessionJar}; ${locationCookie(loc)}`,
    },
  });
  // a stale jar reads as a WAF rejection; a fresh warm-up usually clears it
  if ((res.status === 403 || res.status === 429) && retry) {
    await warmUp();
    return getHtml(path, loc, false);
  }
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.text();
}

async function postJson(path, body, retry = true) {
  if (!sessionJar) await warmUp();
  const res = await fetch(ORIGIN + path, {
    method: "POST",
    headers: {
      ...BROWSER_HEADERS,
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: ORIGIN,
      Referer: ORIGIN + "/dineout",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      Cookie: sessionJar,
    },
    body: JSON.stringify(body),
  });
  if (res.status === 403 && retry) {
    await warmUp();
    return postJson(path, body, false);
  }
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json();
}

function restaurantsFrom(html) {
  const match = NEXT_DATA.exec(html);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const cards = data?.props?.pageProps?.widgetResponse?.success?.cards ?? [];
  const found = [];
  for (const card of cards) {
    const grid = card?.card?.card?.gridElements?.infoWithStyle?.restaurants;
    if (grid) found.push(...grid);
  }
  return found;
}

const percent = (text) => {
  const m = /(\d+)\s*%/.exec(text || "");
  return m ? +m[1] : 0;
};

function normalize(entry) {
  const info = entry.info;
  const prebook = (info.offerInfoV2?.otherOffers?.offers || []).map((o) => percent(o.header));
  return {
    id: info.id,
    name: info.name,
    cuisine: (info.cuisines || [])[0] || "",
    locality: info.locality || info.displayAreaName || "",
    rating: +info.rating?.value || 0,
    costForTwo: +String(info.costForTwo || "").replace(/[^0-9]/g, "") || 0,
    distanceKm: parseFloat(info.locationInfo?.distanceString) || 0,
    // bank/cashback offers live elsewhere in the payload and are deliberately not counted
    discount: Math.max(0, percent(info.vendorOffer?.info?.description), ...prebook),
    link: entry.cta?.link || "",
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await fn(items[index]);
      } catch {
        results[index] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

export async function findPlaces(input) {
  if (!input || input.trim().length < 3) return [];
  const data = await postJson("/dapi/misc/place-autocomplete", { input: input.trim() });
  return (data?.data || []).slice(0, 8).map((p) => ({
    placeId: p.place_id,
    label: p.structured_formatting?.main_text || p.description,
    sublabel: p.structured_formatting?.secondary_text || "",
  }));
}

// Swiggy's WAF refuses address-recommend from datacenter IPs (it works from a home
// connection), so OpenStreetMap covers that one step when the primary is blocked.
// Measured against Swiggy's own coordinates, it lands within ~0.5km on localities.
async function geocode(text) {
  const parts = text.split(",").map((s) => s.trim()).filter(Boolean);
  // Swiggy's descriptions end "…, City, State, India", so keeping the tail rather than
  // naming a city keeps these fallbacks correct in every city it covers.
  const attempts = [
    text,
    [parts[0], ...parts.slice(-3)].join(", "),
    [parts[0], ...parts.slice(-2)].join(", "),
  ];
  for (const query of attempts) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=in&q=${encodeURIComponent(query)}`,
        { headers: { "User-Agent": "dineout-filter/1.0 (personal project)" } }
      );
      if (!res.ok) continue;
      const hit = (await res.json())[0];
      if (hit) return { lat: +hit.lat, lng: +hit.lon, address: text };
    } catch {
      // try the next, looser form of the query
    }
  }
  return null;
}

export async function resolvePlace(placeId, text) {
  if (placeId) {
    try {
      const data = await postJson("/dapi/misc/address-recommend", { place_id: placeId });
      const point = data?.data?.[0]?.geometry?.location;
      if (point) {
        return { lat: point.lat, lng: point.lng, address: data.data[0].formatted_address };
      }
    } catch {
      // blocked or unavailable — fall through to the geocoder
    }
  }
  return text ? geocode(text) : null;
}

export async function collectRestaurants(loc) {
  const key = `${loc.lat},${loc.lng}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const pages = await mapLimit(LISTING_PATHS, LISTING_PATHS.length, (p) => getHtml(p, loc));
  // Every page failing means Swiggy refused us, which is not the same as an area
  // genuinely having no discounted restaurants — don't let it read as an empty result.
  if (pages.every((p) => !p)) {
    throw new Error("Swiggy refused every listing request (likely a WAF block).");
  }

  const seen = new Map();
  for (const html of pages) {
    if (!html) continue;
    for (const entry of restaurantsFrom(html)) {
      const r = normalize(entry);
      // the lowest tier in the UI starts at 10%, so anything below it has no bucket
      if (r.discount >= 10 && r.link && !seen.has(r.id)) seen.set(r.id, r);
    }
  }

  const value = [...seen.values()].map(({ link, ...rest }) => rest);
  if (value.length) cache.set(key, { at: Date.now(), value });
  return value;
}

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  // a short shared cache keeps repeat visitors off Swiggy entirely
  res.setHeader("Cache-Control", "public, s-maxage=600, stale-while-revalidate=3600");
  res.end(JSON.stringify(payload));
}

export function queryOf(req) {
  return new URL(req.url, "http://localhost").searchParams;
}
