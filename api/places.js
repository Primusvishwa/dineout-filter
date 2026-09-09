import { findPlaces, sendJson, queryOf } from "./_swiggy.js";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  try {
    sendJson(res, 200, { places: await findPlaces(queryOf(req).get("q") || "") });
  } catch (err) {
    sendJson(res, 502, { error: String(err.message || err) });
  }
}
