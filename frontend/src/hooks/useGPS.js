import { useEffect, useRef, useState } from "react";
import { haversineMeters } from "../lib/geo";

export function useGPS(enabled = true) {
  const [pos, setPos] = useState(null);
  const [accuracy, setAccuracy] = useState(null);
  const [error, setError] = useState(null);
  const lastRef = useRef(null);

  useEffect(() => {
    if (!enabled) return;
    if (!navigator.geolocation) {
      setError("unsupported");
      return;
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setError(null);
        setAccuracy(p.coords.accuracy);
        const np = { lat: p.coords.latitude, lng: p.coords.longitude };
        if (!lastRef.current || haversineMeters(lastRef.current, np) > 1) {
          lastRef.current = np;
          setPos(np);
        }
      },
      (err) => setError(err.code === 1 ? "denied" : "unavailable"),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [enabled]);

  const quality = accuracy == null ? null : accuracy <= 8 ? "GOOD" : accuracy <= 15 ? "FAIR" : "POOR";
  return { pos, accuracy, quality, error };
}
