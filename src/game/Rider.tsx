import { useEffect, useRef } from "react";
import { useEditor, toDomPrecision } from "tldraw";
import {
  bodyCenter,
  bodyVelocity,
  bodyAngle,
  type ContactEvent,
} from "./physics";
import { SnailArt, SNAIL_CENTER_OFFSET } from "./SnailArt";
import {
  makeSegmentsComputed,
  makeCheckpointsComputed,
  type TrackSegment,
} from "./geometry";
import { RunController, type TrackSource } from "./runController";
import { RiderAudio } from "./riderAudio";
import { drawDebug } from "./debugOverlay";
import {
  playingAtom,
  followAtom,
  startPointAtom,
  statsAtom,
  scoreAtom,
  resetNonceAtom,
  mutedAtom,
  showCollisionsAtom,
} from "./state";

const FIXED_DT = 1 / 120; // physics substep (s)
const STATS_EVERY = 4; // throttle React stat updates to every Nth frame

// Fraction of the gap to the sled the camera closes each frame while following.
// Low enough to glide smoothly, high enough to keep a fast sled on screen.
const CAMERA_FOLLOW_LERP = 0.12;

// Past this rotation from upright (degrees) the snail is "flipped" and we draw
// just its shell (head/eye/mouth would poke through the line). 90° = the snail's
// up-vector has crossed the horizon; a small hysteresis band avoids flicker when
// it settles right at the threshold (see the swap below).
const FLIP_DEG = 90;
const FLIP_HYSTERESIS = 8;

// The snail's head leads the direction of HORIZONTAL travel; bodyFacing mirrors
// the art on the sign of the runner's horizontal velocity. A small dead-band on
// that speed (page px/s) keeps a near-stationary snail from strobing its facing
// as the velocity jitters around zero.
const FACING_FLIP_SPEED = 8;

// Start-marker ring radius, in the snail's page-space units. The snail art is
// SNAIL_LEN (64) long centered on the spawn point, so half-extent ~32; this sits
// a bit outside that so the ring encircles the whole snail with breathing room.
// The rAF loop scales the marker by camera zoom so it tracks the snail's size.
const START_RING_R = 44;

// The spawn point is the rig center, but the snail's visual mass sits a touch
// above it, so a ring centered exactly on the spawn point reads as if the snail
// floats high inside it. Nudge the ring's center DOWN (page units, +y = down) so
// the snail sits a little lower within the ring — visually centered.
const START_RING_CY = -8;

// The sled overlay. Rendered via components.InFrontOfTheCanvas. A single rAF
// loop runs continuously: while playing it advances the physics; in all states
// it positions the sled by recomputing editor.pageToViewport() each frame, so
// the sled stays glued to the canvas under pan / zoom / resize without any
// per-frame React re-render (we write the SVG geometry imperatively).
//
// Gameplay state flows through tldraw atoms (defined in App), not props: the
// loop reads playing/follow/start cold via .get() each frame and writes
// stats/score back. This lets the parent keep its `components` object stable, so
// toggling follow or play never remounts this component (which would reset the
// rAF loop and snap the sled to the start mid-ride).
//
// The lifecycle (run/reset/snapshot/scoring) lives in RunController, the audio
// contact-diffing in RiderAudio, and the debug drawing in debugOverlay — this
// component owns only the rAF orchestration plus the DOM-coupled snail transform
// and camera follow.
//
// (The old art<->physics drift guard that lived here is gone: PHYSICS.bodyRadius
// is now DERIVED from the snail art's SNAIL_HALF_HEIGHT in physics.ts, so the two
// can't disagree and there's nothing to warn about.)

