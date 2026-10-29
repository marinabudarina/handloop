import { useEffect, useRef, useState, useCallback } from "react";
import type { Results, NormalizedLandmarkList } from "@mediapipe/hands";
import CircularGallery from "./CircularGallery";

const BASE_IMAGES = [
  "/gallery/gallery-01.png?v=3",
  "/gallery/gallery-02.png?v=3",
  "/gallery/gallery-03.png?v=3",
  "/gallery/gallery-04.png?v=3",
  "/gallery/gallery-05.png?v=3",
];

const EXTRA_POOL = [
  "/gallery/gallery-06.png?v=3",
  "/gallery/gallery-07.png?v=3",
  "/gallery/gallery-08.png?v=3",
  "/gallery/gallery-09.png?v=3",
  "/gallery/gallery-10.png?v=3",
];

function dist2d(a: { x: number; y: number }, b: { x: number; y: number }) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2);
}

const PINCH_CLOSE = 0.065;
const MAX_OPEN = 0.28;

function isAllFingersOpen(lm: NormalizedLandmarkList): boolean {
  const pairs = [[8,6],[12,10],[16,14],[20,18]] as const;
  for (const [tip, pip] of pairs) {
    if (lm[tip].y >= lm[pip].y) return false;
  }
  return lm[4].y < lm[2].y; // thumb extended
}

// Figma design base dimensions (1440×900)
const DESIGN_W = 1440;
const DESIGN_H = 900;

// Layout from Figma node 1492:459 — group (1280×780) centered in design canvas
const GROUP_W = 1280;
const GROUP_H = 780;
const GROUP_LEFT = Math.round((DESIGN_W - GROUP_W) / 2); // = 80
const GROUP_TOP  = Math.round((DESIGN_H - GROUP_H) / 2); // = 60

// Browser frame (1487:11281): fills the group at (0,0)
const BROWSER_W = 952;
const BROWSER_LEFT = GROUP_LEFT;
const BROWSER_TOP  = GROUP_TOP;
const BROWSER_TOOLBAR_H  = 34;
const BROWSER_H    = 780; // total frame height from Figma
const BROWSER_CONTENT_H  = BROWSER_H - BROWSER_TOOLBAR_H; // = 746

// Camera frame (1487:11290): relative (773, 358) within group
const CAM_LEFT = GROUP_LEFT + 773; // = 853
const CAM_TOP  = GROUP_TOP  + 358; // = 418
const CAM_W = 507;
const CAM_H = 338;
const CAM_TITLEBAR_H = 18;

