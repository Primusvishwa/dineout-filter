import React, { useState, useMemo, useEffect } from "react";
import { Star, MapPin, Clock, X, ArrowUpDown, Search, Loader2 } from "lucide-react";

// Where the app opens before you pick somewhere else.
const DEFAULT_LOCATION = {
  lat: 12.9895552,
  lng: 77.7126571,
  address: "Hoodi, Mahadevapura, Bengaluru, Karnataka 560048, India",
};

function parseTime(token) {
  const t = token.trim();
  if (/^noon$/i.test(t)) return 720;
  if (/^midnight$/i.test(t)) return 0;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i.exec(t);
  if (!m) return null;
  const hour = (+m[1] % 12) + (/PM/i.test(m[3]) ? 12 : 0);
  return hour * 60 + +(m[2] || 0);
}

function rangesFor(spec) {
  if (!spec) return [];
  return spec
    .split("·")
    .map((part) => {
      const [from, to] = part.split("-");
      if (!to) return null;
      const start = parseTime(from);
      const end = parseTime(to);
      return start === null || end === null ? null : [start, end];
    })
    .filter(Boolean);
}

function isOpenNow(hours, now = new Date()) {
  // a few outlets publish no timings at all, and those read as closed rather than crash
  const dayFor = (i) => (typeof hours === "string" ? hours : hours?.[i] || "");
  const today = (now.getDay() + 6) % 7;
  const mins = now.getHours() * 60 + now.getMinutes();
  // end <= start means the shift runs past midnight, so it also covers early today
  return (
    rangesFor(dayFor(today)).some(([s, e]) => (e > s ? mins >= s && mins < e : mins >= s)) ||
    rangesFor(dayFor((today + 6) % 7)).some(([s, e]) => e <= s && mins < e)
  );
}