export function Rider() {
  const editor = useEditor();
  const snailRef = useRef<SVGGElement | null>(null);
  const snailFullRef = useRef<SVGGElement | null>(null);
  const snailShellRef = useRef<SVGGElement | null>(null);
  const startRef = useRef<SVGGElement | null>(null);
  const debugRef = useRef<SVGGElement | null>(null);
  const debugSegsRef = useRef<SVGGElement | null>(null);
  const debugVertsRef = useRef<SVGGElement | null>(null);
  const debugRigRef = useRef<SVGGElement | null>(null);

  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    let frameCount = 0;

    // Reactive views of the track, bound to this editor: `.get()` recomputes
    // only when the page's shapes change (tldraw memoizes by dependency), so the
    // debug overlay can read live geometry every frame cheaply, and the gameplay
    // snapshot is just a `.get()` at run start. Wrapped as a TrackSource so the
    // (pure) RunController never imports tldraw.
    const trackSegments = makeSegmentsComputed(editor);
    const trackCheckpoints = makeCheckpointsComputed(editor);
    const track: TrackSource = {
      segments: () => trackSegments.get(),
      checkpoints: () => trackCheckpoints.get(),
    };

    const readInputs = () => ({
      playing: playingAtom.get(),
      start: startPointAtom.get(),
      resetNonce: resetNonceAtom.get(),
    });

    const run = new RunController(track, readInputs());
    const audio = new RiderAudio(mutedAtom.get());

    // One reused contacts buffer keeps the 120 Hz substep loop allocation-free.
    const contacts: ContactEvent[] = [];

    // Whether the snail is currently drawn shell-only (flipped). Tracked across
    // frames so the swap can use hysteresis and only touch the DOM on a change.
    let shellOnly = false;
    // Whether the debug overlay group is currently shown; only touch the DOM on
    // a change.
    let debugWasOn = false;

    const tick = (now: number) => {
      const inputs = readInputs();

      // Reconcile lifecycle: re-seat on start/reset change, snapshot on play edge.
      const { reseated, runStarted } = run.sync(inputs);
      if (reseated) statsAtom.set({ distance: 0, speed: 0 });
      if (runStarted) {
        scoreAtom.set({ collected: 0, total: run.currentCheckpoints.length });
        statsAtom.set({ distance: 0, speed: 0 });
        audio.beginRun();
        last = now;
        acc = 0;
        frameCount = 0; // restart stats cadence so the first run frame samples predictably
      }

      audio.setMuted(mutedAtom.get());

      const isPlaying = inputs.playing;
      if (isPlaying) {
        let frame = (now - last) / 1000;
        last = now;
        if (frame > 0.05) frame = 0.05; // avoid spiral-of-death after tab blur
        acc += frame;
        let scored = false;
        audio.beginFrame();
        while (acc >= FIXED_DT) {
          const res = run.stepFixed(FIXED_DT, contacts);
          audio.onSubstep(res.contacts);
          if (res.scored) scored = true;
          acc -= FIXED_DT;
        }
        if (scored)
          scoreAtom.set({
            collected: run.collectedCount,
            total: run.currentCheckpoints.length,
          });
        // Drive the sustained ride voices from this frame's aggregated contacts
        // (empty when airborne -> voices fade out).
        audio.endFrame();
        if (++frameCount % STATS_EVERY === 0) {
          const c = bodyCenter(run.currentBody);
          const d = Math.hypot(c.x - inputs.start.x, c.y - inputs.start.y);
          const v = bodyVelocity(run.currentBody, FIXED_DT);
          statsAtom.set({ distance: d, speed: Math.hypot(v.x, v.y) });
        }

        // Camera follow: ease the viewport center toward the sled so a fast
        // ride stays on screen. Lerping (not snapping) avoids a jarring lock,
        // and skipping when already close avoids fighting a settled sled with
        // sub-pixel camera nudges. history:'ignore' keeps it off the undo
        // stack; the camera move must not be an undoable edit.
        if (followAtom.get()) {
          const center = editor.getViewportPageBounds().center;
          const c = bodyCenter(run.currentBody);
          const dx = c.x - center.x;
          const dy = c.y - center.y;
          if (Math.hypot(dx, dy) > 1) {
            const target = {
              x: center.x + dx * CAMERA_FOLLOW_LERP,
              y: center.y + dy * CAMERA_FOLLOW_LERP,
            };
            editor.run(() => editor.centerOnPoint(target), {
              history: "ignore",
            });
          }
        }
      } else {
        last = now; // keep timebase fresh while paused
        audio.stop(); // silence sustained voices; re-arm impacts for the next run
      }

      // Position the sled. pageToViewport reads live camera + screenBounds and
      // returns coords relative to the editor container — which is exactly the
      // frame our overlay lives in (InFrontOfTheCanvas, positioned inset:0 in
      // that container). pageToScreen would return window-relative coords and
      // drift by the container's screen offset whenever the editor isn't flush
      // to the window. Correct under pan/zoom/resize in every state.
      // Start marker: a crosshair pinned to the spawn point in page space, so
      // the player can see where the sled will drop from. Hidden during a run
      // (the sled itself shows where you are).
      const startG = startRef.current;
      if (startG) {
        if (isPlaying) {
          startG.setAttribute("opacity", "0");
        } else {
          const s = editor.pageToViewport(inputs.start);
          const zoom = editor.getZoomLevel();
          startG.setAttribute("opacity", "1");
          startG.setAttribute(
            "transform",
            `translate(${toDomPrecision(s.x)},${toDomPrecision(s.y)}) scale(${toDomPrecision(zoom)})`,
          );
        }
      }

      // Position + orient the snail. We pivot about the body's CENTER (the
      // centroid of all rig points) so the snail rotates about its middle, not
      // its base — important when it tumbles after a crash. The art is authored
      // belly-centered (see SnailArt), so to center the WHOLE graphic on the rig
      // center (which is where the start marker sits at spawn) we push the art
      // down by SNAIL_CENTER_OFFSET — the belly-to-visual-center distance — so the
      // snail's middle lands on the placement point rather than its belly.
      // Transform order: translate to the body center (in viewport coords) →
      // rotate by the runner's facing angle → scale by camera zoom → translate the
      // art down so its visual center sits at the origin. Computing the center and
      // angle in PAGE space and mapping only the translation through pageToViewport
      // keeps the rotation correct (page→viewport is a uniform scale + translate,
      // so it preserves angles); the zoom is applied as an explicit scale here.
      const snail = snailRef.current;
      if (snail) {
        const body = run.currentBody;
        const center = editor.pageToViewport(bodyCenter(body));
        const angle = bodyAngle(body);
        const angleDeg = (angle * 180) / Math.PI;
        const zoom = editor.getZoomLevel();

        // Mirror the art so its head leads the direction of HORIZONTAL travel.
        // The controller flips on the sign of the runner's horizontal velocity
        // (mast excluded — its upright-spring wobble would otherwise flip the
        // facing at low speed), corrected for the runner's 180° ambiguity so a
        // tumble that lands FRONT-on-the-left still faces travel rather than
        // latching backward. It holds the last value inside a dead-band so a
        // slow/stationary snail doesn't flicker, and holds while crashed.
        const facingX = run.updateFacing(FIXED_DT, FACING_FLIP_SPEED);

        snail.setAttribute(
          "transform",
          `translate(${toDomPrecision(center.x)},${toDomPrecision(center.y)}) rotate(${toDomPrecision(angleDeg)}) scale(${toDomPrecision(facingX * zoom)},${toDomPrecision(zoom)}) translate(0,${toDomPrecision(SNAIL_CENTER_OFFSET)})`,
        );
        // Flash a warmer tint while crashed so a wipeout reads at a glance.
        snail.setAttribute("opacity", body.crashed ? "0.85" : "1");

        // How far the snail has rotated from upright (deg, 0..180). The art faces
        // +x with -y as up; rotating by angleDeg, the tilt from upright is just
        // angleDeg reduced to [-180,180] and made positive — 0 = upright, 180 =
        // upside-down. The horizontal facing flip (scale x by -1) mirrors
        // left/right only and leaves "up" unchanged, so tilt reads off angleDeg
        // regardless of which way the snail faces. Past FLIP_DEG the head/eye/
        // mouth dip below the shell and would clip the line, so we show the shell
        // alone. Hysteresis: once flipped, stay flipped until it recovers past
        // FLIP_DEG-band (and vice versa) so a snail resting near the threshold
        // doesn't strobe.
        const tiltDeg = Math.abs(
          ((((angleDeg + 180) % 360) + 360) % 360) - 180,
        );
        const nextShellOnly = shellOnly
          ? tiltDeg > FLIP_DEG - FLIP_HYSTERESIS
          : tiltDeg > FLIP_DEG;
        if (nextShellOnly !== shellOnly) {
          shellOnly = nextShellOnly;
          if (snailFullRef.current)
            snailFullRef.current.style.display = shellOnly ? "none" : "";
          if (snailShellRef.current)
            snailShellRef.current.style.display = shellOnly ? "" : "none";
        }
      }

      // Collision debug overlay. Draw the segments the sim collides against
      // and the sled rig's per-point contact circles, all mapped to viewport
      // coords (same frame as the sled). Hidden — and untouched — when off.
      const debugG = debugRef.current;
      const segsG = debugSegsRef.current;
      const vertsG = debugVertsRef.current;
      const rigG = debugRigRef.current;
      if (debugG && segsG && vertsG && rigG) {
        const showDebug = showCollisionsAtom.get();
        if (!showDebug) {
          if (debugWasOn) {
            debugG.setAttribute("display", "none");
            debugWasOn = false;
          }
        } else {
          if (!debugWasOn) {
            debugG.removeAttribute("display");
            debugWasOn = true;
          }
          // While playing, mirror the sim's frozen snapshot; while stopped, read
          // the reactive view so edits to the track show up live. `.get()` only
          // recomputes when shapes actually change, so this is cheap per frame.
          const debugSegs: TrackSegment[] = isPlaying
            ? run.currentSegments
            : trackSegments.get();
          drawDebug(
            { segs: segsG, verts: vertsG, rig: rigG },
            debugSegs,
            run.currentBody,
            editor,
          );
        }
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      audio.dispose();
    };
  }, [editor]);

  // Full-viewport SVG overlay; the rAF loop writes the snail group's transform in
  // screen space each frame. Static appearance lives in App.css (.lr-snail / the
  // start marker .lr-start-*).
  return (
    <svg className="lr-sled-svg" aria-hidden="true">
      {/* Collision debug overlay (Show Collisions button). The rAF loop fills the
			    three child groups in viewport coords: kind-colored segment highlights,
			    vertex dots, and the sled-rig contact circles. Drawn first so the snail
			    sits on top; the wrapper is hidden via display:none when off. */}
      <g ref={debugRef} display="none">
        <g ref={debugSegsRef} />
        <g ref={debugVertsRef} />
        <g ref={debugRigRef} />
      </g>
      {/* Start marker: a dotted ring sized just larger than the snail, encircling
			    the spawn point so the player can see (and aim) where the sled will drop
			    from. Centered on its own origin so the rAF loop only has to translate +
			    scale the group (scale tracks camera zoom — see START_RING_R). */}
      <g ref={startRef} className="lr-start-marker" opacity="0">
        <circle className="lr-start-ring" r={START_RING_R} cy={START_RING_CY} />
      </g>
      {/* The snail. The rAF loop sets this group's transform (position/rotation/
			    zoom); SnailArt draws the character in a belly-centered, +x-facing local
			    frame. We render BOTH the full snail and a shell-only variant and let the
			    loop toggle which is shown: when the snail rotates past ~90° (upside-down)
			    its head/eye/mouth would poke through the line, so we show just the
			    rounded shell — the part the collision radius keeps off the line. */}
      <g ref={snailRef} className="lr-snail">
        <g ref={snailFullRef}>
          <SnailArt />
        </g>
        <g ref={snailShellRef} style={{ display: "none" }}>
          <SnailArt shellOnly />
        </g>
      </g>
    </svg>
  );
}
