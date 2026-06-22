// Lightweight Line Rider physics: a point-mass "sled" under gravity that
// collides against a set of static line segments. Uses Verlet integration
// (position-based) which is stable and simple for this kind of sim.

export interface Vec2 {
	x: number
	y: number
}

/** The gameplay behavior of a track line. */
export type LineKind =
	| 'solid'
	| 'accelerate'
	| 'brake'
	| 'bounce'
	| 'sticky'
	| 'ice'
	| 'oneway'
	| 'scenery'

/** A line segment in world (page) space that the sled can ride on. */
export interface Segment {
	a: Vec2
	b: Vec2
	/** Gameplay behavior. Defaults to 'solid' when omitted. */
	kind?: LineKind
	/**
	 * Scales the strength of the kind's effect, 0..1. Lets "light-" color
	 * variants reuse the same kind with a weaker magnitude (e.g. light-red is
	 * accelerate at strength 0.5). Defaults to 1 when omitted.
	 */
	strength?: number
	/**
	 * Flips which side a 'oneway' line blocks. By default a one-way collides from
	 * the side its left-hand normal points to (above, for a left->right segment);
	 * `flip: true` blocks from the opposite side instead. No effect on other
	 * kinds.
	 */
	flip?: boolean
	/**
	 * The native tldraw shape type this segment came from ('draw' | 'line' |
	 * 'geo' | 'arrow'). The physics sim ignores it; it rides along only so the
	 * audio layer can vary a sound by shape type as well as kind. Optional — the
	 * unit tests omit it.
	 */
	shape?: string
}

/**
 * A surface-contact report emitted (optionally) during a step, for the audio
 * layer to sonify. The sim itself stays silent and stateless: it only pushes
 * these into a caller-supplied sink. Omitting the sink leaves behavior
 * byte-identical to a sim with no audio at all.
 */
export interface ContactEvent {
	kind: LineKind
	strength: number
	/** Source shape type of the contacted segment, if known. */
	shape?: string
	/** Sled speed at contact (px/s), for speed-scaled volume/pitch. */
	speed: number
}

/** Tunable constants. Units are page-pixels and seconds. */
export const PHYSICS = {
	gravity: 1800, // px/s^2, pulls the sled down
	friction: 0.999, // velocity retained per step along free fall
	restitution: 0.0, // 0 = no bounce off lines (classic Line Rider feel)
	// Default surface drag when riding a solid line. Line Rider lines are
	// near-frictionless, so this is tiny: 'ice' (0) still reads as slicker and
	// 'sticky' as much grippier than a plain line. It must stay small because the
	// in-game sled is a multi-point rig: this drag fires per CONTACTING point and
	// the constraint solve then spreads it across the whole rig, so a value that feels
	// gentle on the single-point step() (the unit-test path) compounds on the body
	// and can stall it dead on a flat line or cancel gravity on a gentle downhill —
	// which is what made solid/accelerate feel wrong while bounce/sticky (meant to
	// be dramatic) felt fine. See the slope probe in the fix that set this.
	surfaceFriction: 0.004,
	riderRadius: 6, // collision radius of a single sled point (the step() primitive)
	// Collision radius used for the multi-point sled BODY. The drawn snail is much
	// larger than a 6px point and is centered on the rig center, so a tiny radius
	// lets the visible art sink through lines on contact. We grow the body's contact
	// surface to reach the snail's DRAWN silhouette: it's centered on the rig center
	// with a visible half-height of ~24.97px (SnailArt.SNAIL_HALF_HEIGHT) and the
	// runner line sits sledMast/3 below center, so the radius that lands the contact
	// surface on the visible belly is ~24.97 - 14/3 ≈ 20.3. Kept in sync by hand
	// (physics stays free of the TSX art module). Only the body uses this; the
	// single-point step() keeps riderRadius, so its tests/feel are unchanged. A
	// bigger radius RAISES the tunneling threshold (2*r/FIXED_DT) so it's safe
	// against tunneling; it rounds corners a touch more, fine for a body this size.
	bodyRadius: 20,
	contactSkin: 0.75, // band beyond riderRadius still treated as "riding" the line
	maxSpeed: 4000, // clamp to avoid tunneling/explosions
	accelerateBoost: 2400, // px/s^2 tangential acceleration added along 'accelerate' lines
	// px/s; accelerate lines stop boosting past this. Kept below the tunneling
	// threshold (2*riderRadius / FIXED_DT = 4800 px/s here) so boosted sleds don't
	// shoot through thin lines in a single step.
	accelerateMaxSpeed: 1300,
	brakeDrag: 0.2, // fraction of tangential speed removed per step on 'brake' lines
	bounceRestitution: 0.85, // restitution for 'bounce' lines (springy; 0=none, 1=elastic)
	stickyFriction: 0.45, // tangential drag fraction on 'sticky' lines (strong grip)
	iceFriction: 0.0, // tangential drag on 'ice' lines (perfectly frictionless glide)

	// --- Sled rig (classic Line Rider feel) ---------------------------------
	// The body is a SLED, not a free-tumbling quad: a rigid base (two runner
	// points) plus a mast point held above the base midpoint by an upright spring.
	// The runner edge tracks the slope it rides; the mast keeps it from flipping —
	// until a hard hit trips the crash state, which kills the spring so it ragdolls.
	// Half-length of the runner base. Kept compact (close to the old quad's
	// footprint) so the rig doesn't catch a long base on convex corners — a wide
	// rigid runner snags edges a small body rolls over. Don't grow this without
	// re-checking corner snagging.
	sledRunner: 11, // half-length of the runner base (front<->back), px
	sledMast: 14, // height of the mast point above the base midpoint, px
	// Upright restoring spring: each step we rotate the mast a fraction of the way
	// back toward "above the runner, opposing gravity". 0 = no righting (free
	// tumble), 1 = snaps upright instantly. Soft enough to pivot OVER bumps/corners
	// (a stiff spring fights the pivot and jams the rig on a seam) while still
	// keeping it upright on open track and recovering after jumps.
	//
	// applyUpright is now called ONCE per step (it used to run inside all 4
	// constraint/collision iterations, so the per-step righting compounded to
	// ~1-(1-0.12)^4 ≈ 0.40). This value is raised to ~that compounded figure so the
	// single call delivers the same righting authority the rig was tuned around —
	// the old 0.12 single-call righting is far too weak (a tilted rig fails to
	// recover and tumbles). At 0.40 it still pivots cleanly over bumps and tracks
	// the slope (verified by the bump/slope probes), while recovering from tilts the
	// old 4x feel handled. Crash/ragdoll behavior is unchanged.
	uprightStiffness: 0.4,
	// Crash triggers. The sled ragdolls (upright spring off) for the rest of the
	// run once either fires:
	//  - a runner point's inbound impact speed exceeds this (px/s): slamming a wall
	crashImpactSpeed: 1700,
	//  - the body's angular speed exceeds this (rad/s): spun out / over-rotated
	crashSpin: 16,
	// ...but only after it has spun that fast for this many CONSECUTIVE substeps.
	// A hard landing snaps the runner from flat to slope-aligned in one frame (a
	// brief spin spike); requiring a streak distinguishes that transient settle
	// from a genuine tumble, so the rig doesn't "crash" just from landing.
	crashSpinFrames: 4,
	// How far past vertical (radians) the mast may tilt before it counts as
	// "tipped over" and crashes. ~75deg: rides steep ramps, crashes on a flip.
	crashTilt: 1.3,
	// Below this |cos(bodyAngle)| the runner is near-vertical and its horizontal
	// facing is degenerate (the art is nearly edge-on), so bodyFacing HOLDS rather
	// than snapping on the tiny, jittery sign of cos. ~0.1 ≈ within ~6deg of
	// vertical. The old guard used EPSILON (1e-9), which is far too tight to ever
	// suppress the flicker on a steep-but-not-exactly-vertical runner.
	facingVerticalCos: 0.1,
}