async function loadRestaurants(place) {
  const query = place.placeId
    ? `placeId=${encodeURIComponent(place.placeId)}`
    : `lat=${place.lat}&lng=${place.lng}&address=${encodeURIComponent(place.address)}`;
  const res = await fetch(`/api/restaurants?${query}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || "Could not reach Swiggy.");
  return {
    location: body.location,
    restaurants: body.restaurants.map((r) => ({ ...r, openNow: isOpenNow(r.hours) })),
  };
}

// Fine-grained discount tiers, instead of Swiggy's 10-40% / 50% split
const DISCOUNT_TIERS = [
  { label: "10-19%", min: 10, max: 19, color: "#E8C97A" },
  { label: "20-29%", min: 20, max: 29, color: "#DDAE4C" },
  { label: "30-39%", min: 30, max: 39, color: "#C98F3A" },
  { label: "40-49%", min: 40, max: 49, color: "#B96B3C" },
  { label: "50%+", min: 50, max: 999, color: "#A63D40" },
];

function tierFor(discount) {
  return DISCOUNT_TIERS.find((t) => discount >= t.min && discount <= t.max) || DISCOUNT_TIERS[0];
}

// Upper bound is exclusive so a round number like ₹1000 lands in exactly one bucket.
const COST_BUCKETS = [
  { label: "Under ₹500", min: 0, max: 500 },
  { label: "₹500 - 1000", min: 500, max: 1000 },
  { label: "₹1000 - 1500", min: 1000, max: 1500 },
  { label: "₹1500 - 2000", min: 1500, max: 2000 },
  { label: "₹2000 - 2500", min: 2000, max: 2500 },
  { label: "₹2500+", min: 2500, max: Infinity },
];

function bucketFor(cost) {
  return COST_BUCKETS.find((b) => cost >= b.min && cost < b.max) || COST_BUCKETS[0];
}

export default function DineoutFilter() {
  const [selectedTiers, setSelectedTiers] = useState([]);
  const [selectedCuisines, setSelectedCuisines] = useState([]);
  const [selectedCosts, setSelectedCosts] = useState([]);
  const [minRating, setMinRating] = useState(0);
  const [maxDistance, setMaxDistance] = useState(10);
  const [openNowOnly, setOpenNowOnly] = useState(false);
  const [sortBy, setSortBy] = useState("discount-desc");

  const [restaurants, setRestaurants] = useState([]);
  const [location, setLocation] = useState(DEFAULT_LOCATION);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [query, setQuery] = useState("");
  const [places, setPlaces] = useState([]);

  const pickPlace = async (place) => {
    setQuery("");
    setPlaces([]);
    setLoading(true);
    setError(null);
    // cuisines differ by area, so a stale pick would silently filter everything out
    setSelectedCuisines([]);
    try {
      const data = await loadRestaurants(place);
      setLocation(data.location);
      setRestaurants(data.restaurants);
    } catch (e) {
      setError(e.message);
      setRestaurants([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    pickPlace(DEFAULT_LOCATION);
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 3) {
      setPlaces([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/places?q=${encodeURIComponent(term)}`);
        const body = await res.json();
        if (!cancelled) setPlaces(body.places || []);
      } catch {
        if (!cancelled) setPlaces([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const allCuisines = useMemo(
    () => [...new Set(restaurants.map((r) => r.cuisine))].filter(Boolean).sort(),
    [restaurants]
  );

  const toggleTier = (label) =>
    setSelectedTiers((prev) =>
      prev.includes(label) ? prev.filter((t) => t !== label) : [...prev, label]
    );

  const toggleCuisine = (c) =>
    setSelectedCuisines((prev) =>
      prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]
    );

  const toggleCost = (label) =>
    setSelectedCosts((prev) =>
      prev.includes(label) ? prev.filter((x) => x !== label) : [...prev, label]
    );

  const clearAll = () => {
    setSelectedTiers([]);
    setSelectedCuisines([]);
    setSelectedCosts([]);
    setMinRating(0);
    setMaxDistance(10);
    setOpenNowOnly(false);
  };

  const filtered = useMemo(() => {
    let list = restaurants.filter((r) => {
      const tier = tierFor(r.discount);
      if (selectedTiers.length && !selectedTiers.includes(tier.label)) return false;
      if (selectedCuisines.length && !selectedCuisines.includes(r.cuisine)) return false;
      if (selectedCosts.length && !selectedCosts.includes(bucketFor(r.costForTwo).label)) return false;
      if (r.rating < minRating) return false;
      if (r.distanceKm > maxDistance) return false;
      if (openNowOnly && !r.openNow) return false;
      return true;
    });

    list.sort((a, b) => {
      switch (sortBy) {
        case "discount-desc":
          return b.discount - a.discount;
        case "discount-asc":
          return a.discount - b.discount;
        case "rating-desc":
          return b.rating - a.rating;
        case "distance-asc":
          return a.distanceKm - b.distanceKm;
        default:
          return 0;
      }
    });
    return list;
  }, [restaurants, selectedTiers, selectedCuisines, selectedCosts, minRating, maxDistance, openNowOnly, sortBy]);

  const activeFilterCount =
    selectedTiers.length + selectedCuisines.length + selectedCosts.length + (minRating > 0 ? 1 : 0) + (maxDistance < 10 ? 1 : 0) + (openNowOnly ? 1 : 0);

  return (
    <div
      style={{
        background: "#FAF7F0",
        color: "#232920",
        minHeight: "100vh",
        fontFamily: "'Inter', system-ui, sans-serif",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600&display=swap');
        .heading { font-family: 'Fraunces', serif; }
        .chip { transition: transform 0.1s ease, box-shadow 0.1s ease; }
        .chip:active { transform: scale(0.97); }
        .suggestion:hover { background: #FAF7F0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spin { animation: spin 0.9s linear infinite; }
      `}</style>

      <div style={{ maxWidth: 1100, margin: "0 auto", padding: "28px 20px 60px" }}>
        {/* Header */}
        <div style={{ marginBottom: 28 }}>
          <h1 className="heading" style={{ fontSize: 30, fontWeight: 600, margin: 0, color: "#232920" }}>
            Dineout, sorted properly
          </h1>
          <p style={{ margin: "6px 0 0", fontSize: 14, color: "#5C7A6B" }}>
            Every discount tier separated. Live Swiggy Dineout listings.
          </p>

          {/* Location search */}
          <div style={{ position: "relative", maxWidth: 420, marginTop: 16 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                background: "#fff",
                border: "1px solid #E6E0D2",
                borderRadius: 8,
                padding: "9px 12px",
              }}
            >
              <Search size={14} color="#5C7A6B" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search any area in Bengaluru…"
                style={{
                  flex: 1,
                  border: "none",
                  outline: "none",
                  fontSize: 13,
                  color: "#232920",
                  background: "transparent",
                  fontFamily: "inherit",
                }}
              />
              {loading && <Loader2 className="spin" size={14} color="#5C7A6B" />}
            </div>

            {places.length > 0 && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  left: 0,
                  right: 0,
                  background: "#fff",
                  border: "1px solid #E6E0D2",
                  borderRadius: 8,
                  overflow: "hidden",
                  zIndex: 20,
                  boxShadow: "0 6px 18px rgba(35,41,32,0.09)",
                }}
              >
                {places.map((p) => (
                  <button
                    key={p.placeId}
                    className="suggestion"
                    onClick={() => pickPlace(p)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "9px 12px",
                      border: "none",
                      borderBottom: "1px solid #F1ECE0",
                      background: "none",
                      cursor: "pointer",
                      fontFamily: "inherit",
                    }}
                  >
                    <div style={{ fontSize: 13, color: "#232920" }}>{p.label}</div>
                    {p.sublabel && (
                      <div style={{ fontSize: 11, color: "#5C7A6B", marginTop: 1 }}>{p.sublabel}</div>
                    )}
                  </button>
                ))}
              </div>
            )}

            <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 12, color: "#5C7A6B", marginTop: 7 }}>
              <MapPin size={11} />
              {loading ? "Loading restaurants…" : location.address}
            </div>
          </div>

          {error && (
            <div
              style={{
                marginTop: 12,
                maxWidth: 420,
                fontSize: 12,
                color: "#A63D40",
                background: "#A63D400F",
                border: "1px solid #A63D4033",
                borderRadius: 8,
                padding: "9px 12px",
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div style={{ display: "flex", gap: 28, alignItems: "flex-start", flexWrap: "wrap" }}>
          {/* Filter panel */}
          <div
            style={{
              width: 260,
              flexShrink: 0,
              background: "#FFFFFF",
              border: "1px solid #E6E0D2",
              borderRadius: 10,
              padding: 18,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <span style={{ fontSize: 13, fontWeight: 600, letterSpacing: 0.2 }}>Filters</span>
              {activeFilterCount > 0 && (
                <button
                  onClick={clearAll}
                  style={{
                    fontSize: 12,
                    color: "#A63D40",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 3,
                  }}
                >
                  <X size={13} /> Clear ({activeFilterCount})
                </button>
              )}
            </div>

            {/* Discount tiers */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "#5C7A6B", marginBottom: 8, fontWeight: 500 }}>
                Discount tier
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {DISCOUNT_TIERS.map((t) => {
                  const active = selectedTiers.includes(t.label);
                  return (
                    <button
                      key={t.label}
                      className="chip"
                      onClick={() => toggleTier(t.label)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        borderRadius: 6,
                        border: active ? `1.5px solid ${t.color}` : "1px solid #E6E0D2",
                        background: active ? `${t.color}22` : "#fff",
                        cursor: "pointer",
                        fontSize: 13,
                        textAlign: "left",
                      }}
                    >
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: t.color, flexShrink: 0 }} />
                      {t.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Cuisine */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "#5C7A6B", marginBottom: 8, fontWeight: 500 }}>Cuisine</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {allCuisines.map((c) => {
                  const active = selectedCuisines.includes(c);
                  return (
                    <button
                      key={c}
                      className="chip"
                      onClick={() => toggleCuisine(c)}
                      style={{
                        padding: "5px 10px",
                        borderRadius: 14,
                        border: active ? "1.5px solid #5C7A6B" : "1px solid #E6E0D2",
                        background: active ? "#5C7A6B22" : "#fff",
                        fontSize: 12,
                        cursor: "pointer",
                      }}
                    >
                      {c}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Cost for two */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "#5C7A6B", marginBottom: 8, fontWeight: 500 }}>
                Cost for two
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {COST_BUCKETS.map((b) => {
                  const active = selectedCosts.includes(b.label);
                  return (
                    <label
                      key={b.label}
                      className="chip"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        padding: "6px 10px",
                        borderRadius: 6,
                        border: active ? "1.5px solid #5C7A6B" : "1px solid #E6E0D2",
                        background: active ? "#5C7A6B22" : "#fff",
                        cursor: "pointer",
                        fontSize: 13,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggleCost(b.label)}
                        style={{ accentColor: "#5C7A6B", margin: 0 }}
                      />
                      {b.label}
                    </label>
                  );
                })}
              </div>
            </div>

            {/* Rating */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "#5C7A6B", marginBottom: 8, fontWeight: 500 }}>
                Min rating: {minRating.toFixed(1)}+
              </div>
              <input
                type="range"
                min="0"
                max="4.5"
                step="0.5"
                value={minRating}
                onChange={(e) => setMinRating(parseFloat(e.target.value))}
                style={{ width: "100%", accentColor: "#A63D40" }}
              />
            </div>

            {/* Distance */}
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "#5C7A6B", marginBottom: 8, fontWeight: 500 }}>
                Max distance: {maxDistance === 10 ? "10+ km" : `${maxDistance} km`}
              </div>
              <input
                type="range"
                min="1"
                max="10"
                step="1"
                value={maxDistance}
                onChange={(e) => setMaxDistance(parseInt(e.target.value))}
                style={{ width: "100%", accentColor: "#A63D40" }}
              />
            </div>

            {/* Open now */}
            <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={openNowOnly}
                onChange={(e) => setOpenNowOnly(e.target.checked)}
                style={{ accentColor: "#A63D40" }}
              />
              Open now only
            </label>
          </div>

          {/* Results */}
          <div style={{ flex: 1, minWidth: 300 }}>
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginBottom: 14,
              }}
            >
              <span style={{ fontSize: 13, color: "#5C7A6B" }}>
                {filtered.length} restaurant{filtered.length !== 1 ? "s" : ""}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <ArrowUpDown size={13} color="#5C7A6B" />
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  style={{
                    fontSize: 12,
                    border: "1px solid #E6E0D2",
                    borderRadius: 6,
                    padding: "5px 8px",
                    background: "#fff",
                    color: "#232920",
                  }}
                >
                  <option value="discount-desc">Discount: high to low</option>
                  <option value="discount-asc">Discount: low to high</option>
                  <option value="rating-desc">Rating: high to low</option>
                  <option value="distance-asc">Distance: nearest</option>
                </select>
              </div>
            </div>

            {filtered.length === 0 ? (
              <div
                style={{
                  padding: "40px 20px",
                  textAlign: "center",
                  color: "#5C7A6B",
                  background: "#fff",
                  border: "1px solid #E6E0D2",
                  borderRadius: 10,
                  fontSize: 13,
                }}
              >
                {loading
                  ? "Fetching restaurants for this area…"
                  : restaurants.length === 0
                  ? "No discounted restaurants found for this area."
                  : "No restaurants match this combination. Try loosening a filter."}
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {filtered.map((r) => {
                  const tier = tierFor(r.discount);
                  return (
                    <div
                      key={r.id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 14,
                        padding: "12px 14px",
                        background: "#fff",
                        border: "1px solid #E6E0D2",
                        borderRadius: 8,
                      }}
                    >
                      <div
                        style={{
                          flexShrink: 0,
                          width: 54,
                          height: 40,
                          borderRadius: 6,
                          background: tier.color,
                          color: "#fff",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 13,
                          fontWeight: 600,
                        }}
                      >
                        {r.discount}%
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="heading" style={{ fontSize: 16, fontWeight: 600 }}>
                          {r.name}
                        </div>
                        <div style={{ fontSize: 12, color: "#5C7A6B", display: "flex", gap: 10, flexWrap: "wrap", marginTop: 2 }}>
                          <span>{r.cuisine}</span>
                          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <MapPin size={11} /> {r.locality} · {r.distanceKm} km
                          </span>
                          <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                            <Star size={11} fill="#D9A521" color="#D9A521" /> {r.rating}
                          </span>
                          <span style={{ display: "flex", alignItems: "center", gap: 3, color: r.openNow ? "#4A7A5A" : "#A63D40" }}>
                            <Clock size={11} /> {r.openNow ? "Open now" : "Closed"}
                          </span>
                        </div>
                      </div>
                      <div style={{ fontSize: 13, color: "#5C7A6B", flexShrink: 0 }}>₹{r.costForTwo} for two</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
