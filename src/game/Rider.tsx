import { useEffect, useRef } from 'react'
import { useEditor, toDomPrecision, type Editor } from 'tldraw'
import {
	makeBody,
	stepBody,
	bodyCenter,
	bodyVelocity,
	bodyAngle,
	bodyFacing,
	PHYSICS,
	type Body,
	type ContactEvent,
	type LineKind,
} from './physics'
import { SnailArt, SNAIL_CENTER_OFFSET, SNAIL_HALF_HEIGHT } from './SnailArt'
import { makeSegmentsComputed, makeCheckpointsComputed, type TrackSegment } from './geometry'
import { collectCheckpointHits, type Checkpoint } from './checkpoints'
import { createAudioEngine } from './audio'
import { playingAtom, followAtom, startPointAtom, statsAtom, scoreAtom, resetNonceAtom, mutedAtom, showCollisionsAtom } from './state'

const FIXED_DT = 1 / 120 // physics substep (s)
const STATS_EVERY = 4 // throttle React stat updates to every Nth frame

// Fraction of the gap to the sled the camera closes each frame while following.
// Low enough to glide smoothly, high enough to keep a fast sled on screen.
const CAMERA_FOLLOW_LERP = 0.12

// Past this rotation from upright (degrees) the snail is "flipped" and we draw
// just its shell (head/eye/mouth would poke through the line). 90° = the snail's
// up-vector has crossed the horizon; a small hysteresis band avoids flicker when
// it settles right at the threshold (see the swap below).
const FLIP_DEG = 90
const FLIP_HYSTERESIS = 8

// The snail's head leads the direction of HORIZONTAL travel; bodyFacing mirrors
// the art on the sign of the runner's horizontal velocity. A small dead-band on
// that speed (page px/s) keeps a near-stationary snail from strobing its facing
// as the velocity jitters around zero.
const FACING_FLIP_SPEED = 8

// Debug overlay (Show Collisions): the stroke color used to draw each kind's
// collision segments, roughly matching its draw-color legend so the overlay reads
// against the track. The rig's contact circles use a separate accent below.
// Typed Record<LineKind, …> (not Record<string, …>) so adding a new LineKind
// without a debug color is a compile error — see CLAUDE.md's "Adding a line
// behavior" checklist.
const DEBUG_KIND_COLOR: Record<LineKind, string> = {
	solid: '#1d1d1d',
	accelerate: '#e03131',
	brake: '#f76707',
	bounce: '#ffc034',
	sticky: '#ae3ec9',
	ice: '#4dabf7',
	oneway: '#4263eb',
	scenery: '#2f9e44',
}
const DEBUG_SEGMENT_COLOR = '#1d1d1d'
const DEBUG_RIG_COLOR = '#ff1493' // hot pink so the rig circles pop off the track

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
// The sled is a sled rig (see makeBody): a runner base (BACK<->FRONT) that rides
// the track plus a mast held upright by a spring, so the snail tracks the slope
// like classic Line Rider rather than tumbling — until a hard hit trips its
// crash state and it ragdolls. We draw the snail character (SnailArt) in a group
// placed at the runner midpoint, rotated by the runner angle, scaled by zoom.
const SVG_NS = 'http://www.w3.org/2000/svg'

// Art<->physics drift guard. PHYSICS.bodyRadius is hand-tuned to land the rig's
// collision surface on the snail's DRAWN belly (see the comment on bodyRadius in
// physics.ts): the runner line sits ~sledMast/3 below the rig center, and the
// belly is SNAIL_HALF_HEIGHT below center, so the radius that reaches the belly
// is ~SNAIL_HALF_HEIGHT - sledMast/3. That ties a pure-physics constant to the
// TSX art module by hand. Rider is the only place that imports both, so we
// verify the relationship here: if SnailArt's SNAIL_LEN ever changes (which
// drives SNAIL_HALF_HEIGHT), this warns instead of silently letting the snail
// sink through or float above the track. Generous tolerance — it's a sanity
// check on gross drift, not the exact tuning.
if (import.meta.env?.DEV) {
	const expected = SNAIL_HALF_HEIGHT - PHYSICS.sledMast / 3
	if (Math.abs(expected - PHYSICS.bodyRadius) > 4) {
		console.warn(
			`[line-rider] PHYSICS.bodyRadius (${PHYSICS.bodyRadius}) drifted from the snail art ` +
				`(SNAIL_HALF_HEIGHT - sledMast/3 = ${expected.toFixed(2)}). ` +
				`Re-check PHYSICS.bodyRadius in physics.ts against SnailArt.`
		)
	}
}

