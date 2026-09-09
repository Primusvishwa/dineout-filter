import { collectRestaurants, resolvePlace, sendJson, queryOf } from "./_swiggy.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  try {
    const params = queryOf(req);
    const placeId = params.get("placeId");
    let location;

    if (placeId) {
      location = await resolvePlace(placeId, params.get("text") || "");
      if (!location) return sendJson(res, 502, { error: "Could not pin that place on the map." });
    } else {
      location = {
        lat: +params.get("lat"),
        lng: +params.get("lng"),
        address: params.get("address") || "",
      };
      if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
        return sendJson(res, 400, { error: "Missing placeId or lat/lng." });
      }
    }

    sendJson(res, 200, { location, restaurants: await collectRestaurants(location) });
  } catch (err) {
    sendJson(res, 502, { error: String(err.message || err) });
  }
}