// Below this we treat a displacement as zero (avoid divide-by-zero / NaN).
const EPSILON = 1e-9

export interface RiderState {
	pos: Vec2
	prev: Vec2 // previous position; (pos - prev) encodes velocity in Verlet
}

export function makeRider(start: Vec2): RiderState {
	return {
		pos: { x: start.x, y: start.y },
		prev: { x: start.x, y: start.y },
	}
}

function sub(a: Vec2, b: Vec2): Vec2 {
	return { x: a.x - b.x, y: a.y - b.y }
}

function len(v: Vec2): number {
	return Math.hypot(v.x, v.y)
}

/**
 * Closest point on segment [a,b] to point p, plus the parametric t in [0,1].
 */
function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): { point: Vec2; t: number } {
	const abx = b.x - a.x
	const aby = b.y - a.y
	const lenSq = abx * abx + aby * aby
	if (lenSq === 0) return { point: { x: a.x, y: a.y }, t: 0 }
	let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq
	t = Math.max(0, Math.min(1, t))
	return { point: { x: a.x + abx * t, y: a.y + aby * t }, t }
}

/**
 * Detect contact between a point's THIS-STEP motion (`prev` -> `pos`) and a
 * segment, returning the contact normal (unit, pointing toward the side the
 * point came from) and how far to push the point to sit `r` off the line.
 *
 * Why swept, not just proximity: a body point moves up to `maxSpeed * dt`
 * (~33px) per substep, far more than the contact band (~7px). A pure "is the
 * end position near the line?" test misses a fast point that crossed a thin
 * line in one step (tunneling), and — worse — when the end position lands just
 * past the line, `pos - closestPoint` points to the FAR side, so the old
 * push-out ejected the point deeper through the line instead of back out (the
 * "hits the inside of the box" bug).
 *
 * Fix: pick the normal from the line itself and orient it toward wherever `prev`
 * was (the side the point came from this step). Then a contact fires when the
 * point either ends within the contact band OR its motion segment crossed the
 * line within the segment's span — and the push-out always sends it back the way
 * it came. Returns null when there's no contact this step.
 */