// Reconcile `g`'s direct children to exactly `count` elements of `tag` (pool
// reusable nodes, create/trim the delta). Pooling avoids thrashing the DOM every
// frame on a busy track. Returns the live child NodeList for the caller to fill.
function poolChildren(g: SVGGElement, tag: string, count: number): NodeListOf<ChildNode> {
	while (g.childElementCount < count) g.appendChild(document.createElementNS(SVG_NS, tag))
	while (g.childElementCount > count) g.removeChild(g.lastChild as ChildNode)
	return g.childNodes
}

/**
 * Draw the collision debug overlay into `g`, imperatively (no React render in the
 * rAF loop, matching the snail draw). All geometry is computed in PAGE space and
 * mapped through pageToViewport so it tracks pan/zoom exactly like the sled.
 *
 * `g` holds three child groups, each pooling one element type so reconciliation
 * stays simple:
 *  - SEGMENT lines: one per collision segment, colored by kind. Drawn THICK and
 *    semi-transparent so they read as a highlight OVER the source stroke rather
 *    than hiding exactly under it (a pencil shape's segments trace the drawn line
 *    1:1, so a thin opaque line would be invisible — the bug this fixes).
 *  - VERTEX dots: one per segment endpoint, so you can see where the actual
 *    collision points sit along the polyline (each pencil/geo vertex).
 *  - RIG circles: one per sled-rig point at PHYSICS.bodyRadius — the real contact
 *    surface the sim uses, which is larger than the drawn snail.
 */
function drawDebug(
	groups: { segs: SVGGElement; verts: SVGGElement; rig: SVGGElement },
	segments: TrackSegment[],
	body: Body,
	editor: Editor
): void {
	const zoom = editor.getZoomLevel()

	// Segment lines: thick, semi-transparent, kind-colored highlight.
	const segEls = poolChildren(groups.segs, 'line', segments.length)
	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i]
		const a = editor.pageToViewport(seg.a)
		const b = editor.pageToViewport(seg.b)
		const el = segEls[i] as SVGElement
		el.setAttribute('x1', `${toDomPrecision(a.x)}`)
		el.setAttribute('y1', `${toDomPrecision(a.y)}`)
		el.setAttribute('x2', `${toDomPrecision(b.x)}`)
		el.setAttribute('y2', `${toDomPrecision(b.y)}`)
		el.setAttribute('stroke', DEBUG_KIND_COLOR[seg.kind] ?? DEBUG_SEGMENT_COLOR)
		el.setAttribute('stroke-width', '4')
		el.setAttribute('stroke-opacity', '0.45')
		el.setAttribute('stroke-linecap', 'round')
	}

	// Vertex dots at each segment's start, plus the very last segment's end so the
	// polyline's final point is marked too.
	const vertEls = poolChildren(groups.verts, 'circle', segments.length > 0 ? segments.length + 1 : 0)
	for (let i = 0; i < segments.length; i++) {
		const v = editor.pageToViewport(segments[i].a)
		const el = vertEls[i] as SVGElement
		el.setAttribute('cx', `${toDomPrecision(v.x)}`)
		el.setAttribute('cy', `${toDomPrecision(v.y)}`)
		el.setAttribute('r', '2')
		el.setAttribute('fill', DEBUG_KIND_COLOR[segments[i].kind] ?? DEBUG_SEGMENT_COLOR)
	}
	if (segments.length > 0) {
		const last = segments[segments.length - 1]
		const v = editor.pageToViewport(last.b)
		const el = vertEls[segments.length] as SVGElement
		el.setAttribute('cx', `${toDomPrecision(v.x)}`)
		el.setAttribute('cy', `${toDomPrecision(v.y)}`)
		el.setAttribute('r', '2')
		el.setAttribute('fill', DEBUG_KIND_COLOR[last.kind] ?? DEBUG_SEGMENT_COLOR)
	}

	// Rig contact circles at the true body radius.
	const rigEls = poolChildren(groups.rig, 'circle', body.points.length)
	for (let i = 0; i < body.points.length; i++) {
		const c = editor.pageToViewport(body.points[i].pos)
		const el = rigEls[i] as SVGElement
		el.setAttribute('cx', `${toDomPrecision(c.x)}`)
		el.setAttribute('cy', `${toDomPrecision(c.y)}`)
		el.setAttribute('r', `${toDomPrecision(PHYSICS.bodyRadius * zoom)}`)
		el.setAttribute('fill', 'none')
		el.setAttribute('stroke', DEBUG_RIG_COLOR)
		el.setAttribute('stroke-width', '1.5')
	}
}

