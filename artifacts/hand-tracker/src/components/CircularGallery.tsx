import { useEffect, useRef, useState } from "react";

interface Props {
  images: string[];
  baseCount: number;
  loopSpeed: number;
  loopRadius: number;
  bothOpen: boolean;
  gridMode: boolean;
}

interface ImageState {
  src: string;
  id: number;
  exiting: boolean;
}

let idCounter = 0;

function easeOutCubic(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

// Browser content area dimensions (matches Figma layout constants)
const CONTENT_W = 952;
const CONTENT_H = 746;
const GRID_PAD = 28;
const GRID_GAP = 14;

interface GridPos { x: number; y: number; size: number; }

function computeGridPositions(n: number): GridPos[] {
  if (n === 0) return [];
  const availW = CONTENT_W - GRID_PAD * 2;
  const availH = CONTENT_H - GRID_PAD * 2;
  const cols = Math.max(1, Math.ceil(Math.sqrt(n * availW / availH)));
  const rows = Math.ceil(n / cols);
  const cellW = (availW - (cols - 1) * GRID_GAP) / cols;
  const cellH = (availH - (rows - 1) * GRID_GAP) / rows;
  const size = Math.min(cellW, cellH);
  const gridW = cols * size + (cols - 1) * GRID_GAP;
  const gridH = rows * size + (rows - 1) * GRID_GAP;
  const startX = -gridW / 2 + size / 2;
  const startY = -gridH / 2 + size / 2;
  return Array.from({ length: n }, (_, i) => ({
    x: startX + (i % cols) * (size + GRID_GAP),
    y: startY + Math.floor(i / cols) * (size + GRID_GAP),
    size,
  }));
}

export default function CircularGallery({ images, loopSpeed, loopRadius, bothOpen, gridMode }: Props) {
  const [imageStates, setImageStates] = useState<ImageState[]>(() =>
    images.map((src) => ({ src, id: idCounter++, exiting: false }))
  );
  const prevImagesRef = useRef<string[]>(images);

  // ── Global physics refs ──────────────────────────────────────────────────
  const angleRef = useRef(0);
  const currentSpeedRef = useRef(0);
  const currentRadiusRef = useRef(150);
  const currentExpandRef = useRef(1.0);
  const targetSpeedRef = useRef(0);
  const targetRadiusRef = useRef(150);
  const targetExpandRef = useRef(1.0);

  // ── Grid progress ref (0 = orbit, 1 = grid) ──────────────────────────────
  const gridProgressRef = useRef(0);
  const gridModeRef = useRef(false);

  // ── Per-image refs ───────────────────────────────────────────────────────
  const imageAnglesRef = useRef<Map<number, number>>(new Map());
  const entryProgressRef = useRef<Map<number, number>>(new Map());
  const exitProgressRef = useRef<Map<number, number>>(new Map());

  // Live states exposed to rAF loop without stale closure
  const liveStatesRef = useRef<ImageState[]>([]);

  // Update targets from props on every render
  gridModeRef.current = gridMode;
  targetSpeedRef.current = gridMode ? 0 : (bothOpen ? 0.9 : loopSpeed);
  targetRadiusRef.current = gridMode ? loopRadius : (bothOpen ? 290 : loopRadius);
  targetExpandRef.current = gridMode ? 1 : (bothOpen ? 1.1 : 1.0);

  const animRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  // ── Sync images → imageStates ────────────────────────────────────────────
  useEffect(() => {
    const prev = prevImagesRef.current;
    const prevLen = prev.length;
    const nextLen = images.length;

    if (nextLen > prevLen) {
      const newItems: ImageState[] = images.slice(prevLen).map((src) => ({
        src,
        id: idCounter++,
        exiting: false,
      }));
      newItems.forEach((item) => entryProgressRef.current.set(item.id, 0));
      setImageStates((s) => [...s, ...newItems]);
    } else if (nextLen < prevLen) {
      const removedCount = prevLen - nextLen;
      setImageStates((s) => {
        const liveItems = s.filter((x) => !x.exiting);
        const toExit = liveItems.slice(liveItems.length - removedCount);
        const exitIds = new Set(toExit.map((x) => x.id));

        exitIds.forEach((id) => {
          exitProgressRef.current.set(id, 0);
          setTimeout(() => {
            setImageStates((cur) => cur.filter((x) => x.id !== id));
            imageAnglesRef.current.delete(id);
            entryProgressRef.current.delete(id);
            exitProgressRef.current.delete(id);
          }, 380);
        });

        return s.map((x) => (exitIds.has(x.id) ? { ...x, exiting: true } : x));
      });
    }

    prevImagesRef.current = images;
  }, [images]);

  // ── Single persistent rAF loop ───────────────────────────────────────────
  useEffect(() => {
    let last = performance.now();

    const step = (now: number) => {
      const dt = Math.min(now - last, 50);
      last = now;

      // Global physics lerps
      const speedDiff = targetSpeedRef.current - currentSpeedRef.current;
      currentSpeedRef.current += speedDiff * (speedDiff > 0 ? 5 : 3) * (dt / 1000);
      if (Math.abs(currentSpeedRef.current) < 0.002) currentSpeedRef.current = 0;
      currentRadiusRef.current += (targetRadiusRef.current - currentRadiusRef.current) * 4 * (dt / 1000);
      currentExpandRef.current += (targetExpandRef.current - currentExpandRef.current) * 4 * (dt / 1000);

      // Grid progress lerp (speed 5 → smooth ~200ms)
      const gTarget = gridModeRef.current ? 1 : 0;
      gridProgressRef.current += (gTarget - gridProgressRef.current) * 5 * (dt / 1000);
      if (Math.abs(gridProgressRef.current - gTarget) < 0.001) gridProgressRef.current = gTarget;

      // Advance global angle — scale down rotation as grid takes over
      const orbitFactor = 1 - gridProgressRef.current;
      angleRef.current += currentSpeedRef.current * (dt / 1000) * orbitFactor;
      if (angleRef.current > Math.PI * 2) angleRef.current -= Math.PI * 2;

      // Per-image: lerp static angles + advance entry progress
      const lives = liveStatesRef.current;
      const total = lives.length;
      lives.forEach((img, slotIndex) => {
        const targetAngle = (slotIndex / Math.max(total, 1)) * Math.PI * 2 - Math.PI / 2;
        const current = imageAnglesRef.current.get(img.id) ?? targetAngle;

        let diff = targetAngle - current;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        imageAnglesRef.current.set(img.id, current + diff * 6 * (dt / 1000));

        if (!img.exiting) {
          const ep = entryProgressRef.current.get(img.id) ?? 1;
          if (ep < 1) entryProgressRef.current.set(img.id, Math.min(1, ep + dt / 380));
        }
      });

      // Advance exit progress for exiting images (320ms)
      exitProgressRef.current.forEach((prog, id) => {
        if (prog < 1) exitProgressRef.current.set(id, Math.min(1, prog + dt / 320));
      });

      setTick((t) => t + 1);
      animRef.current = requestAnimationFrame(step);
    };

    animRef.current = requestAnimationFrame(step);
    return () => { if (animRef.current) cancelAnimationFrame(animRef.current); };
  }, []);

  // ── Derived render values ─────────────────────────────────────────────────
  const speed = currentSpeedRef.current;
  const radius = currentRadiusRef.current;
  const expandScale = currentExpandRef.current;
  const isSpinning = speed > 0.05;
  const gp = gridProgressRef.current;

  const imgSize = 78 + ((radius - 150) / 140) * 22;

  const liveStates = imageStates.filter((x) => !x.exiting);
  liveStatesRef.current = liveStates;
  const totalForLayout = liveStates.length;
  const liveIdToIndex = new Map(liveStates.map((x, i) => [x.id, i]));

  const gridPositions = computeGridPositions(liveStates.length);

  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: 660,
        height: 660,
      }}
    >
      {imageStates.map((img) => {
        const isExiting = img.exiting;

        if (!imageAnglesRef.current.has(img.id)) {
          const liveIdx = liveIdToIndex.get(img.id) ?? 0;
          const initAngle = (liveIdx / Math.max(totalForLayout, 1)) * Math.PI * 2 - Math.PI / 2;
          imageAnglesRef.current.set(img.id, initAngle);
        }

        const staticAngle = imageAnglesRef.current.get(img.id)!;
        const angle = angleRef.current + staticAngle;

        // Orbit position
        const orbitX = Math.cos(angle) * radius;
        const orbitY = Math.sin(angle) * radius;

        // Grid position (for this live image's slot)
        const liveIdx = liveIdToIndex.get(img.id) ?? 0;
        const gpos = gridPositions[liveIdx] ?? { x: 0, y: 0, size: imgSize };

        // Blend between orbit and grid
        const finalX = isExiting ? orbitX : orbitX * (1 - gp) + gpos.x * gp;
        const finalY = isExiting ? orbitY : orbitY * (1 - gp) + gpos.y * gp;
        const finalSize = isExiting ? imgSize : imgSize * (1 - gp) + gpos.size * gp;

        const depth = (Math.sin(angle) + 1) / 2;
        const speedNorm = Math.min(Math.abs(speed) / 0.5, 1) * (1 - gp);
        const depthScale = 1 + speedNorm * 0.25 * depth;
        const entryProg = entryProgressRef.current.get(img.id) ?? 1;
        const exitProg  = exitProgressRef.current.get(img.id)  ?? 0;
        const shadowAlpha = 0.22 + speedNorm * (0.18 + 0.14 * (1 - depth) - 0.22);
        const shadowBlur  = Math.round(24 + speedNorm * 4);
        const rawShadow = `0 ${Math.round(4 + speedNorm * 2)}px ${shadowBlur}px rgba(0,0,0,${shadowAlpha.toFixed(2)})`;
        const shadow = entryProg > 0.5 ? rawShadow : "none";

        const zIndex = gp > 0.5
          ? liveIdx + 1
          : isSpinning ? Math.round(depth * 100) : isExiting ? 0 : 10;

        const baseScale = depthScale * (expandScale * (1 - gp) + gp);
        const finalScale = isExiting
          ? baseScale * (1 - exitProg * 0.45)
          : baseScale * easeOutCubic(entryProg);
        const opacity = isExiting ? 1 - exitProg : 1;

        return (
          <div
            key={img.id}
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              width: finalSize,
              height: finalSize,
              transform: `translate(-50%, -50%) translate(${finalX}px, ${finalY}px) scale(${finalScale})`,
              opacity,
              zIndex,
              willChange: "transform, opacity",
            }}
          >
            <img
              src={img.src}
              alt=""
              draggable={false}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
                borderRadius: "17.5%",
                boxShadow: shadow,
              }}
            />
          </div>
        );
      })}

      {liveStates.length > 0 && gp < 0.5 && (
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: isSpinning ? 8 : 5,
            height: isSpinning ? 8 : 5,
            borderRadius: "50%",
            background: isSpinning ? "rgba(0,0,0,0.18)" : "rgba(0,0,0,0.1)",
            transition: "all 0.5s ease",
            opacity: 1 - gp * 2,
          }}
        />
      )}
    </div>
  );
}