function sweptContact(
	state: RiderState,
	seg: Segment,
	contact: number,
	r: number
): { nx: number; ny: number; penetration: number } | null {
	// Unit perpendicular of the segment (its left-hand normal in screen coords).
	let sdx = seg.b.x - seg.a.x
	let sdy = seg.b.y - seg.a.y
	const segLen = Math.hypot(sdx, sdy)
	if (segLen < EPSILON) return null
	sdx /= segLen
	sdy /= segLen
	// Left-hand normal (sdy, -sdx): for a left->right segment this points up (-y).
	const perpX = sdy
	const perpY = -sdx

	// Signed perpendicular distance of prev/pos from the infinite line.
	const sPrev = (state.prev.x - seg.a.x) * perpX + (state.prev.y - seg.a.y) * perpY
	const sPos = (state.pos.x - seg.a.x) * perpX + (state.pos.y - seg.a.y) * perpY

	// Orient the collision normal toward the side the point came from. Use prev's
	// side when it's clearly off the line; if prev sat on the line (|sPrev| tiny),
	// fall back to pos's side so a point grazing the line still resolves outward.
	const side = Math.abs(sPrev) > EPSILON ? Math.sign(sPrev) : Math.sign(sPos) || 1
	const nx = perpX * side
	const ny = perpY * side

	// The point's signed distance along that oriented normal (positive = outside).
	const dPos = sPos * side
	const dPrev = sPrev * side

	// Is the closest point of `pos` actually within the segment's span (not off
	// its end)?
	const { point, t } = closestPointOnSegment(state.pos, seg.a, seg.b)
	const onSpan = t > 0 && t < 1
	const endDist = Math.hypot(state.pos.x - point.x, state.pos.y - point.y)

	// Off-the-end (CORNER) contact: the closest point clamped to an endpoint, so
	// this is a contact with the corner VERTEX, not the flat edge. Resolve it
	// RADIALLY — push the point out to radius `r` from the corner along
	// (pos - corner) — instead of along the edge's perpendicular normal. Using the
	// edge normal here pins a point that has slid past the end ON TOP of the corner
	// (it keeps shoving it up to the edge's height even though it's beyond the
	// edge), so a snail sliding off the end of a box top rides into the air instead
	// of rounding the corner and falling off. The radial push lets it round the
	// corner: as it moves past, the normal rotates from "up" toward "sideways/down"
	// and gravity carries it off. (On-span contacts still use the edge normal.)
	if (!onSpan) {
		if (endDist >= contact || endDist < EPSILON) return null
		const cnx = (state.pos.x - point.x) / endDist
		const cny = (state.pos.y - point.y) / endDist
		return { nx: cnx, ny: cny, penetration: Math.max(0, r - endDist) }
	}

	// On-span contact: resolve against the flat edge using its perpendicular normal.
	// Crossing test: did the motion pass from outside the band to inside/through it,
	// within the segment span? Catches a fast point that tunneled past.
	const crossed = dPrev >= r && dPos < contact
	// Resting/penetrating test: end position is within the contact band on the span.
	const resting = dPos < contact

	if (!crossed && !resting) return null
	// Push the point back to sit exactly `r` off the line on the side it came
	// from. For a crossing (dPos can be negative — it punched through) this is the
	// full depth back to the surface; for a graze it's the small overlap.
	const penetration = Math.max(0, r - dPos)
	return { nx, ny, penetration }
}

/** Verlet integration of a single point under gravity. Mutates `state`. */
function integrate(state: RiderState, dt: number): void {
	const vx = (state.pos.x - state.prev.x) * PHYSICS.friction
	const vy = (state.pos.y - state.prev.y) * PHYSICS.friction

	state.prev.x = state.pos.x
	state.prev.y = state.pos.y

	state.pos.x += vx
	state.pos.y += vy + PHYSICS.gravity * dt * dt
}

/**
 * Resolve one point against every segment: project it out of the line and
 * reflect/damp the velocity into the surface, honoring each segment's kind.
 * `applyKindEffects` gates the once-per-step velocity-changing effects
 * (accelerate / brake) so they fire on a single resolution pass, not every
 * stabilization iteration. `suppressBounce` skips per-point bounce restitution:
 * the multi-point body handles bounce at the center-of-mass level (see stepBody),
 * so letting it ALSO fire per point would double-count the impulse and gain
 * energy. The single-point step() leaves it false. Mutates `state`.
 */
