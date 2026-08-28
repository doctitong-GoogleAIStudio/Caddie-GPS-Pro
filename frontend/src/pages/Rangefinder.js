import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { MapView } from "../components/MapView";
import { useGPS } from "../hooks/useGPS";
import { useSettings } from "../context/SettingsContext";
import { haversineMeters, bearingDeg, fmtDist, unitLabel, movedMoreThan } from "../lib/geo";
import { computePlaysLike } from "../lib/playsLike";
import { recommendClub } from "../lib/clubRec";
import { api, cachedGet, getActiveRound, setActiveRound } from "../lib/api";
import { House, CaretLeft, CaretRight, Crosshair, GpsFix, Stack, CaretUp, CaretDown, Wind } from "@phosphor-icons/react";

const DEFAULT_CENTER = { lat: 7.052, lng: 125.517 };
const WIND_DIRS = [["head", "HEADWIND"], ["tail", "TAILWIND"], ["left", "LEFT CROSS"], ["right", "RIGHT CROSS"], ["none", "NO WIND"]];

export default function Rangefinder() {
  const nav = useNavigate();
  const { settings } = useSettings();
  const unit = settings.distanceUnit;
  const { pos: gpsPos, accuracy, quality, error: gpsError } = useGPS(true);

  const activeRound = getActiveRound();
  const [course, setCourse] = useState(null);
  const [holeIdx, setHoleIdx] = useState((activeRound?.currentHole || 1) - 1);
  const [ball, setBall] = useState(null);
  const [ballSource, setBallSource] = useState("gps");
  const [target, setTarget] = useState(null);
  const [targetLabel, setTargetLabel] = useState("PIN");
  const [setBallMode, setSetBallMode] = useState(false);
  const [mapType, setMapType] = useState("satellite");
  const [elev, setElev] = useState(null);
  const [wind, setWind] = useState(() => { try { return JSON.parse(localStorage.getItem("sg_wind")) || { speed: 0, dir: "none" }; } catch { return { speed: 0, dir: "none" }; } });
  const [bag, setBag] = useState(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [recenterTrig, setRecenterTrig] = useState(0);
  const [shot, setShot] = useState(null);
  const [shotResult, setShotResult] = useState(null);
  const [showClubPick, setShowClubPick] = useState(false);
  const elevReqRef = useRef({ ball: null, target: null });
  const devMode = localStorage.getItem("sg_dev") === "1";

  const hole = course?.holes?.[holeIdx] || null;

  useEffect(() => {
    cachedGet("/bag", "bag").then(setBag).catch(() => {});
    const cid = activeRound?.courseId || localStorage.getItem("sg_quick_course");
    if (cid) {
      cachedGet(`/courses/${cid}`, `course_${cid}`).then(setCourse).catch(() => {});
    } else {
      cachedGet("/courses", "courses").then((cs) => cs[0] && setCourse(cs[0])).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Default ball: GPS, else tee
  useEffect(() => {
    if (ballSource === "gps" && gpsPos) setBall(gpsPos);
  }, [gpsPos, ballSource]);
  useEffect(() => {
    if (!ball && !gpsPos && hole?.tee) { setBall(hole.tee); setBallSource("manual"); }
  }, [hole, ball, gpsPos]);

  // Default target: green center on hole change
  useEffect(() => {
    if (hole?.greenCenter) { setTarget(hole.greenCenter); setTargetLabel("CENTER"); }
  }, [holeIdx, course]); // eslint-disable-line react-hooks/exhaustive-deps

  const distM = useMemo(() => haversineMeters(ball, target), [ball, target]);
  const fcb = useMemo(() => {
    if (!ball || !hole) return null;
    return {
      front: haversineMeters(ball, hole.greenFront),
      center: haversineMeters(ball, hole.greenCenter),
      back: haversineMeters(ball, hole.greenBack),
    };
  }, [ball, hole]);

  // Elevation - throttled
  useEffect(() => {
    if (!ball || !target) return;
    const r = elevReqRef.current;
    if (!movedMoreThan(r.ball, ball, 5) && !movedMoreThan(r.target, target, 5)) return;
    const t = setTimeout(() => {
      elevReqRef.current = { ball, target };
      api.get(`/elevation?lat1=${ball.lat}&lng1=${ball.lng}&lat2=${target.lat}&lng2=${target.lng}`)
        .then((res) => setElev(res.data))
        .catch(() => setElev({ available: false }));
    }, 1200);
    return () => clearTimeout(t);
  }, [ball, target]);

  const pl = useMemo(() => computePlaysLike({
    actualMeters: distM,
    elevDiffM: elev?.available ? elev.diff : 0,
    windSpeedKmh: settings.windUnit === "mph" ? wind.speed * 1.609 : wind.speed,
    windDir: wind.dir,
    toggles: settings,
    tournamentMode: settings.tournamentMode,
  }), [distM, elev, wind, settings]);

  const rec = useMemo(() => (settings.tournamentMode ? null : recommendClub(pl?.playsLikeMeters, bag?.clubs)), [pl, bag, settings.tournamentMode]);

  // Caddie context snapshot
  useEffect(() => {
    if (distM == null) return;
    const ctx = {
      hole: hole?.holeNumber, par: hole?.par,
      actualDistanceYards: fmtDist(distM, "yd"),
      playsLikeYards: pl ? fmtDist(pl.playsLikeMeters, "yd") : null,
      elevationMeters: elev?.available ? elev.diff : null,
      windSpeedKmh: wind.dir === "none" ? 0 : wind.speed,
      windRelationship: wind.dir,
      frontGreenYards: fcb?.front != null ? fmtDist(fcb.front, "yd") : null,
      centerGreenYards: fcb?.center != null ? fmtDist(fcb.center, "yd") : null,
      backGreenYards: fcb?.back != null ? fmtDist(fcb.back, "yd") : null,
      recommendedClub: rec?.club?.name || null,
      clubCarryYards: rec?.club?.carry || null,
      hazards: (hole?.hazards || []).map((h) => ({ name: h.name, type: h.type, frontYards: ball ? fmtDist(haversineMeters(ball, h), "yd") : null, carryYards: ball && h.carryLat ? fmtDist(haversineMeters(ball, { lat: h.carryLat, lng: h.carryLng }), "yd") : null })),
    };
    localStorage.setItem("sg_caddie_ctx", JSON.stringify(ctx));
  }, [distM, pl, rec, elev, wind, fcb, hole, ball]);

  const onMapClick = useCallback((p) => {
    if (setBallMode) {
      setBall({ lat: p.lat, lng: p.lng });
      setBallSource("manual");
      setSetBallMode(false);
      toast.success("Ball position set manually");
    } else {
      setTarget({ lat: p.lat, lng: p.lng });
      setTargetLabel(p.hazard ? p.hazard.name.toUpperCase() : "CUSTOM");
    }
  }, [setBallMode]);

  const changeHole = (delta) => {
    if (!course) return;
    const next = Math.max(0, Math.min(course.holes.length - 1, holeIdx + delta));
    setHoleIdx(next);
    if (activeRound) {
      const upd = { ...activeRound, currentHole: next + 1 };
      setActiveRound(upd);
      api.put(`/rounds/${activeRound.id}`, { currentHole: next + 1 }).catch(() => {});
    }
  };

  const startShot = (club) => {
    if (!ball) { toast.error("No ball position yet"); return; }
    setShot({ start: ball, club, targetDist: distM, playsLike: pl?.playsLikeMeters });
    setShowClubPick(false);
    toast.success(`Shot started with ${club}. Walk to your ball, then tap BALL FOUND.`);
  };

  const endShot = () => {
    const end = ballSource === "gps" && gpsPos ? gpsPos : ball;
    const d = haversineMeters(shot.start, end);
    setShotResult({ ...shot, end, distance: d, fairway: null, direction: null });
    setShot(null);
  };

  const saveShot = async (extra) => {
    const s = { ...shotResult, ...extra };
    try {
      await api.post("/shots", {
        roundId: activeRound?.id || null, holeNumber: hole?.holeNumber || null, club: s.club,
        startLat: s.start.lat, startLng: s.start.lng, endLat: s.end.lat, endLng: s.end.lng,
        targetDistanceMeters: s.targetDist, playsLikeMeters: s.playsLike,
        fairway: s.fairway, direction: s.direction,
      });
      toast.success(`Shot recorded: ${s.club} · ${fmtDist(s.distance, unit)} ${unitLabel(unit)}`);
    } catch { toast.error("Could not save shot (offline?)"); }
    setShotResult(null);
  };

  const center = ball || gpsPos || (hole?.tee) || { lat: course?.latitude || DEFAULT_CENTER.lat, lng: course?.longitude || DEFAULT_CENTER.lng };
  const targetCards = hole ? [
    ["CENTER", hole.greenCenter], ["FRONT", hole.greenFront], ["BACK", hole.greenBack],
    ...((hole.hazards || []).map((h) => [h.type, { lat: h.lat, lng: h.lng }, h.name])),
  ].filter((t) => t[1]) : [];

  return (
    <div className="fixed inset-0 bg-[#0F0F10]" data-testid="rangefinder-screen">
      <div className="absolute inset-0 bottom-[64px]">
        <MapView
          center={center} mapType={mapType} onMapClick={onMapClick}
          ball={ball} gpsPos={gpsPos} target={target}
          onTargetDrag={(p) => { setTarget(p); setTargetLabel("CUSTOM"); }}
          tee={hole?.tee} greens={hole} hazards={hole?.hazards || []}
          distLabel={distM != null ? `${fmtDist(distM, unit)} ${unitLabel(unit).toLowerCase()}` : null}
          recenterTrigger={recenterTrig}
        />
      </div>

      {/* Top bar */}
      <div className="absolute top-0 left-0 right-0 z-[1100] flex items-center gap-2 p-3">
        <button data-testid="rf-home-btn" onClick={() => nav("/")} className="h-11 w-11 rounded-xl bg-white shadow-lg flex items-center justify-center border border-zinc-300">
          <House size={20} weight="bold" />
        </button>
        {course && (
          <div className="flex items-center bg-white rounded-xl shadow-lg border border-zinc-300 h-11">
            <button data-testid="rf-prev-hole-btn" onClick={() => changeHole(-1)} className="px-2 h-full"><CaretLeft size={18} weight="bold" /></button>
            <div className="text-center px-1 min-w-[86px]">
              <p className="text-[13px] font-extrabold leading-tight" data-testid="rf-hole-label">HOLE {hole?.holeNumber}</p>
              <p className="text-[10px] text-zinc-500 font-bold leading-tight">PAR {hole?.par}{hole?.handicap ? ` · HCP ${hole.handicap}` : ""}</p>
            </div>
            <button data-testid="rf-next-hole-btn" onClick={() => changeHole(1)} className="px-2 h-full"><CaretRight size={18} weight="bold" /></button>
          </div>
        )}
        <div className="ml-auto flex flex-col items-end gap-1.5">
          <div data-testid="gps-accuracy-badge" className={`px-2.5 py-1 rounded-full text-[10px] font-extrabold tracking-wider shadow-lg ${
            gpsError ? "bg-red-500 text-white" : quality === "GOOD" ? "bg-[#22C55E] text-[#0F0F10]" : quality === "FAIR" ? "bg-[#D4AF37] text-[#0F0F10]" : quality === "POOR" ? "bg-red-500 text-white" : "bg-zinc-700 text-white"
          }`}>
            {gpsError === "denied" ? "GPS DENIED" : gpsError ? "NO GPS" : accuracy != null ? `GPS ±${accuracy.toFixed(0)}m ${quality}` : "GPS…"}
          </div>
          {settings.tournamentMode && <div className="px-2.5 py-1 rounded-full text-[10px] font-extrabold bg-[#0F0F10] text-[#D4AF37] border border-[#D4AF37]" data-testid="tournament-badge">TOURNAMENT</div>}
        </div>
      </div>

      {/* Big distance card */}
      <div className="absolute top-[64px] left-3 z-[1050] bg-white rounded-2xl shadow-xl border border-zinc-300 px-4 py-2.5 min-w-[128px]" data-testid="distance-card">
        <p className="overline-label text-zinc-500">{targetLabel} · ACTUAL</p>
        <p className="font-num text-5xl leading-none mt-0.5" data-testid="target-distance-value">{fmtDist(distM, unit)}</p>
        <p className="overline-label text-[#14532D]">{unitLabel(unit)}</p>
        {!settings.tournamentMode && pl && distM != null && (
          <div className="mt-1.5 pt-1.5 border-t border-zinc-200">
            <p className="overline-label text-zinc-400">PLAYS LIKE*</p>
            <p className="font-num text-2xl leading-none text-[#14532D]" data-testid="plays-like-value">{fmtDist(pl.playsLikeMeters, unit)}</p>
          </div>
        )}
        {elev?.available && elev.diff != null && !settings.tournamentMode && (
          <p className="text-[10px] font-bold text-zinc-500 mt-1" data-testid="elevation-value">
            {elev.diff >= 0 ? "+" : ""}{elev.diff} m {elev.diff >= 0 ? "UPHILL" : "DOWNHILL"}
          </p>
        )}
      </div>

      {/* Right controls */}
      <div className="absolute right-3 top-[64px] z-[1050] flex flex-col gap-2">
        <button data-testid="map-type-btn" onClick={() => setMapType((m) => (m === "satellite" ? "hybrid" : m === "hybrid" ? "map" : "satellite"))}
          className="h-11 w-11 rounded-xl bg-white shadow-lg border border-zinc-300 flex items-center justify-center"><Stack size={20} /></button>
        <button data-testid="recenter-btn" onClick={() => setRecenterTrig((t) => t + 1)}
          className="h-11 w-11 rounded-xl bg-white shadow-lg border border-zinc-300 flex items-center justify-center"><Crosshair size={20} /></button>
      </div>

      {/* GPS denied helper */}
      {gpsError && !ball && (
        <div className="absolute top-1/3 left-6 right-6 z-[1100] bg-white rounded-2xl p-5 shadow-xl text-center" data-testid="gps-error-card">
          <p className="font-bold text-sm">Location access is needed for Live GPS Rangefinder.</p>
          <div className="flex gap-2 mt-4">
            <button data-testid="gps-retry-btn" onClick={() => window.location.reload()} className="flex-1 h-12 rounded-xl bg-[#14532D] text-white font-bold text-sm">TRY AGAIN</button>
            <button data-testid="gps-manual-btn" onClick={() => { setSetBallMode(true); }} className="flex-1 h-12 rounded-xl bg-zinc-100 font-bold text-sm">SET BALL MANUALLY</button>
          </div>
        </div>
      )}

      {setBallMode && (
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 z-[1100] bg-[#0F0F10] text-white px-4 py-2 rounded-full text-xs font-bold shadow-xl" data-testid="set-ball-hint">
          TAP THE MAP TO PLACE YOUR BALL
        </div>
      )}

      {/* Bottom panel */}
      <div className="absolute bottom-[64px] left-0 right-0 z-[1050]">
        {sheetOpen && (
          <div className="bg-white rounded-t-3xl border-t-2 border-[#D4AF37] shadow-2xl px-4 pt-3 pb-2 max-h-[46vh] overflow-y-auto" data-testid="bottom-sheet">
            {/* Target cards */}
            {targetCards.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-2">
                {targetCards.map(([label, p, name], i) => (
                  <button key={i} data-testid={`target-card-${i}`}
                    onClick={() => { setTarget({ lat: p.lat, lng: p.lng }); setTargetLabel((name || label).toUpperCase()); }}
                    className="shrink-0 px-3 py-2 rounded-xl bg-zinc-100 border border-zinc-200 text-left">
                    <p className="text-[9px] font-extrabold tracking-widest text-zinc-500">{name || label}</p>
                    <p className="font-num text-lg leading-none">{ball && p ? fmtDist(haversineMeters(ball, p), unit) : "--"}</p>
                  </button>
                ))}
              </div>
            )}
            {/* Hazards with carry */}
            {(hole?.hazards || []).length > 0 && (
              <div className="space-y-1.5 py-2 border-t border-zinc-100">
                <p className="overline-label text-zinc-400">HAZARDS</p>
                {hole.hazards.map((h) => (
                  <button key={h.id} data-testid={`hazard-row-${h.id}`} onClick={() => { setTarget({ lat: h.lat, lng: h.lng }); setTargetLabel(h.name.toUpperCase()); }}
                    className="w-full flex items-center justify-between bg-zinc-50 rounded-xl px-3 py-2">
                    <span className="text-xs font-extrabold">{h.name} <span className="text-zinc-400 font-bold">({h.type})</span></span>
                    <span className="text-xs font-bold">
                      Front {ball ? fmtDist(haversineMeters(ball, h), unit) : "--"}
                      {h.carryLat != null && ball && <span className="text-[#14532D]"> · Carry {fmtDist(haversineMeters(ball, { lat: h.carryLat, lng: h.carryLng }), unit)}</span>}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {/* Wind */}
            {!settings.tournamentMode && (
              <div className="py-2 border-t border-zinc-100">
                <p className="overline-label text-zinc-400 flex items-center gap-1"><Wind size={12} /> WIND ({settings.windUnit === "kmh" ? "km/h" : "mph"})</p>
                <div className="flex items-center gap-2 mt-1.5">
                  <input data-testid="wind-speed-input" type="number" min="0" value={wind.speed}
                    onChange={(e) => { const w = { ...wind, speed: Number(e.target.value) }; setWind(w); localStorage.setItem("sg_wind", JSON.stringify(w)); }}
                    className="w-16 h-10 rounded-lg border border-zinc-300 text-center font-bold" />
                  <div className="flex gap-1 overflow-x-auto">
                    {WIND_DIRS.map(([k, l]) => (
                      <button key={k} data-testid={`wind-dir-${k}`} onClick={() => { const w = { ...wind, dir: k }; setWind(w); localStorage.setItem("sg_wind", JSON.stringify(w)); }}
                        className={`shrink-0 px-2.5 h-10 rounded-lg text-[10px] font-extrabold ${wind.dir === k ? "bg-[#14532D] text-white" : "bg-zinc-100 text-zinc-600"}`}>{l}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {/* Plays-like breakdown */}
            {!settings.tournamentMode && pl && distM != null && (
              <div className="py-2 border-t border-zinc-100 grid grid-cols-4 gap-1 text-center" data-testid="plays-like-breakdown">
                {[["ACTUAL", pl.actualMeters], ["ELEV", pl.elevationAdj, true], ["WIND", pl.windAdj, true], ["EST. PLAYS", pl.playsLikeMeters]].map(([l, v, signed]) => (
                  <div key={l} className="bg-zinc-50 rounded-lg py-1.5">
                    <p className="text-[8px] font-extrabold tracking-widest text-zinc-400">{l}</p>
                    <p className="text-sm font-num">{signed ? (v >= 0 ? "+" : "") : ""}{fmtDist(v, unit)}</p>
                  </div>
                ))}
              </div>
            )}
            {devMode && (
              <div className="py-2 border-t border-zinc-100 text-[10px] font-mono text-zinc-500" data-testid="dev-panel">
                <p>ball: {ball ? `${ball.lat.toFixed(6)}, ${ball.lng.toFixed(6)} (${ballSource})` : "--"}</p>
                <p>target: {target ? `${target.lat.toFixed(6)}, ${target.lng.toFixed(6)}` : "--"}</p>
                <p>raw: {distM?.toFixed(2)} m · yd: {distM ? (distM * 1.0936133).toFixed(2) : "--"} · brg: {ball && target ? bearingDeg(ball, target).toFixed(1) : "--"}°</p>
                <p>gps acc: ±{accuracy?.toFixed(1)}m · elev: {JSON.stringify(elev)}</p>
              </div>
            )}
          </div>
        )}
        {/* Action bar */}
        <div className="bg-[#0F0F10] px-3 py-2 flex items-center gap-2">
          <button data-testid="sheet-toggle-btn" onClick={() => setSheetOpen((o) => !o)} className="h-12 w-10 rounded-xl bg-white/10 text-white flex items-center justify-center">
            {sheetOpen ? <CaretDown size={18} /> : <CaretUp size={18} />}
          </button>
          <button data-testid="set-ball-here-btn" onClick={() => setSetBallMode((m) => !m)}
            className={`flex-1 h-12 rounded-xl text-[11px] font-extrabold tracking-wider ${setBallMode ? "bg-[#D4AF37] text-[#0F0F10]" : "bg-white/10 text-white"}`}>
            SET BALL ON MAP
          </button>
          <button data-testid="use-my-location-btn" onClick={() => { if (gpsPos) { setBall(gpsPos); setBallSource("gps"); setRecenterTrig((t) => t + 1); toast.success("Using live GPS position"); } else toast.error("GPS not available"); }}
            className="h-12 px-3 rounded-xl bg-white/10 text-white flex items-center justify-center"><GpsFix size={20} /></button>
          {shot ? (
            <button data-testid="end-shot-btn" onClick={endShot} className="flex-1 h-12 rounded-xl bg-[#D4AF37] text-[#0F0F10] text-[11px] font-extrabold tracking-wider animate-pulse">
              BALL FOUND · END SHOT
            </button>
          ) : (
            <button data-testid="track-shot-btn" onClick={() => setShowClubPick(true)} className="flex-1 h-12 rounded-xl bg-[#14532D] text-white text-[11px] font-extrabold tracking-wider">
              TRACK SHOT
            </button>
          )}
        </div>
        {/* Club recommendation strip */}
        {!settings.tournamentMode && rec && (
          <div className="bg-[#14532D] px-4 py-1.5 flex items-center justify-between" data-testid="club-rec-strip">
            <p className="text-[10px] font-extrabold tracking-widest text-white/70">SMART CADDIE</p>
            <p className="text-sm font-extrabold text-white">{rec.club.name.toUpperCase()} <span className="text-[#D4AF37]">· {Math.round(rec.club.carry)} yd · {rec.confidence}</span></p>
          </div>
        )}
      </div>

      {/* Club picker */}
      {showClubPick && (
        <div className="fixed inset-0 z-[2000] bg-black/70 flex items-end" onClick={() => setShowClubPick(false)}>
          <div className="bg-white rounded-t-3xl w-full p-5 max-h-[60vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} data-testid="club-picker">
            <p className="overline-label text-zinc-400 mb-3">START SHOT · SELECT CLUB</p>
            <div className="grid grid-cols-3 gap-2">
              {(bag?.clubs || []).filter((c) => c.name !== "Putter").map((c) => (
                <button key={c.id} data-testid={`pick-club-${c.name.replace(/\s/g, "-").toLowerCase()}`} onClick={() => startShot(c.name)}
                  className={`h-16 rounded-xl border font-bold text-xs ${rec?.club?.name === c.name ? "border-[#14532D] bg-[#14532D]/10" : "border-zinc-200 bg-zinc-50"}`}>
                  {c.name}<br /><span className="text-zinc-400">{Math.round(c.carry)} yd</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Shot result */}
      {shotResult && (
        <div className="fixed inset-0 z-[2000] bg-black/70 flex items-end">
          <div className="bg-white rounded-t-3xl w-full p-6" data-testid="shot-result-dialog">
            <p className="overline-label text-zinc-400">SHOT RECORDED</p>
            <p className="font-head text-2xl font-extrabold mt-1">{shotResult.club}</p>
            <p className="font-num text-6xl text-[#14532D]">{fmtDist(shotResult.distance, unit)} <span className="text-2xl">{unitLabel(unit)}</span></p>
            <p className="overline-label text-zinc-400 mt-4">FAIRWAY HIT?</p>
            <div className="flex gap-2 mt-1.5">
              {[["YES", true], ["NO", false]].map(([l, v]) => (
                <button key={l} data-testid={`shot-fairway-${l.toLowerCase()}`} onClick={() => setShotResult((s) => ({ ...s, fairway: v }))}
                  className={`flex-1 h-12 rounded-xl font-bold text-sm ${shotResult.fairway === v ? "bg-[#14532D] text-white" : "bg-zinc-100"}`}>{l}</button>
              ))}
            </div>
            <p className="overline-label text-zinc-400 mt-3">DIRECTION</p>
            <div className="flex gap-2 mt-1.5">
              {["LEFT", "CENTER", "RIGHT"].map((d) => (
                <button key={d} data-testid={`shot-dir-${d.toLowerCase()}`} onClick={() => setShotResult((s) => ({ ...s, direction: d }))}
                  className={`flex-1 h-12 rounded-xl font-bold text-sm ${shotResult.direction === d ? "bg-[#14532D] text-white" : "bg-zinc-100"}`}>{d}</button>
              ))}
            </div>
            <button data-testid="save-shot-btn" onClick={() => saveShot({})} className="w-full h-14 mt-5 rounded-2xl bg-[#14532D] text-white font-extrabold tracking-widest">SAVE SHOT</button>
            <button data-testid="discard-shot-btn" onClick={() => setShotResult(null)} className="w-full mt-2 text-sm text-zinc-400 font-semibold">Discard</button>
          </div>
        </div>
      )}
    </div>
  );
}
