// Dev-only shim: serves the same handlers Vercel runs in production, so `npm run dev`
// and the deployed site behave identically. Vercel's Node functions take (req, res),
// which is exactly what Vite's middleware provides.
import places from "./api/places.js";
import restaurants from "./api/restaurants.js";

const ROUTES = {
  "/api/places": places,
  "/api/restaurants": restaurants,
};

export function swiggyProxy() {
  return {
    name: "swiggy-dineout-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = new URL(req.url, "http://localhost").pathname;
        const handler = ROUTES[path];
        if (!handler) return next();
        handler(req, res).catch((err) => {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: String(err.message || err) }));
        });
      });
    },
  };
}