function resolveCollisions(
	state: RiderState,
	segments: Segment[],
	dt: number,
	applyKindEffects: boolean,
	suppressBounce = false,
	contacts?: ContactEvent[],
	radius = PHYSICS.riderRadius
): void {
	const r = radius
	// A sled resting on a line settles at exactly dist == r. Treat a thin band
	// beyond r as still "in contact" so surface friction and kind-based effects
	// (accelerate / oneway) keep engaging while the sled rides the line, not
	// only during the brief penetration transient.
	const contact = r + PHYSICS.contactSkin
	{
		// Renamed from the old per-iteration `lastIter`: callers decide when the
		// once-per-step kind effects apply.
		const lastIter = applyKindEffects
		// Running velocity, threaded through every contacted segment and written back
		// to `prev` ONCE after the loop. Each segment removes the velocity component
		// heading INTO its surface (and applies its friction / kind effect) against
		// this running value, not the start-of-pass value.
		//
		// Why running, not summed-against-a-frozen-base: removing the inbound normal
		// component is idempotent and commutative across contacts, which gives us BOTH
		// properties we need at once:
		//  - inside corner (two DIFFERENT normals): removing the floor's normal doesn't
		//    touch the velocity along the wall's normal and vice-versa, so the result is
		//    the same regardless of order — the order-independence the old per-hit `prev`
		//    rewrite lacked (it was last-writer-wins and could leave velocity pointing
		//    into a wall).
		//  - coincident / parallel segments (the SAME normal, e.g. a stroke drawn over a
		//    line): after the first removes the inbound normal velocity, the next sees
		//    vn >= 0 and the `if (vn < 0)` guard skips it — so N overlapping lines don't
		//    each subtract another (1+e)|vn| and rocket the point off the surface.
		// Summing per-segment deltas against a frozen base did the corner right but
		// double-counted the parallel case (the bug a coincident-floor test caught).
		// Position push-out still accumulates additively on `pos` inside the loop, but
		// self-limits: sweptContact is re-evaluated per segment against the already
		// pushed-out `pos`, so a redundant parallel contact finds ~zero penetration.
		let vX = state.pos.x - state.prev.x
		let vY = state.pos.y - state.prev.y
		let anyHit = false
		for (const seg of segments) {
			// Swept detection: catches a fast point that crossed a thin line this
			// step (tunneling) and always orients the normal toward the side the
			// point came from, so the push-out never ejects it through the line.
			const hit = sweptContact(state, seg, contact, r)
			if (hit) {
				const { nx, ny, penetration } = hit

				// One-way lines only collide when the rider sits on the "front"
				// side — the half-plane the segment's left-hand normal points to.
				// For a left->right segment that normal points up (-y), so a rider
				// above the line is blocked and a rider below passes through.
				// front side <=> collision normal `n` aligns with the left-hand
				// normal of (a->b), i.e. their dot product is positive.
				if (seg.kind === 'oneway') {
					const sdx = seg.b.x - seg.a.x
					const sdy = seg.b.y - seg.a.y
					// Left-hand normal of (sdx,sdy) is (sdy,-sdx) in screen coords
					// (y points down), which evaluates to (0,-len) pointing up.
					// `flip` blocks from the opposite side instead.
					let alignFront = nx * sdy + ny * -sdx
					if (seg.flip) alignFront = -alignFront
					if (alignFront <= 0) continue
				}

				// Push the rider out along the normal. Position push-out accumulates
				// additively across segments (a corner pushes out along both normals).
				state.pos.x += nx * penetration
				state.pos.y += ny * penetration

				// Per-kind surface tuning. `strength` (0..1) scales a kind's effect
				// so "light-" color variants reuse the same kind at a weaker value.
				const strength = seg.strength ?? 1
				// Bounce lines are springy; everything else keeps the classic
				// near-zero restitution.
				const restitution =
					seg.kind === 'bounce' && !suppressBounce
						? PHYSICS.bounceRestitution * strength
						: PHYSICS.restitution
				// Tangential drag varies by surface: ice glides, sticky grips,
				// everything else uses the default near-frictionless value.
				let tangentFriction: number
				if (seg.kind === 'ice') tangentFriction = PHYSICS.iceFriction
				else if (seg.kind === 'sticky') tangentFriction = PHYSICS.stickyFriction * strength
				else tangentFriction = PHYSICS.surfaceFriction

				// Correct the RUNNING velocity in place (see the block comment above):
				// remove the inbound normal component and apply this surface's friction
				// and kind effect. Threading the running value — instead of recomputing
				// from a frozen base each segment — is what makes coincident contacts
				// idempotent while keeping orthogonal (corner) contacts order-independent.
				const vn = vX * nx + vY * ny // velocity along normal
				if (vn < 0) {
					vX -= (1 + restitution) * vn * nx
					vY -= (1 + restitution) * vn * ny
				}
				// Tangential component damping (surface friction).
				const tX = vX - (vX * nx + vY * ny) * nx
				const tY = vY - (vX * nx + vY * ny) * ny
				vX -= tX * tangentFriction
				vY -= tY * tangentFriction

				// Accelerate lines push the sled along the surface tangent, in
				// whichever tangential direction it's already moving — but stop
				// boosting past accelerateMaxSpeed so it can't run away or tunnel.
				if (seg.kind === 'accelerate' && lastIter) {
					const tLen = Math.hypot(tX, tY)
					const speed = Math.hypot(vX, vY) / dt
					if (tLen > EPSILON && speed < PHYSICS.accelerateMaxSpeed) {
						const impulse = PHYSICS.accelerateBoost * strength * dt * dt
						vX += (tX / tLen) * impulse
						vY += (tY / tLen) * impulse
					}
				}

				// Brake lines remove a fraction of the sled's tangential speed each
				// step, slowing it as it rides (the opposite of accelerate). Applied
				// once per step (final iteration) like the boost.
				if (seg.kind === 'brake' && lastIter) {
					const drag = Math.min(1, PHYSICS.brakeDrag * strength)
					vX -= tX * drag
					vY -= tY * drag
				}

				anyHit = true

				// Report the contact for the audio layer (only on the kind-effect pass,
				// so each contacted segment is reported once per step — not once per
				// stabilization iteration). `speed` is the post-resolution tangential-ish
				// speed, which reads well for a ride sound. No-op when no sink is passed.
				if (lastIter && contacts) {
					contacts.push({
						kind: seg.kind ?? 'solid',
						strength: seg.strength ?? 1,
						shape: seg.shape,
						speed: Math.hypot(vX, vY) / dt,
					})
				}
			}
		}
		// Install the corrected running velocity once. `pos` already moved by the
		// (self-limiting) push-out above; prev = pos - v sets the velocity to the
		// post-contact value.
		//
		// One deliberate divergence from the old per-hit prev-rewrite: that code read
		// the contact velocity from `pos - prev` AFTER the push-out moved `pos`, folding
		// the positional correction into the measured velocity. We thread the velocity
		// captured BEFORE the push-out instead (a push-out is a position constraint, not
		// a kinematic velocity). For restitution == 0 — every gameplay path: all
		// solid/ice/sticky/brake/accelerate lines, and ALL body points (stepBody passes
		// suppressBounce=true) — single-contact results are identical to the old code.
		// They differ only for the single-point step() hitting a bounce line
		// (restitution > 0): the new rebound is a touch stronger. That path is test-only
		// — the game bounces at the body level — and the existing bounce test asserts a
		// relative (bounce > solid) rebound, which still holds.
		if (anyHit) {
			state.prev.x = state.pos.x - vX
			state.prev.y = state.pos.y - vY
		}
	}
}