export function Rider() {
	const editor = useEditor()
	const snailRef = useRef<SVGGElement | null>(null)
	const snailFullRef = useRef<SVGGElement | null>(null)
	const snailShellRef = useRef<SVGGElement | null>(null)
	const startRef = useRef<SVGGElement | null>(null)
	const debugRef = useRef<SVGGElement | null>(null)
	const debugSegsRef = useRef<SVGGElement | null>(null)
	const debugVertsRef = useRef<SVGGElement | null>(null)
	const debugRigRef = useRef<SVGGElement | null>(null)
	const bodyRef = useRef<Body>(makeBody(startPointAtom.get()))

	useEffect(() => {
		let raf = 0
		let last = performance.now()
		let acc = 0
		let frameCount = 0
		// Reactive views of the track, bound to this editor: `.get()` recomputes
		// only when the page's shapes change (tldraw memoizes by dependency), so the
		// debug overlay can read live geometry every frame cheaply, and the gameplay
		// snapshot is just a `.get()` at run start.
		const trackSegments = makeSegmentsComputed(editor)
		const trackCheckpoints = makeCheckpointsComputed(editor)
		// The gameplay snapshot the sim runs against: frozen at run start so a mid-run
		// edit (shouldn't happen — the track is read-only while playing — but defends
		// the invariant) can't change collision under the sled.
		let segments = trackSegments.get()
		let checkpoints: Checkpoint[] = trackCheckpoints.get()
		// Ids collected this run; reset when a run begins so flags re-arm.
		let collected = new Set<string>()

		// --- Audio -----------------------------------------------------------
		// The pure sim reports contacts into `contacts`; we sonify them here. One
		// reused array (cleared, never reallocated) keeps the 120 Hz substep loop
		// allocation-free. `prevContactKeys` is the set of (kind|shape) surfaces the
		// sled touched on the PREVIOUS substep; diffing finds NEW contacts to fire a
		// one-shot impact for. `frameContacts` aggregates the substeps' contacts so
		// the sustained ride voices read the whole frame, not just the last substep.
		const engine = createAudioEngine()
		const contacts: ContactEvent[] = []
		let prevContactKeys = new Set<string>()
		let frameContacts: ContactEvent[] = []
		let lastMuted = mutedAtom.get()
		engine.setMuted(lastMuted)
		const contactKey = (c: ContactEvent) => `${c.kind}|${c.shape ?? ''}`

		// Re-snapshot collision geometry each time a run begins.
		let wasPlaying = false
		// Whether the snail is currently drawn shell-only (flipped). Tracked across
		// frames so the swap can use hysteresis and only touch the DOM on a change.
		let shellOnly = false
		// Horizontal facing of the art: +1 as-authored, -1 mirrored. Tracked across
		// frames so we only flip when the horizontal travel speed clears the dead-band,
		// and hold otherwise. Reset to +1 with the body (see makeBody calls below).
		let facingX: 1 | -1 = 1
		// Re-seat the sled whenever the start point moves (immediate feedback even
		// while stopped) or the Reset button bumps the nonce. Track the last-seen
		// values so we only rebuild on change.
		let lastStart = startPointAtom.get()
		let lastReset = resetNonceAtom.get()

		// --- Collision debug overlay -----------------------------------------
		// When `showCollisionsAtom` is on we draw the physics' actual collision
		// geometry into `debugRef`. While stopped we read the reactive `trackSegments`
		// view (recomputes only when shapes change) so the overlay reflects track
		// edits live without re-walking the page every frame. While playing we draw
		// the same frozen `segments` the sim is running against, so the overlay
		// matches what the sled actually hits. The
		// rig circles are the body points drawn at PHYSICS.bodyRadius — the real
		// contact surface, which is larger than the visible snail. We build the DOM
		// once and mutate it; toggling off just hides the group.
		let debugWasOn = false

		const tick = (now: number) => {
			const start = startPointAtom.get()
			const reset = resetNonceAtom.get()
			if (start !== lastStart || reset !== lastReset) {
				lastStart = start
				lastReset = reset
				bodyRef.current = makeBody(start)
				facingX = 1 // fresh body spawns facing +x; don't inherit last run's facing
				// Clear last run's telemetry so the panel reads 0 after a reset.
				statsAtom.set({ distance: 0, speed: 0 })
			}

			// Mirror the mute atom into the engine on change (cheap; only on toggle).
			const muted = mutedAtom.get()
			if (muted !== lastMuted) {
				lastMuted = muted
				engine.setMuted(muted)
			}

			const isPlaying = playingAtom.get()
			if (isPlaying && !wasPlaying) {
				// Run begins: re-seat the sled at the start and re-snapshot the track.
				bodyRef.current = makeBody(start)
				facingX = 1 // fresh body spawns facing +x; don't inherit last run's facing
				segments = trackSegments.get()
				checkpoints = trackCheckpoints.get()
				collected = new Set<string>()
				scoreAtom.set({ collected: 0, total: checkpoints.length })
				statsAtom.set({ distance: 0, speed: 0 }) // clear last run's readout immediately
				// Audio: resume the context on this user-gesture-initiated run and
				// clear any stale contact state so impacts re-arm.
				engine.resume()
				prevContactKeys = new Set<string>()
				last = now
				acc = 0
				frameCount = 0 // restart stats cadence so the first run frame samples predictably
			}
			wasPlaying = isPlaying

			if (isPlaying) {
				let frame = (now - last) / 1000
				last = now
				if (frame > 0.05) frame = 0.05 // avoid spiral-of-death after tab blur
				acc += frame
				let scored = false
				frameContacts = []
				while (acc >= FIXED_DT) {
					contacts.length = 0 // reuse the buffer; sim fills it this substep
					stepBody(bodyRef.current, segments, FIXED_DT, contacts)

					// Audio: fire a one-shot for any surface newly touched this substep
					// (a key absent from the previous substep's set), then carry this
					// substep's contacts into the frame aggregate for the ride voices.
					const substepKeys = new Set<string>()
					for (const c of contacts) {
						const key = contactKey(c)
						if (!substepKeys.has(key)) {
							substepKeys.add(key)
							if (!prevContactKeys.has(key)) engine.impact(c.kind, c.shape, c.speed)
							frameContacts.push(c)
						}
					}
					prevContactKeys = substepKeys

					// Test checkpoints against the body center per substep so a fast
					// sled can't tunnel past a flag between rendered frames.
					// collectCheckpointHits mutates `collected` so each flag scores once.
					if (checkpoints.length > 0) {
						const c = bodyCenter(bodyRef.current)
						const hits = collectCheckpointHits(c, checkpoints, collected)
						if (hits.length > 0) scored = true
					}
					acc -= FIXED_DT
				}
				if (scored) scoreAtom.set({ collected: collected.size, total: checkpoints.length })
				// Drive the sustained ride voices from this frame's aggregated contacts
				// (empty when airborne -> voices fade out).
				engine.setRide(frameContacts)
				if (++frameCount % STATS_EVERY === 0) {
					const c = bodyCenter(bodyRef.current)
					const d = Math.hypot(c.x - start.x, c.y - start.y)
					const v = bodyVelocity(bodyRef.current, FIXED_DT)
					statsAtom.set({ distance: d, speed: Math.hypot(v.x, v.y) })
				}

				// Camera follow: ease the viewport center toward the sled so a fast
				// ride stays on screen. Lerping (not snapping) avoids a jarring lock,
				// and skipping when already close avoids fighting a settled sled with
				// sub-pixel camera nudges. history:'ignore' keeps it off the undo
				// stack; the camera move must not be an undoable edit.
				if (followAtom.get()) {
					const center = editor.getViewportPageBounds().center
					const c = bodyCenter(bodyRef.current)
					const dx = c.x - center.x
					const dy = c.y - center.y
					if (Math.hypot(dx, dy) > 1) {
						const target = {
							x: center.x + dx * CAMERA_FOLLOW_LERP,
							y: center.y + dy * CAMERA_FOLLOW_LERP,
						}
						editor.run(() => editor.centerOnPoint(target), { history: 'ignore' })
					}
				}
			} else {
				last = now // keep timebase fresh while paused
				// Silence sustained voices and drop contact state while stopped, so a
				// new run re-arms impacts and nothing hums when not riding.
				if (prevContactKeys.size > 0) {
					engine.setRide([])
					prevContactKeys = new Set<string>()
				}
			}

			// Position the sled. pageToViewport reads live camera + screenBounds and
			// returns coords relative to the editor container — which is exactly the
			// frame our overlay lives in (InFrontOfTheCanvas, positioned inset:0 in
			// that container). pageToScreen would return window-relative coords and
			// drift by the container's screen offset whenever the editor isn't flush
			// to the window. Correct under pan/zoom/resize in every state.
			// Start marker: a crosshair pinned to the spawn point in page space, so
			// the player can see where the sled will drop from. Hidden during a run
			// (the sled itself shows where you are). Positioned with pageToViewport
			// like the sled, so it tracks pan/zoom.
			const startG = startRef.current
			if (startG) {
				if (isPlaying) {
					startG.setAttribute('opacity', '0')
				} else {
					const s = editor.pageToViewport(start)
					startG.setAttribute('opacity', '1')
					startG.setAttribute('transform', `translate(${toDomPrecision(s.x)},${toDomPrecision(s.y)})`)
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
			const snail = snailRef.current
			if (snail) {
				const body = bodyRef.current
				const center = editor.pageToViewport(bodyCenter(body))
				const angle = bodyAngle(body)
				const angleDeg = (angle * 180) / Math.PI
				const zoom = editor.getZoomLevel()

				// Mirror the art so its head leads the direction of HORIZONTAL travel.
				// `bodyFacing` flips on the sign of the runner's horizontal velocity
				// (mast excluded — its upright-spring wobble would otherwise flip the
				// facing at low speed), corrected for the runner's 180° ambiguity so a
				// tumble that lands FRONT-on-the-left still faces travel rather than
				// latching backward. It holds the last value inside a dead-band so a
				// slow/stationary snail doesn't flicker. Don't reorient while crashed —
				// a ragdolling snail has no meaningful "forward".
				if (!body.crashed) {
					facingX = bodyFacing(body, FIXED_DT, FACING_FLIP_SPEED, facingX)
				}

				snail.setAttribute(
					'transform',
					`translate(${toDomPrecision(center.x)},${toDomPrecision(center.y)}) rotate(${toDomPrecision(angleDeg)}) scale(${toDomPrecision(facingX * zoom)},${toDomPrecision(zoom)}) translate(0,${toDomPrecision(SNAIL_CENTER_OFFSET)})`
				)
				// Flash a warmer tint while crashed so a wipeout reads at a glance.
				snail.setAttribute('opacity', body.crashed ? '0.85' : '1')

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
				const tiltDeg = Math.abs(((angleDeg + 180) % 360 + 360) % 360 - 180)
				const nextShellOnly = shellOnly ? tiltDeg > FLIP_DEG - FLIP_HYSTERESIS : tiltDeg > FLIP_DEG
				if (nextShellOnly !== shellOnly) {
					shellOnly = nextShellOnly
					if (snailFullRef.current) snailFullRef.current.style.display = shellOnly ? 'none' : ''
					if (snailShellRef.current) snailShellRef.current.style.display = shellOnly ? '' : 'none'
				}
			}

			// Collision debug overlay. Draw the segments the sim collides against
			// and the sled rig's per-point contact circles, all mapped to viewport
			// coords (same frame as the sled). Hidden — and untouched — when off.
			const debugG = debugRef.current
			const segsG = debugSegsRef.current
			const vertsG = debugVertsRef.current
			const rigG = debugRigRef.current
			if (debugG && segsG && vertsG && rigG) {
				const showDebug = showCollisionsAtom.get()
				if (!showDebug) {
					if (debugWasOn) {
						debugG.setAttribute('display', 'none')
						debugWasOn = false
					}
				} else {
					if (!debugWasOn) {
						debugG.removeAttribute('display')
						debugWasOn = true
					}
					// While playing, mirror the sim's frozen snapshot; while stopped, read
					// the reactive view so edits to the track show up live. `.get()` only
					// recomputes when shapes actually change, so this is cheap per frame.
					const debugSegs: TrackSegment[] = isPlaying ? segments : trackSegments.get()
					drawDebug({ segs: segsG, verts: vertsG, rig: rigG }, debugSegs, bodyRef.current, editor)
				}
			}

			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => {
			cancelAnimationFrame(raf)
			engine.dispose()
		}
	}, [editor])

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
			{/* Start marker: a target ring + crosshair at the spawn point, centered on
			    its own origin so the rAF loop only has to translate the group. */}
			<g ref={startRef} className="lr-start-marker" opacity="0">
				<circle className="lr-start-ring" r={12} />
				<line className="lr-start-cross" x1={-16} y1={0} x2={16} y2={0} />
				<line className="lr-start-cross" x1={0} y1={-16} x2={0} y2={16} />
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
				<g ref={snailShellRef} style={{ display: 'none' }}>
					<SnailArt shellOnly />
				</g>
			</g>
		</svg>
	)
}
