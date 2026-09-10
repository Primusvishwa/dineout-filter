// Shared Swiggy Dineout scraping logic, used by both the Vercel serverless functions
// and the Vite dev middleware so the two can't drift apart.

const ORIGIN = "https://www.swiggy.com";
const LISTING_ENDPOINT = "/api/seo/getListing";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const PAGE_SIZE = 15;
const BATCH = 8;
const MAX_PAGES = 24;
// The UI's distance slider tops out at 10km, so there's nothing to gain past it.
const REACH_KM = 10;

const CACHE_TTL_MS = 10 * 60 * 1000;

// Warm instances reuse these; cold starts rebuild them. Harmless either way.
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

const uuid = () =>
  globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now();

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

// The listing widget pages through an opaque base64 token that decodes to
// {collectionId, offset}. Re-encoding it with our own offset means pages can be
// requested in parallel instead of walking them one cursor at a time.
function offsetToken(collection, offset) {
  return {
    dineout_seo_restaurant: Buffer.from(
      JSON.stringify({ ...collection, offset })
    ).toString("base64"),
    dineout_seo_sort_and_filter: "",
  };
}

async function listingPage(loc, collection, offset, retry = true) {
  if (!sessionJar) await warmUp();

  const body = {
    tags: "layout_dineout_seo",
    isFiltered: true,
    sortAttribute: "distance",
    queryId: "seo-data-" + uuid(),
    metaMap: {
      locality: "",
      ambienceTag: "",
      restaurantCategory: "",
      allCuisines: "",
      landmarkName: "",
      brandId: "",
      dinersoneTag: "",
    },
    seoParams: {
      apiName: "DOCollectionApi",
      brandId: "",
      seoUrl: "www.swiggy.com/dineout",
      pageType: "DO_HOME_PAGE",
      businessLine: "DINEOUT",
    },
  };
  if (collection) body.widgetOffset = offsetToken(collection, offset);

  const res = await fetch(
    `${ORIGIN}${LISTING_ENDPOINT}?lat=${loc.lat}&lng=${loc.lng}&apiV2=true`,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: ORIGIN,
        Referer: ORIGIN + "/dineout",
        latitude: String(loc.lat),
        longitude: String(loc.lng),
        Cookie: `${sessionJar}; ${locationCookie(loc)}`,
      },
      body: JSON.stringify(body),
    }
  );

  if ((res.status === 403 || res.status === 429) && retry) {
    await warmUp();
    return listingPage(loc, collection, offset, false);
  }
  if (!res.ok) throw new Error(`listing responded ${res.status}`);

  const json = await res.json();
  // Swiggy answers 200 with an error envelope rather than an HTTP error status
  const success = json?.data?.success ?? json?.success;
  if (!success?.cards) throw new Error(json?.statusMessage || "listing returned no cards");
  return success;
}

function restaurantsIn(success) {
  const found = [];
  for (const card of success.cards ?? []) {
    const grid = card?.card?.card?.gridElements?.infoWithStyle?.restaurants;
    if (grid) found.push(...grid);
  }
  return found;
}

function collectionOf(success) {
  const token = success?.pageOffset?.widgetOffset?.dineout_seo_restaurant;
  if (!token) return null;
  try {
    return JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    return null;
  }
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
  };
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

  // A first-page failure means Swiggy refused us outright, which is not the same as an
  // area having no discounted restaurants — let it surface rather than read as empty.
  const first = await listingPage(loc, null, 0);
  const collection = collectionOf(first);

  const everySeen = new Set();
  const discounted = new Map();
  let reach = 0;

  // Returns how many genuinely new restaurants a page contributed, so an exhausted
  // list stops the paging even when none of them qualify on discount.
  const absorb = (entries) => {
    let added = 0;
    for (const entry of entries) {
      const r = normalize(entry);
      reach = Math.max(reach, r.distanceKm);
      if (everySeen.has(r.id)) continue;
      everySeen.add(r.id);
      added++;
      // the lowest tier in the UI starts at 10%, so anything below it has no bucket
      if (r.discount >= 10) discounted.set(r.id, r);
    }
    return added;
  };
  absorb(restaurantsIn(first));

  // Results come back nearest-first, so paging stops once we pass what the UI can show.
  for (let next = PAGE_SIZE; collection && next < MAX_PAGES * PAGE_SIZE; next += BATCH * PAGE_SIZE) {
    const offsets = Array.from({ length: BATCH }, (_, i) => next + i * PAGE_SIZE);
    const pages = await Promise.all(
      offsets.map((offset) => listingPage(loc, collection, offset).catch(() => null))
    );
    const added = pages.reduce((n, p) => n + (p ? absorb(restaurantsIn(p)) : 0), 0);
    if (!added || reach >= REACH_KM) break;
  }

  const value = [...discounted.values()];
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