/** Clamp a point's per-step displacement so its speed never exceeds maxSpeed. */
function clampSpeed(state: RiderState, dt: number): void {
	const sx = state.pos.x - state.prev.x
	const sy = state.pos.y - state.prev.y
	const stepLen = Math.hypot(sx, sy)
	if (stepLen > EPSILON && stepLen / dt > PHYSICS.maxSpeed) {
		const scale = (PHYSICS.maxSpeed * dt) / stepLen
		state.prev.x = state.pos.x - sx * scale
		state.prev.y = state.pos.y - sy * scale
	}
}

/**
 * Advance the single-point rider by one fixed timestep. Mutates and returns
 * `state`. Integrates under gravity, then resolves collisions over a couple of
 * stabilization iterations (kind effects applied once, on the last).
 */
export function step(
	state: RiderState,
	segments: Segment[],
	dt: number,
	contacts?: ContactEvent[]
): RiderState {
	integrate(state, dt)
	const ITERATIONS = 2
	for (let iter = 0; iter < ITERATIONS; iter++) {
		const last = iter === ITERATIONS - 1
		resolveCollisions(state, segments, dt, last, false, last ? contacts : undefined)
	}
	clampSpeed(state, dt)
	return state
}

/** Current velocity (px/s) derived from Verlet positions. */
export function velocity(state: RiderState, dt: number): Vec2 {
	return {
		x: (state.pos.x - state.prev.x) / dt,
		y: (state.pos.y - state.prev.y) / dt,
	}
}

// --- Multi-point sled rig ---------------------------------------------------
// A Line Rider sled rides upright and tracks the slope, not a single point and
// not a free-tumbling box. We model it as a small set of point masses joined by
// distance constraints (a "Verlet rig"): a runner base that contacts the track
// plus a mast point held above it by an UPRIGHT SPRING (applyUpright), which is
// the righting moment that keeps it from flipping. A hard hit latches `crashed`,
// switching the spring off so the rig ragdolls. Each point collides exactly like
// the single rider above, and constraints solved between collision passes hold
// the shape together — reusing integrate()/resolveCollisions() keeps one
// collision code path, so every line behavior works on the body for free.

/** A distance constraint holding two body points at a fixed rest length. */
export interface Constraint {
	i: number // index into body.points
	j: number // index into body.points
	rest: number // target distance between the two points
	/** Stiffness 0..1: fraction of the error corrected per solve pass. */
	stiffness: number
}

/**
 * A sled body — the classic Line Rider rig. Three point masses:
 *  - points[BACK] / points[FRONT]: the two ends of the runner base (what rides
 *    the track). The runner edge tracks the slope it sits on.
 *  - points[MAST]: held above the base midpoint by the upright spring, so the
 *    sled resists tumbling and stays upright as it rides.
 * `crashed` latches true on a hard hit / over-rotation: the upright spring then
 * switches off and the rig ragdolls (free tumble) for the rest of the run.
 * `spinStreak` counts consecutive substeps the body has been spinning fast, so a
 * brief landing-settling spike doesn't read as a crash — only a sustained spin
 * (a real tumble) does.
 */
export interface Body {
	points: RiderState[]
	constraints: Constraint[]
	crashed: boolean
	spinStreak: number
}

// Named indices into Body.points for the sled rig.
export const BACK = 0
export const FRONT = 1
export const MAST = 2

/**
 * Build a sled body: a rigid runner base (BACK<->FRONT) with a mast point above
 * its midpoint. `center` is the spawn point. The sled spawns facing +x (the
 * direction of travel) and upright (mast above, in screen coords -y).
 */
