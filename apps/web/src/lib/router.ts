import { useEffect, useState } from "react";

export interface Route {
  parts: string[];
  query: URLSearchParams;
}

/** Minimal hash router: "#/alerts/3?x=1" -> { parts: ["alerts","3"], query }. Works on any static host. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, "");
  const [path, qs = ""] = raw.split("?");
  return { parts: path.split("/").filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(qs) };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const on = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

export const href = (...parts: (string | number)[]) => "#/" + parts.map((p) => encodeURIComponent(String(p))).join("/");