export default function HandTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const animFrameRef = useRef<number | null>(null);

  const [extraImages, setExtraImages] = useState<string[]>([]);
  const [loopSpeed, setLoopSpeed] = useState(0);
  const [loopRadius, setLoopRadius] = useState(150);
  const [bothOpen, setBothOpen] = useState(false);
  const [gridMode, setGridMode] = useState(false);
  const [webcamReady, setWebcamReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(1);

  const extraImagesRef = useRef<string[]>([]);
  useEffect(() => { extraImagesRef.current = extraImages; }, [extraImages]);

  const extraPoolIndexRef = useRef(0);
  const seqRef = useRef(0);

  const leftPinchingRef = useRef(false);
  const rightPinchingRef = useRef(false);

  const leftPresentRef = useRef(false);
  const rightPresentRef = useRef(false);
  const leftDistRef = useRef(0);
  const rightDistRef = useRef(0);
  const leftAllOpenRef = useRef(false);
  const rightAllOpenRef = useRef(false);

  // Preload all gallery images so they never flash white on first appear
  useEffect(() => {
    [...BASE_IMAGES, ...EXTRA_POOL].forEach((src) => {
      const img = new window.Image();
      img.src = src;
    });
  }, []);

  // Scale design canvas to fit viewport
  useEffect(() => {
    const update = () => {
      const s = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H);
      setScale(s);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  const addExtras = useCallback(() => {
    const seq = ++seqRef.current;
    let added = 0;
    const step = () => {
      if (seqRef.current !== seq) return;
      if (added >= 5) return;
      const idx = extraPoolIndexRef.current % EXTRA_POOL.length;
      extraPoolIndexRef.current++;
      added++;
      setExtraImages((prev) => [...prev, EXTRA_POOL[idx]]);
      if (added < 5) setTimeout(step, 250);
    };
    step();
  }, []);

  const removeExtras = useCallback(() => {
    const seq = ++seqRef.current;
    const count = extraImagesRef.current.length;
    if (count === 0) return;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        if (seqRef.current !== seq) return;
        setExtraImages((prev) => {
          if (prev.length === 0) return prev;
          return prev.slice(0, -1);
        });
      }, i * 250);
    }
  }, []);

  const onResultsRef = useRef<((results: Results) => void) | null>(null);

  onResultsRef.current = (results: Results) => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    if (!results.multiHandLandmarks?.length) {
      leftPinchingRef.current = false;
      rightPinchingRef.current = false;
      leftPresentRef.current = false;
      rightPresentRef.current = false;
      leftAllOpenRef.current = false;
      rightAllOpenRef.current = false;
      setLoopSpeed(0);
      setLoopRadius(150);
      setBothOpen(false);
      setGridMode(false);
      return;
    }

    leftPresentRef.current = false;
    rightPresentRef.current = false;

    const leftHandPresent = results.multiHandLandmarks.some(
      (_, i) => results.multiHandedness?.[i]?.label === "Left"
    );
    if (!leftHandPresent) {
      leftPinchingRef.current = false;
      leftDistRef.current = 0;
      leftAllOpenRef.current = false;
      setLoopSpeed(0);
      setLoopRadius(150);
    }

    results.multiHandLandmarks.forEach((landmarks: NormalizedLandmarkList, index: number) => {
      const handedness = results.multiHandedness?.[index]?.label as "Left" | "Right" | undefined;
      if (!handedness || !landmarks) return;

      const thumb = landmarks[4];
      const indexFinger = landmarks[8];
      if (!thumb || !indexFinger) return;

      const d = dist2d(thumb, indexFinger);
      const isPinching = d < PINCH_CLOSE;

      const W = canvas.width;
      const H = canvas.height;
      const thumbX = (1 - thumb.x) * W;
      const thumbY = thumb.y * H;
      const idxX = (1 - indexFinger.x) * W;
      const idxY = indexFinger.y * H;

      ctx.save();
      ctx.beginPath();
      ctx.moveTo(thumbX, thumbY);
      ctx.lineTo(idxX, idxY);
      ctx.strokeStyle = isPinching ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.4)";
      ctx.lineWidth = isPinching ? 3 : 1.5;
      ctx.stroke();

      [[thumbX, thumbY], [idxX, idxY]].forEach(([cx, cy]) => {
        ctx.beginPath();
        ctx.arc(cx, cy, isPinching ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = isPinching ? "rgba(255,255,255,0.9)" : "rgba(255,255,255,0.55)";
        ctx.fill();
      });

      const midX = (thumbX + idxX) / 2;
      const midY = (thumbY + idxY) / 2;
      const label = handedness === "Right" ? "add images" : "loop speed";
      ctx.font = "bold 13px Inter, system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillStyle = "rgba(255,255,255,0.9)";
      ctx.fillText(label, midX, midY - 12);
      ctx.restore();

      if (handedness === "Right") {
        rightPresentRef.current = true;
        rightDistRef.current = d;
        rightAllOpenRef.current = isAllFingersOpen(landmarks);
        const wasPinching = rightPinchingRef.current;
        rightPinchingRef.current = isPinching;
        if (!isPinching && wasPinching) addExtras();
        else if (isPinching && !wasPinching) removeExtras();
      } else {
        leftPresentRef.current = true;
        leftDistRef.current = d;
        leftAllOpenRef.current = isAllFingersOpen(landmarks);
        leftPinchingRef.current = isPinching;
        const normalized = Math.max(0, Math.min(1, (d - PINCH_CLOSE) / (MAX_OPEN - PINCH_CLOSE)));
        setLoopSpeed(normalized * 2.5);
        setLoopRadius(150 + normalized * 140);
      }
    });

    const gridModeNow = leftAllOpenRef.current && rightAllOpenRef.current;
    setGridMode(gridModeNow);

    const bothOpenNow =
      !gridModeNow &&
      leftPresentRef.current &&
      rightPresentRef.current &&
      leftDistRef.current > PINCH_CLOSE &&
      rightDistRef.current > PINCH_CLOSE;
    setBothOpen(bothOpenNow);
  };

  useEffect(() => {
    let cancelled = false;
    let handsInstance: { send: (opts: { image: HTMLVideoElement }) => Promise<void>; close: () => void } | null = null;

    async function setup() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { width: 640, height: 480, facingMode: "user" },
          audio: false,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        streamRef.current = stream;

        const video = videoRef.current;
        if (!video) return;
        video.srcObject = stream;
        await new Promise<void>((resolve) => {
          video.onloadedmetadata = () => { video.play().then(resolve); };
        });

        if (cancelled) return;
        setWebcamReady(true);

        const { Hands } = await import("@mediapipe/hands");
        const hands = new Hands({
          locateFile: (file: string) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/${file}`,
        });
        handsInstance = hands;
        hands.setOptions({
          maxNumHands: 2,
          modelComplexity: 1,
          minDetectionConfidence: 0.7,
          minTrackingConfidence: 0.5,
        });
        hands.onResults((results: Results) => {
          if (onResultsRef.current) onResultsRef.current(results);
        });

        const detect = async () => {
          if (cancelled) return;
          const vid = videoRef.current;
          if (vid && vid.readyState >= 2 && !vid.paused) {
            try { await hands.send({ image: vid }); } catch {}
          }
          animFrameRef.current = requestAnimationFrame(detect);
        };
        animFrameRef.current = requestAnimationFrame(detect);
      } catch {
        if (!cancelled) setError("Camera not available. Please allow webcam access and reload.");
      }
    }

    setup();
    return () => {
      cancelled = true;
      if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current);
      try { handsInstance?.close(); } catch {}
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const allImages = [...BASE_IMAGES, ...extraImages];

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", overflow: "hidden", background: "#0d0d0d" }}>

      {/* Desktop background — fills 100vw × 100vh regardless of design scale */}
      <img
        src="/desktop-bg.jpg"
        alt=""
        style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover", pointerEvents: "none", zIndex: 0 }}
      />

      {/* Design canvas scaled to fit viewport */}
      <div style={{
        position: "absolute",
        width: DESIGN_W,
        height: DESIGN_H,
        left: "50%",
        top: "50%",
        transform: `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: "center center",
        zIndex: 1,
      }}>

        {/* ── Browser chrome frame (gallery) ───────────────────── */}
        <div style={{
          position: "absolute",
          left: BROWSER_LEFT,
          top: BROWSER_TOP,
          width: BROWSER_W,
          height: BROWSER_TOOLBAR_H + BROWSER_CONTENT_H,
          borderRadius: 12,
          overflow: "hidden",
          boxShadow: "0 8px 60px rgba(0,0,0,0.18)",
        }}>
          {/* Browser toolbar */}
          <div style={{
            height: BROWSER_TOOLBAR_H,
            background: "white",
            display: "flex",
            alignItems: "center",
            padding: "0 13px",
            flexShrink: 0,
            borderBottom: "1px solid rgba(0,0,0,0.06)",
          }}>
            <div style={{ display: "flex", gap: 5.5, alignItems: "center" }}>
              <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#FF5F57" }} />
              <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#FFBD2E" }} />
              <div style={{ width: 11, height: 11, borderRadius: "50%", background: "#28C840" }} />
            </div>
            <div style={{ flex: 1, display: "flex", justifyContent: "center" }}>
              <div style={{
                background: "#F4F4F5",
                border: "0.7px solid rgba(0,0,0,0.08)",
                borderRadius: 6,
                height: 19,
                width: 341,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 5,
                fontSize: 8.6,
                color: "#1b1b1b",
                fontFamily: "Inter, system-ui, sans-serif",
              }}>
                <span style={{ opacity: 0.5, fontSize: 8 }}>🔒</span>
                budarina.design
              </div>
            </div>
          </div>

          {/* Gallery content area */}
          <div style={{
            height: BROWSER_CONTENT_H,
            background: "#e9e9e9",
            position: "relative",
            overflow: "hidden",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}>
            <CircularGallery
              images={allImages}
              baseCount={BASE_IMAGES.length}
              loopSpeed={loopSpeed}
              loopRadius={loopRadius}
              bothOpen={bothOpen}
              gridMode={gridMode}
            />
            <div style={{
              position: "absolute", top: 16, left: 0, right: 0,
              display: "flex", justifyContent: "center", pointerEvents: "none",
            }}>
              <span style={{ color: "rgba(0,0,0,0.2)", fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", fontFamily: "Inter, system-ui, sans-serif" }}>
                {allImages.length} images
              </span>
            </div>
          </div>
        </div>

        {/* ── Camera frame (webcam) ─────────────────────────────── */}
        <div style={{
          position: "absolute",
          left: CAM_LEFT,
          top: CAM_TOP,
          width: CAM_W,
          height: CAM_H,
          background: "white",
          borderRadius: 12,
          boxShadow: "0 0 48px rgba(0,0,0,0.12)",
          overflow: "hidden",
        }}>
          {/* Camera title bar */}
          <div style={{
            height: CAM_TITLEBAR_H,
            background: "white",
            display: "flex",
            alignItems: "center",
            padding: "0 10px",
            flexShrink: 0,
            borderBottom: "1px solid rgba(0,0,0,0.06)",
          }}>
            <div style={{ display: "flex", gap: 4.5 }}>
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#FF5F57" }} />
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#FFBD2E" }} />
              <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#28C840" }} />
            </div>
          </div>

          {/* Webcam area */}
          <div style={{ position: "relative", height: CAM_H - CAM_TITLEBAR_H, background: "#b3b3b3", overflow: "hidden" }}>
            {!webcamReady && !error && (
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, zIndex: 10 }}>
                <div style={{ width: 26, height: 26, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.2)", borderTopColor: "rgba(255,255,255,0.75)", animation: "spin 1s linear infinite" }} />
                <p style={{ color: "rgba(255,255,255,0.55)", fontSize: 10, letterSpacing: "0.2em", textTransform: "uppercase", margin: 0, fontFamily: "Inter, system-ui, sans-serif" }}>Requesting camera</p>
              </div>
            )}
            {error && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", zIndex: 10, padding: "0 20px" }}>
                <p style={{ color: "rgba(255,255,255,0.75)", fontSize: 11, textAlign: "center", lineHeight: 1.6, margin: 0, fontFamily: "Inter, system-ui, sans-serif" }}>{error}</p>
              </div>
            )}

            <video
              ref={videoRef}
              style={{
                position: "absolute", inset: 0,
                width: "100%", height: "100%",
                objectFit: "cover",
                transform: "scaleX(-1)",
                opacity: webcamReady ? 1 : 0,
                transition: "opacity 0.8s ease",
              }}
              muted playsInline
            />
            <canvas
              ref={canvasRef}
              style={{
                position: "absolute", inset: 0,
                width: "100%", height: "100%",
                pointerEvents: "none",
              }}
            />

            {/* Gesture legend */}
            <div style={{
              position: "absolute", bottom: 12, left: 0, right: 0,
              display: "flex", justifyContent: "center", gap: 18,
              pointerEvents: "none",
            }}>
              {[
                { hand: "left hand", action: "loop speed" },
                { hand: "both open", action: "expand" },
                { hand: "right hand", action: "add images" },
                { hand: "all fingers", action: "grid mode" },
              ].map((item, i, arr) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 18 }}>
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
                    <span style={{ color: "rgba(255,255,255,0.35)", fontSize: 8.5, letterSpacing: "0.14em", textTransform: "uppercase", fontFamily: "Inter, system-ui, sans-serif" }}>{item.hand}</span>
                    <span style={{ color: "rgba(255,255,255,0.7)", fontSize: 10, fontFamily: "Inter, system-ui, sans-serif" }}>{item.action}</span>
                  </div>
                  {i < arr.length - 1 && (
                    <div style={{ width: 1, height: 26, background: "rgba(255,255,255,0.12)" }} />
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