export function makeBody(center: Vec2): Body {
	const half = PHYSICS.sledRunner
	const mast = PHYSICS.sledMast
	const points = [
		makeRider({ x: center.x - half, y: center.y }), // BACK runner
		makeRider({ x: center.x + half, y: center.y }), // FRONT runner
		makeRider({ x: center.x, y: center.y - mast }), // MAST (above midpoint)
	]
	const dist = (a: number, b: number) => Math.hypot(points[a].pos.x - points[b].pos.x, points[a].pos.y - points[b].pos.y)
	const edge = 1 // runner is fully rigid
	const arm = 0.9 // mast arms slightly softer so the constraint solve stays stable
	const constraints: Constraint[] = [
		{ i: BACK, j: FRONT, rest: dist(BACK, FRONT), stiffness: edge },
		{ i: BACK, j: MAST, rest: dist(BACK, MAST), stiffness: arm },
		{ i: FRONT, j: MAST, rest: dist(FRONT, MAST), stiffness: arm },
	]
	return { points, constraints, crashed: false, spinStreak: 0 }
}

/**
 * The sled's facing angle (radians): the direction of the runner base from BACK
 * to FRONT. 0 = riding flat facing +x; tracks the slope as the runner sits on a
 * line. Used to orient the drawn character.
 */
export function bodyAngle(body: Body): number {
	const a = body.points[BACK].pos
	const b = body.points[FRONT].pos
	return Math.atan2(b.y - a.y, b.x - a.x)
}

/**
 * The art's horizontal mirror so its head leads the direction of HORIZONTAL
 * travel: +1 draws it as-authored, -1 mirrors it. Returns `hold` (the previous
 * value) while horizontal speed is inside `deadband` so a slow/stationary sled
 * doesn't flicker.
 *
 * The art is drawn rotated by `bodyAngle` (the BACK->FRONT runner direction), so
 * its nose points along `facing * (cos angle, sin angle)` — its on-screen x sign
 * is `facing * sign(cos angle)`. To point the nose the way the sled moves across
 * the screen we want that to match `sign(vx)`, hence `facing = sign(vx) *
 * sign(cos angle)`. The `cos angle` term self-corrects the runner's 180°
 * ambiguity: when a tumble leaves FRONT on the left, this still faces travel
 * instead of latching backward (the bug this fixes).
 *
 * Velocity is the RUNNER's (BACK+FRONT mean) — the mast oscillates on its upright
 * spring and including it would let that wobble flip the facing at low speed.
 * Pure & framework-free so the rig's facing can be unit-tested.
 */
export function bodyFacing(body: Body, dt: number, deadband: number, hold: 1 | -1): 1 | -1 {
	const back = body.points[BACK]
	const front = body.points[FRONT]
	// Runner-only mean horizontal velocity (exclude the wobbling mast).
	const vx = (back.pos.x - back.prev.x + front.pos.x - front.prev.x) / (2 * dt)
	if (Math.abs(vx) <= deadband) return hold
	const cos = Math.cos(bodyAngle(body))
	// At a near-vertical runner (cos ~ 0) horizontal facing is degenerate; the art
	// is nearly edge-on anyway, so just hold rather than snap on a tiny cos sign.
	if (Math.abs(cos) < PHYSICS.facingVerticalCos) return hold
	return (Math.sign(vx) * Math.sign(cos)) as 1 | -1
}

/**
 * Rotate the mast back toward upright (above the runner midpoint, opposing
 * gravity) by `uprightStiffness`. This is the righting moment that keeps the
 * sled from tumbling: the mast's rest position is perpendicular to the runner,
 * on the side away from gravity. We move the mast point (and counter-move the
 * runner, conserving the center of mass) a fraction of the way there each step.
 * No-op once crashed, so a crashed sled tumbles freely. Mutates `body`.
 */
function applyUpright(body: Body): void {
	if (body.crashed) return
	const back = body.points[BACK]
	const front = body.points[FRONT]
	const m = body.points[MAST]
	const midx = (back.pos.x + front.pos.x) * 0.5
	const midy = (back.pos.y + front.pos.y) * 0.5
	// Runner tangent (BACK->FRONT), normalized.
	let tx = front.pos.x - back.pos.x
	let ty = front.pos.y - back.pos.y
	const tlen = Math.hypot(tx, ty)
	if (tlen < EPSILON) return
	tx /= tlen
	ty /= tlen
	// Two perpendiculars to the runner; pick the one pointing AWAY from gravity
	// (more negative y = "up" in screen space) as the upright direction.
	const upx = ty
	const upy = -tx
	const upDir = upy <= 0 ? { x: upx, y: upy } : { x: -upx, y: -upy }
	// Where the mast should sit: above the midpoint along upDir at the rest height.
	const targetx = midx + upDir.x * PHYSICS.sledMast
	const targety = midy + upDir.y * PHYSICS.sledMast
	// Move the mast a fraction toward the target; counter-move the runner ends by
	// half each (conserving COM) so the whole rig rotates rather than translating.
	const dx = (targetx - m.pos.x) * PHYSICS.uprightStiffness
	const dy = (targety - m.pos.y) * PHYSICS.uprightStiffness
	m.pos.x += dx
	m.pos.y += dy
	back.pos.x -= dx * 0.5
	back.pos.y -= dy * 0.5
	front.pos.x -= dx * 0.5
	front.pos.y -= dy * 0.5
}

/**
 * Decide whether this step's events should crash the sled (latch ragdoll mode):
 *  - the mast has tilted more than `crashTilt` from upright (flipped over), or
 *  - the body is spinning faster than `crashSpin` (rad/s).
 * Returns true to crash. Cheap; called once per step. (Hard wall slams surface
 * via the spin/tilt that the impact induces, so we don't need a separate
 * per-contact impact probe here.)
 */
function shouldCrash(body: Body, prevAngle: number, dt: number): boolean {
	if (body.crashed) return false
	// Tilt: angle of the mast above the midpoint vs. true up. A genuine flip-over
	// crashes immediately (no streak needed — you're upside down).
	const back = body.points[BACK]
	const front = body.points[FRONT]
	const m = body.points[MAST]
	const midx = (back.pos.x + front.pos.x) * 0.5
	const midy = (back.pos.y + front.pos.y) * 0.5
	const mx = m.pos.x - midx
	const my = m.pos.y - midy
	const mlen = Math.hypot(mx, my)
	if (mlen > EPSILON) {
		// Angle between mast direction and straight up (0,-1).
		const tilt = Math.acos(Math.max(-1, Math.min(1, -my / mlen)))
		if (tilt > PHYSICS.crashTilt) return true
	}
	// Angular speed from the change in runner facing this step. A hard LANDING
	// spins the runner for a frame or two as it snaps onto the slope; only a
	// SUSTAINED fast spin (held for crashSpinFrames substeps) is a real tumble.
	let dAng = bodyAngle(body) - prevAngle
	while (dAng > Math.PI) dAng -= 2 * Math.PI
	while (dAng < -Math.PI) dAng += 2 * Math.PI
	if (Math.abs(dAng / dt) > PHYSICS.crashSpin) body.spinStreak++
	else body.spinStreak = 0
	return body.spinStreak >= PHYSICS.crashSpinFrames
}

/** The body's center of mass (average of its points). Used for camera/stats. */
export function bodyCenter(body: Body): Vec2 {
	let x = 0
	let y = 0
	for (const p of body.points) {
		x += p.pos.x
		y += p.pos.y
	}
	const n = body.points.length || 1
	return { x: x / n, y: y / n }
}

/** Mean velocity (px/s) of the body's points. */
export function bodyVelocity(body: Body, dt: number): Vec2 {
	let x = 0
	let y = 0
	for (const p of body.points) {
		x += (p.pos.x - p.prev.x) / dt
		y += (p.pos.y - p.prev.y) / dt
	}
	const n = body.points.length || 1
	return { x: x / n, y: y / n }
}

/** Move two constrained points toward their rest length (positional solve). */
function solveConstraint(body: Body, c: Constraint): void {
	const a = body.points[c.i]
	const b = body.points[c.j]
	const dx = b.pos.x - a.pos.x
	const dy = b.pos.y - a.pos.y
	const d = Math.hypot(dx, dy)
	if (d < EPSILON) return
	// Half the error moved by each end (equal mass), scaled by stiffness.
	const diff = ((d - c.rest) / d) * 0.5 * c.stiffness
	const ox = dx * diff
	const oy = dy * diff
	a.pos.x += ox
	a.pos.y += oy
	b.pos.x -= ox
	b.pos.y -= oy
}

/**
 * Detect whether the body is contacting a 'bounce' segment this step, and if so
 * return the contact normal (pointing from the line toward the body). Only the
 * runner points touch a line, so per-point
 * restitution inside resolveCollisions reflects just those points while the
 * non-contacting points keep their full downward velocity — the constraint solve
 * then averages the rebound away to nearly zero. So bounce is handled at the body
 * level instead (see stepBody): we reflect the WHOLE body's center-of-mass normal
 * velocity once per step, which propagates the spring to every point uniformly.
 * Returns null when no point is in contact with a bounce line.
 */
function bounceContactNormal(body: Body, segments: Segment[]): { n: Vec2; strength: number } | null {
	const contact = PHYSICS.bodyRadius + PHYSICS.contactSkin
	for (const seg of segments) {
		if (seg.kind !== 'bounce') continue
		// Segment direction + left-hand normal (same convention as sweptContact),
		// used for the swept crossing test below.
		let sdx = seg.b.x - seg.a.x
		let sdy = seg.b.y - seg.a.y
		const segLen = Math.hypot(sdx, sdy)
		if (segLen < EPSILON) continue
		sdx /= segLen
		sdy /= segLen
		const perpX = sdy
		const perpY = -sdx
		for (const p of body.points) {
			// Proximity case: the point ends within the contact band of the line.
			const { point } = closestPointOnSegment(p.pos, seg.a, seg.b)
			const diff = sub(p.pos, point)
			const dist = len(diff)
			if (dist < contact && dist > EPSILON) {
				return { n: { x: diff.x / dist, y: diff.y / dist }, strength: seg.strength ?? 1 }
			}
			// Swept case: a fast point crossed the line within its span this substep
			// (prev and pos on opposite sides), jumping clean past the proximity band.
			// Mirror sweptContact's crossing logic so a fast bounce still rebounds
			// instead of being caught as a dead wall by resolveCollisions. The contact
			// normal points toward the side the point came FROM (its prev side), so the
			// re-launch sends the body back out the way it entered.
			const sPrev = (p.prev.x - seg.a.x) * perpX + (p.prev.y - seg.a.y) * perpY
			const sPos = (p.pos.x - seg.a.x) * perpX + (p.pos.y - seg.a.y) * perpY
			if (sPrev * sPos < 0) {
				// The crossing point's parameter along the segment: did it cross within
				// the span (not off an end)? Interpolate where prev->pos meets the line.
				const f = sPrev / (sPrev - sPos) // in (0,1): fraction from prev to pos
				const cx = p.prev.x + (p.pos.x - p.prev.x) * f
				const cy = p.prev.y + (p.pos.y - p.prev.y) * f
				const tNum = (cx - seg.a.x) * sdx + (cy - seg.a.y) * sdy
				if (tNum > 0 && tNum < segLen) {
					const side = Math.sign(sPrev) || 1
					return { n: { x: perpX * side, y: perpY * side }, strength: seg.strength ?? 1 }
				}
			}
		}
	}
	return null
}

/** Add a velocity delta (px/s-equivalent step displacement) to every body point. */
function addBodyVelocity(body: Body, dvx: number, dvy: number): void {
	for (const p of body.points) {
		p.prev.x -= dvx
		p.prev.y -= dvy
	}
}

/**
 * Advance a multi-point body by one fixed timestep. Integrates every point,
 * then interleaves constraint solving with collision resolution so the body
 * both holds its shape and rests on the track. Mutates and returns `body`.
 */
export function stepBody(
	body: Body,
	segments: Segment[],
	dt: number,
	contacts?: ContactEvent[]
): Body {
	const prevAngle = bodyAngle(body)
	for (const p of body.points) integrate(p, dt)

	// Bounce is a whole-body effect: sample the body's normal velocity into a
	// bounce line BEFORE collisions flatten it, so we can re-launch the whole rig
	// after. (Per-point restitution alone barely moves the rig — see
	// bounceContactNormal.)
	const bounce = bounceContactNormal(body, segments)
	let vnBefore = 0
	if (bounce) {
		const v = bodyVelocity(body, dt)
		vnBefore = v.x * bounce.n.x + v.y * bounce.n.y // <0 means moving into the line
	}

	// Righting moment: nudge the mast back toward upright ONCE per step, before the
	// constraint/collision iterations resolve the shape and contacts. Previously
	// this ran inside every iteration (4x/step): since applyUpright moves positions
	// by a fixed fraction of uprightStiffness each call, the per-step righting
	// compounded to ~1-(1-0.12)^4 ≈ 0.40, AND it perturbed runner points the
	// collision pass had already settled, which the next pass re-resolved — a latent
	// energy source that kept the rig faintly jittering on flat ground. Calling it
	// once up front lets the iterations absorb its perturbation (collision re-seats
	// contacting runner points), so the rig settles cleanly. uprightStiffness was
	// re-tuned up to compensate for the lost compounding (see PHYSICS). A no-op once
	// crashed, so a crashed sled ragdolls freely.
	applyUpright(body)
	const ITERATIONS = 4 // more passes than the point sled: shape + contacts to settle
	for (let iter = 0; iter < ITERATIONS; iter++) {
		for (const c of body.constraints) solveConstraint(body, c)
		const last = iter === ITERATIONS - 1
		// suppressBounce: bounce is re-applied at the body level below, so don't
		// also reflect it per point (that would double the impulse, gaining energy).
		// Collect contacts only on the last pass; every point reports, so the audio
		// layer sees each surface the body touches (it dedupes by kind/shape).
		for (const p of body.points) resolveCollisions(p, segments, dt, last, true, last ? contacts : undefined, PHYSICS.bodyRadius)
	}

	// Re-launch the body off the bounce line. Set the center-of-mass normal
	// velocity to an ABSOLUTE target (-restitution * inbound speed) rather than
	// adding a reflected impulse: after the collision iterations the COM still
	// carries residual normal velocity (the contacting corner stopped while the
	// free corners kept falling), so adding (1+e)|vn| on top of that residual
	// over-injects energy and the bounces grow without bound. Correcting toward a
	// target instead caps the rebound at restitution and stays stable. Applied to
	// every point so the whole rig lifts off together, not just the touching corner.
	if (bounce && vnBefore < 0) {
		const restitution = PHYSICS.bounceRestitution * bounce.strength
		const targetVn = -restitution * vnBefore // desired outbound (along +n) speed
		const after = bodyVelocity(body, dt)
		const vnAfter = after.x * bounce.n.x + after.y * bounce.n.y
		const dv = targetVn - vnAfter // close the gap to the target only
		addBodyVelocity(body, bounce.n.x * dv * dt, bounce.n.y * dv * dt)
	}

	for (const p of body.points) clampSpeed(p, dt)

	// Latch the crash state after the step settles: if the sled flipped past
	// `crashTilt` or spun faster than `crashSpin`, switch off the upright spring
	// for the rest of the run so it ragdolls. Checked last so it sees the resolved
	// post-collision pose (a wall slam shows up as the induced spin/tilt).
	if (!body.crashed && shouldCrash(body, prevAngle, dt)) body.crashed = true

	return body
}
