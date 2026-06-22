import { describe, it, expect } from 'vitest'
import {
	makeRider,
	step,
	velocity,
	PHYSICS,
	makeBody,
	stepBody,
	bodyCenter,
	bodyVelocity,
	bodyAngle,
	bodyFacing,
	BACK,
	FRONT,
	MAST,
	type Body,
	type Segment,
	type ContactEvent,
} from './physics'

const DT = 1 / 120

function run(rider: ReturnType<typeof makeRider>, segments: Segment[], steps: number) {
	for (let i = 0; i < steps; i++) step(rider, segments, DT)
	return rider
}

describe('physics: free fall', () => {
	it('accelerates downward under gravity with no segments', () => {
		const r = makeRider({ x: 0, y: 0 })
		run(r, [], 60) // ~0.5s
		// Should have moved down (positive y) and gained downward velocity.
		expect(r.pos.y).toBeGreaterThan(0)
		const v = velocity(r, DT)
		expect(v.y).toBeGreaterThan(0)
		// No horizontal drift in pure fall.
		expect(Math.abs(r.pos.x)).toBeLessThan(1e-6)
	})

	it('falls farther over more time (monotonic)', () => {
		const a = run(makeRider({ x: 0, y: 0 }), [], 30)
		const b = run(makeRider({ x: 0, y: 0 }), [], 60)
		expect(b.pos.y).toBeGreaterThan(a.pos.y)
	})
})

describe('physics: flat floor collision', () => {
	// A long horizontal line at y = 50.
	const floor: Segment = { a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 } }

	it('rider comes to rest on the floor instead of passing through', () => {
		const r = makeRider({ x: 0, y: 0 })
		run(r, [floor], 240) // 2s — plenty to settle
		// Rider sits just above the line by ~its radius, never far below it.
		expect(r.pos.y).toBeLessThanOrEqual(50)
		expect(r.pos.y).toBeGreaterThan(50 - PHYSICS.riderRadius - 2)
	})

	it('vertical velocity is killed once resting on the floor', () => {
		const r = makeRider({ x: 0, y: 0 })
		run(r, [floor], 240)
		const v = velocity(r, DT)
		// Settled: vertical velocity is essentially zero, not still driving down
		// into the floor. A loose bound here would pass even while falling fast.
		expect(Math.abs(v.y)).toBeLessThan(1)
	})
})

describe('physics: body falls off the end of a finite edge (corner)', () => {
	// The top edge of a box: a finite horizontal segment. A sled sliding slowly to
	// the right must round the right corner and fall off — not stop dead ON the
	// corner. Regression: an off-the-end (corner) contact resolved against the
	// edge's perpendicular (up) normal instead of the radial direction from the
	// corner, so a slow sled got pinned at edge height at the corner and never fell
	// off. (Fast slides happened to clear the corner band before settling, which is
	// why this only showed up "sometimes" — at low speed.) Now corner contacts push
	// radially, so the normal rotates from up toward sideways/down as the sled
	// passes the end and gravity carries it off.
	const runBody = (body: Body, segments: Segment[], steps: number) => {
		for (let i = 0; i < steps; i++) stepBody(body, segments, DT)
		return body
	}
	const edge: Segment = { a: { x: -100, y: 0 }, b: { x: 100, y: 0 } }

	it('a slow sled sliding past the corner falls off instead of stopping on it', () => {
		// Rest the sled on the edge near the right end, creeping right (~24 px/s).
		const body = makeBody({ x: 80, y: -PHYSICS.bodyRadius })
		for (const p of body.points) p.prev.x = p.pos.x - 0.2
		runBody(body, [edge], 400)
		const c = bodyCenter(body)
		// It rounded the corner (well past x=100) and fell far below edge height,
		// rather than parking at the corner near edge height (the old bug: cx≈100,
		// cy≈-bodyRadius).
		expect(c.x).toBeGreaterThan(100)
		expect(c.y).toBeGreaterThan(PHYSICS.bodyRadius * 4)
	})

	it('a sled resting mid-edge stays supported (corner fix did not break the span)', () => {
		const body = makeBody({ x: 0, y: -30 })
		runBody(body, [edge], 300)
		// Still resting on the flat part: its lowest point near the line, not fallen
		// through, and not flung off.
		const low = Math.max(...body.points.map((p) => p.pos.y))
		expect(low).toBeLessThanOrEqual(PHYSICS.bodyRadius + 2)
		expect(Math.abs(bodyCenter(body).x)).toBeLessThan(40)
	})
})

describe('physics: slope produces horizontal motion', () => {
	// A line sloping down to the right (from high-left to low-right).
	const slope: Segment = { a: { x: -200, y: -100 }, b: { x: 200, y: 100 } }

	it('rider slides down-slope, gaining +x and +y', () => {
		const r = makeRider({ x: 0, y: -20 }) // start above the slope
		run(r, [slope], 180)
		// Down a right-leaning slope means moving right and down.
		expect(r.pos.x).toBeGreaterThan(0)
		expect(r.pos.y).toBeGreaterThan(-20)
	})
})

describe('physics: lines are near-frictionless', () => {
	// A gentle downhill slope. Riding it should ACCELERATE the sled, not stall it.
	const slope: Segment = { a: { x: -400, y: 0 }, b: { x: 400, y: 200 } }

	it('sled keeps accelerating along a downhill line (low surface friction)', () => {
		const r = makeRider({ x: -380, y: -10 })
		// Speed early in the ride vs later — should grow, not shrink.
		run(r, [slope], 60)
		const early = Math.hypot(velocity(r, DT).x, velocity(r, DT).y)
		run(r, [slope], 60)
		const later = Math.hypot(velocity(r, DT).x, velocity(r, DT).y)
		expect(later).toBeGreaterThan(early)
	})
})

describe('physics: speed clamp', () => {
	it('never exceeds maxSpeed even after a long fall', () => {
		const r = makeRider({ x: 0, y: 0 })
		run(r, [], 600) // 5s
		const v = velocity(r, DT)
		const speed = Math.hypot(v.x, v.y)
		expect(speed).toBeLessThanOrEqual(PHYSICS.maxSpeed + 1)
	})

	it('a perfectly stationary rider stays finite (no NaN from zero-velocity clamp)', () => {
		// Wedge the rider exactly on a flat floor with zero initial velocity.
		const floor: Segment = { a: { x: -100, y: 0 }, b: { x: 100, y: 0 } }
		const r = makeRider({ x: 0, y: 0 })
		r.prev = { x: 0, y: 0 }
		step(r, [floor], DT)
		expect(Number.isFinite(r.pos.x)).toBe(true)
		expect(Number.isFinite(r.pos.y)).toBe(true)
	})
})

describe('physics: swept collision (no tunneling)', () => {
	// A thin horizontal floor. A fast point must not pass through it in one step
	// even when its per-step displacement is many times the contact band.
	const floor: Segment = { a: { x: -1000, y: 0 }, b: { x: 1000, y: 0 } }

	it('a fast point crossing a thin line in one step is caught, not tunneled', () => {
		// Place the point just above the line and give it a huge downward step so
		// (pos - prev) far exceeds the contact band. Without a swept test the point
		// lands well below the line and the proximity check never sees it.
		const r = makeRider({ x: 0, y: -5 })
		r.prev = { x: 0, y: -5 - 200 } // ~200px downward in one step (>> contact band)
		step(r, [floor], DT)
		// It must be stopped at/above the floor, not tunneled through to the far side.
		expect(r.pos.y).toBeLessThanOrEqual(0 + 1)
	})

	it('a point that crosses the line is ejected back to the side it came from, not through it', () => {
		// Start clearly above the line and give it a step that lands it just past
		// the line (a fast cross within one step). The swept test must push it back
		// UP to the side it came from, never deeper through to the underside — this
		// is the "hits the inside of the box" bug at the single-segment level.
		const r = makeRider({ x: 0, y: -5 })
		r.prev = { x: 0, y: -20 } // moving down ~15px/integrate; came from above
		// One integrate carries pos past y=0; resolveCollisions must catch the cross.
		step(r, [floor], DT)
		expect(r.pos.y).toBeLessThanOrEqual(0 + 1)
	})

	it('the body does not tunnel into a box; it rests on top, not inside', () => {
		// A 200x120 box (CCW outline) dropped onto from above. The body must settle
		// on the TOP wall (y ~ top - radius), never end up inside the box interior.
		const top = -60,
			bottom = 60,
			left = -100,
			right = 100
		const box: Segment[] = [
			{ a: { x: left, y: top }, b: { x: right, y: top } }, // top
			{ a: { x: right, y: top }, b: { x: right, y: bottom } }, // right
			{ a: { x: right, y: bottom }, b: { x: left, y: bottom } }, // bottom
			{ a: { x: left, y: bottom }, b: { x: left, y: top } }, // left
		]
		const body = makeBody({ x: 0, y: top - 80 }) // start above the box
		for (let i = 0; i < 400; i++) stepBody(body, box, DT)
		const c = bodyCenter(body)
		// Center rests above the top wall (just outside), not floating inside the box.
		expect(c.y).toBeLessThan(top)
		// And horizontally still over the box (didn't get flung sideways out).
		expect(c.x).toBeGreaterThan(left - 50)
		expect(c.x).toBeLessThan(right + 50)
	})
})

describe('physics: inside-corner collision (order-independent)', () => {
	// An inside 90deg corner: a floor (horizontal) and a wall (vertical) meeting at
	// the origin, like the interior seam of a box. A point dropped into the corner
	// contacts BOTH segments in one pass. The resolved velocity must not point INTO
	// either surface, and must not depend on the array order of the two segments
	// (the last-writer-wins prev-rewrite bug).
	const floor: Segment = { a: { x: -100, y: 0 }, b: { x: 100, y: 0 } } // surface above it (normal up)
	const wall: Segment = { a: { x: 0, y: -100 }, b: { x: 0, y: 100 } } // vertical wall

	// Drop a point moving down-and-right toward the corner so it presses into both
	// the floor (from above) and the wall (from the left).
	const cornerPoint = () => {
		const r = makeRider({ x: -2, y: -2 })
		r.prev = { x: -10, y: -10 } // moving +x, +y into the corner
		return r
	}

	it('post-step velocity does not point into either wall', () => {
		const r = cornerPoint()
		step(r, [floor, wall], DT)
		const v = velocity(r, DT)
		// Floor normal is up (0,-1): outward velocity component is -v.y; "into the
		// floor" means v.y > 0 (downward). Allow a tiny epsilon for solver residue.
		expect(v.y).toBeLessThan(1e-6)
		// Wall: the point came from the left (x<0), so its outward normal is (-1,0);
		// "into the wall" means v.x > 0 (rightward). Must not drive into the wall.
		expect(v.x).toBeLessThan(1e-6)
	})

	it('resulting pos and prev are identical regardless of segment array order', () => {
		const a = cornerPoint()
		step(a, [floor, wall], DT)
		const b = cornerPoint()
		step(b, [wall, floor], DT)
		expect(a.pos.x).toBeCloseTo(b.pos.x, 9)
		expect(a.pos.y).toBeCloseTo(b.pos.y, 9)
		expect(a.prev.x).toBeCloseTo(b.prev.x, 9)
		expect(a.prev.y).toBeCloseTo(b.prev.y, 9)
	})

	// Order-independence must survive the running-velocity model even when the two
	// surfaces have DIFFERENT friction/kind and a NON-orthogonal corner with an
	// ASYMMETRIC incoming velocity — the case where per-segment friction/kind on a
	// running velocity could in theory reintroduce order-dependence. It doesn't,
	// because step()'s relaxation iterations converge to the same fixed point. This
	// is the adversarial guard for that property.
	it('stays order-independent with mixed friction/kind at an asymmetric corner', () => {
		const stickyFloor: Segment = { a: { x: -100, y: 0 }, b: { x: 100, y: 0 }, kind: 'sticky' }
		const iceRamp: Segment = { a: { x: 0, y: 0 }, b: { x: -80, y: -60 }, kind: 'ice' }
		const mk = () => {
			const r = makeRider({ x: -3, y: -3 })
			r.prev = { x: -12, y: -9 } // asymmetric motion into both surfaces
			return r
		}
		const a = mk()
		step(a, [stickyFloor, iceRamp], DT)
		const b = mk()
		step(b, [iceRamp, stickyFloor], DT)
		expect(a.pos.x).toBeCloseTo(b.pos.x, 9)
		expect(a.pos.y).toBeCloseTo(b.pos.y, 9)
		expect(a.prev.x).toBeCloseTo(b.prev.x, 9)
		expect(a.prev.y).toBeCloseTo(b.prev.y, 9)
	})

	// The multi-contact resolution must not gain energy at a corner: a point wedged
	// into an inside corner under gravity must settle (not bounce/jitter/explode)
	// over many steps. Guards against the "summing two segments' corrections
	// double-counts an impulse" concern.
	it('a point wedged in an inside corner settles (no energy gain over many steps)', () => {
		const r = makeRider({ x: -2, y: -2 })
		// Run long enough to reach steady state, then sample speed over a window.
		for (let i = 0; i < 300; i++) step(r, [floor, wall], DT)
		const before = velocity(r, DT)
		for (let i = 0; i < 60; i++) step(r, [floor, wall], DT)
		const after = velocity(r, DT)
		// Settled: tiny residual speed, and not growing (energy bounded).
		expect(Math.hypot(after.x, after.y)).toBeLessThan(2)
		expect(Math.hypot(after.x, after.y)).toBeLessThanOrEqual(Math.hypot(before.x, before.y) + 1e-6)
		// And it stays out of both surfaces (x <= ~0 against the wall, y <= ~0 on the floor),
		// within the contact band.
		expect(r.pos.x).toBeLessThan(PHYSICS.riderRadius + PHYSICS.contactSkin + 1e-6)
		expect(r.pos.y).toBeLessThan(PHYSICS.riderRadius + PHYSICS.contactSkin + 1e-6)
	})
})

describe('physics: single-contact equivalence (refactor safety)', () => {
	// The running-velocity resolution in resolveCollisions must, for a SINGLE contact,
	// produce the same result as the pre-refactor per-hit prev rewrite (one segment ->
	// one normal-removal). Rather than hand-compute the 2-iteration solver's exact value
	// (brittle), we lock the equivalence directly: a single floor segment must produce
	// the IDENTICAL pos/prev as that floor placed in a list where the only OTHER segments
	// are ones the point never contacts. If the contact loop were wrong, the presence of
	// non-contacting segments (or the order) would perturb the single real contact's
	// result. It must not.
	const floor: Segment = { a: { x: -100, y: 0 }, b: { x: 100, y: 0 } }
	const farAbove: Segment = { a: { x: -100, y: -500 }, b: { x: 100, y: -500 } } // never touched
	const farBelow: Segment = { a: { x: -100, y: 500 }, b: { x: 100, y: 500 } } // never touched

	const sliding = () => {
		const r = makeRider({ x: 0, y: -PHYSICS.riderRadius })
		r.prev = { x: -2, y: -PHYSICS.riderRadius - 2 } // moving +x (tangent), +y (into floor)
		return r
	}

	it('normal velocity is removed and tangent is preserved (near-frictionless)', () => {
		const r = sliding()
		step(r, [floor], DT)
		const v = velocity(r, DT)
		expect(v.y).toBeLessThanOrEqual(1e-6) // not driving into the floor
		expect(v.x).toBeGreaterThan(0) // tangent kept (lines are near-frictionless)
	})

	it('non-contacting segments and their order do not perturb the single contact', () => {
		// Non-contacting segments are skipped before any velocity math, so this is a
		// guard against the contact LOOP picking up spurious hits — not against the
		// delta-accumulation itself (the duplicate-floor test below covers that).
		const base = sliding()
		step(base, [floor], DT)
		for (const segs of [
			[farAbove, floor, farBelow],
			[farBelow, farAbove, floor],
			[floor, farAbove, farBelow],
		]) {
			const r = sliding()
			step(r, segs, DT)
			expect(r.pos.x).toBeCloseTo(base.pos.x, 9)
			expect(r.pos.y).toBeCloseTo(base.pos.y, 9)
			expect(r.prev.x).toBeCloseTo(base.prev.x, 9)
			expect(r.prev.y).toBeCloseTo(base.prev.y, 9)
		}
	})

	it('two coincident floor segments (both contacted) do not double-eject or gain energy', () => {
		// Two identical floors at the same place: the point contacts BOTH in one pass,
		// so the multi-contact loop runs for real (unlike the non-contacting case). The
		// push-out must not fling the point far above the surface, and the running-velocity
		// correction must not gain energy vs. the single-floor result — the second
		// coincident contact sees vn >= 0 and is skipped, so it lands at essentially the
		// same rest as one floor (redundant contact, not additive energy).
		const one = sliding()
		step(one, [floor], DT)
		const two = sliding()
		step(two, [floor, { ...floor }], DT)
		const vOne = velocity(one, DT)
		const vTwo = velocity(two, DT)
		// Not ejected upward by a doubled push-out: y stays within the contact band of
		// the surface (around -riderRadius), not flung far above it.
		expect(two.pos.y).toBeGreaterThan(-PHYSICS.riderRadius - PHYSICS.contactSkin - 1e-6)
		expect(two.pos.y).toBeLessThan(1e-6)
		// No energy gain: the two-floor speed must not exceed the one-floor speed.
		expect(Math.hypot(vTwo.x, vTwo.y)).toBeLessThanOrEqual(Math.hypot(vOne.x, vOne.y) + 1e-6)
	})
})

describe('physics: accelerate lines', () => {
	const flat = (kind?: Segment['kind']): Segment => ({
		a: { x: -1000, y: 50 },
		b: { x: 1000, y: 50 },
		kind,
	})

	it('an accelerate line drives the sled faster than a plain solid line', () => {
		// Start just above the floor with initial rightward motion and let
		// gravity press it into contact so collisions (and the boost) fire.
		const solid = makeRider({ x: 0, y: 40 })
		solid.prev = { x: -2, y: 40 }
		run(solid, [flat('solid')], 240)

		const boost = makeRider({ x: 0, y: 40 })
		boost.prev = { x: -2, y: 40 }
		run(boost, [flat('accelerate')], 240)

		expect(boost.pos.x).toBeGreaterThan(solid.pos.x)
	})

	it('stays on a long line without runaway speed or tunneling', () => {
		// A practically infinite line so the sled never runs off the end.
		const line: Segment = { a: { x: -1e7, y: 50 }, b: { x: 1e7, y: 50 }, kind: 'accelerate' }
		const r = makeRider({ x: 0, y: 40 })
		r.prev = { x: -2, y: 40 }
		run(r, [line], 2000)
		// Still riding the line (didn't tunnel through), and speed is capped.
		expect(Math.abs(r.pos.y - (50 - PHYSICS.riderRadius))).toBeLessThan(2)
		const v = velocity(r, DT)
		expect(Math.hypot(v.x, v.y)).toBeLessThanOrEqual(PHYSICS.accelerateMaxSpeed + 50)
	})
})

describe('physics: brake lines', () => {
	const flat = (kind?: Segment['kind']): Segment => ({
		a: { x: -1e7, y: 50 },
		b: { x: 1e7, y: 50 },
		kind,
	})

	it('a brake line slows the sled vs a plain solid line', () => {
		// Both start with the same rightward motion, pressed onto the floor.
		const solid = makeRider({ x: 0, y: 44 })
		solid.prev = { x: -6, y: 44 } // ~720 px/s rightward
		run(solid, [flat('solid')], 120)

		const brake = makeRider({ x: 0, y: 44 })
		brake.prev = { x: -6, y: 44 }
		run(brake, [flat('brake')], 120)

		// The braked sled covers less ground because tangential drag bleeds speed.
		expect(brake.pos.x).toBeLessThan(solid.pos.x)
	})
})

describe('physics: bounce lines', () => {
	const flat = (kind?: Segment['kind']): Segment => ({
		a: { x: -1000, y: 50 },
		b: { x: 1000, y: 50 },
		kind,
	})

	it('a sled rebounds higher off a bounce line than off a solid line', () => {
		// Drop from the same height; measure the rebound apex reached strictly
		// AFTER the sled first makes contact with the floor (y near 50). Tracking
		// the apex only post-contact avoids counting the shared drop start.
		const apexAfterContact = (kind: Segment['kind']): number => {
			const r = makeRider({ x: 0, y: -50 })
			let contacted = false
			let apex = Infinity // smallest (highest) y seen after contact
			for (let i = 0; i < 120; i++) {
				step(r, [flat(kind)], DT)
				if (!contacted && r.pos.y > 50 - PHYSICS.riderRadius - 2) contacted = true
				if (contacted) apex = Math.min(apex, r.pos.y)
			}
			return apex
		}
		// Higher rebound = smaller (more negative) apex y after the bounce.
		expect(apexAfterContact('bounce')).toBeLessThan(apexAfterContact('solid'))
	})
})

describe('physics: sticky lines', () => {
	const flat = (kind?: Segment['kind']): Segment => ({
		a: { x: -1e7, y: 50 },
		b: { x: 1e7, y: 50 },
		kind,
	})

	it('a sticky line drags the sled to a near-stop faster than solid', () => {
		const solid = makeRider({ x: 0, y: 44 })
		solid.prev = { x: -6, y: 44 }
		run(solid, [flat('solid')], 120)

		const sticky = makeRider({ x: 0, y: 44 })
		sticky.prev = { x: -6, y: 44 }
		run(sticky, [flat('sticky')], 120)

		expect(sticky.pos.x).toBeLessThan(solid.pos.x)
	})
})

describe('physics: ice lines', () => {
	const flat = (kind?: Segment['kind']): Segment => ({
		a: { x: -1e7, y: 50 },
		b: { x: 1e7, y: 50 },
		kind,
	})

	it('an ice line preserves more glide than a solid line', () => {
		const solid = makeRider({ x: 0, y: 44 })
		solid.prev = { x: -6, y: 44 }
		run(solid, [flat('solid')], 200)

		const ice = makeRider({ x: 0, y: 44 })
		ice.prev = { x: -6, y: 44 }
		run(ice, [flat('ice')], 200)

		// Frictionless ice lets the sled travel at least as far as the (already
		// near-frictionless) solid line.
		expect(ice.pos.x).toBeGreaterThanOrEqual(solid.pos.x)
	})
})

describe('physics: light variants are weaker', () => {
	const flat = (kind: Segment['kind'], strength?: number): Segment => ({
		a: { x: -1e7, y: 50 },
		b: { x: 1e7, y: 50 },
		kind,
		strength,
	})

	it('a half-strength accelerate line boosts less than full strength', () => {
		const full = makeRider({ x: 0, y: 40 })
		full.prev = { x: -2, y: 40 }
		run(full, [flat('accelerate', 1)], 240)

		const half = makeRider({ x: 0, y: 40 })
		half.prev = { x: -2, y: 40 }
		run(half, [flat('accelerate', 0.5)], 240)

		expect(half.pos.x).toBeLessThan(full.pos.x)
	})
})

describe('physics: one-way lines', () => {
	// Left-hand normal of a left->right segment points up (-y), so "front" is above.
	const oneway: Segment = { a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 }, kind: 'oneway' }

	it('blocks a sled falling onto it from the front (above)', () => {
		const r = makeRider({ x: 0, y: 0 }) // above the line
		run(r, [oneway], 240)
		expect(r.pos.y).toBeLessThanOrEqual(50)
	})

	it('lets a sled rising from behind (below) pass through', () => {
		const r = makeRider({ x: 0, y: 100 }) // below the line
		r.prev = { x: 0, y: 110 } // moving upward toward the line
		run(r, [oneway], 10)
		// It should not be stopped at the line; gravity may slow it, but the line
		// must not have pushed it back below where a solid line would trap it.
		expect(r.pos.y).toBeLessThan(100)
	})

	it('a flipped one-way blocks from below but lets a fall pass through from above', () => {
		const flipped: Segment = { ...oneway, flip: true }
		// Falling onto it from above passes through (opposite of plain oneway).
		const above = makeRider({ x: 0, y: 0 })
		run(above, [flipped], 240)
		expect(above.pos.y).toBeGreaterThan(50) // not trapped at the line; fell past

		// Rising gently from just below is blocked: the line stops the upward
		// motion so the sled never crosses above it, then gravity drops it back
		// down through the unblocked side. Track the highest point (min y) reached;
		// it must stay on the underside (>= the line). Keep the per-step speed
		// under the tunneling threshold so collision catches the upward motion.
		const below = makeRider({ x: 0, y: 60 })
		below.prev = { x: 0, y: 62 } // ~240 px/s upward
		let minY = below.pos.y
		for (let i = 0; i < 60; i++) {
			step(below, [flipped], DT)
			minY = Math.min(minY, below.pos.y)
		}
		// Never punched through to above the line (would settle near 50 - radius).
		expect(minY).toBeGreaterThanOrEqual(50 - 1)
	})
})

describe('physics: contact events (audio sink)', () => {
	const floor: Segment = {
		a: { x: -1000, y: 50 },
		b: { x: 1000, y: 50 },
		kind: 'accelerate',
		strength: 0.5,
		shape: 'line',
	}

	it('passing a sink does not change the simulated path (byte-identical)', () => {
		// Same start, same segments, same step count — one with a sink, one without.
		const withSink = makeRider({ x: 0, y: 40 })
		withSink.prev = { x: -2, y: 40 }
		const withoutSink = makeRider({ x: 0, y: 40 })
		withoutSink.prev = { x: -2, y: 40 }
		for (let i = 0; i < 240; i++) {
			step(withSink, [floor], DT, [])
			step(withoutSink, [floor], DT)
		}
		expect(withSink.pos.x).toBe(withoutSink.pos.x)
		expect(withSink.pos.y).toBe(withoutSink.pos.y)
		expect(withSink.prev.x).toBe(withoutSink.prev.x)
		expect(withSink.prev.y).toBe(withoutSink.prev.y)
	})

	it('reports a contact with the segment kind/strength/shape while riding', () => {
		const r = makeRider({ x: 0, y: 40 })
		r.prev = { x: -2, y: 40 }
		// Settle onto the floor first, then sample one resting step.
		run(r, [floor], 60)
		const contacts: ContactEvent[] = []
		step(r, [floor], DT, contacts)
		expect(contacts.length).toBeGreaterThan(0)
		const c = contacts[0]
		expect(c.kind).toBe('accelerate')
		expect(c.strength).toBe(0.5)
		expect(c.shape).toBe('line')
		expect(c.speed).toBeGreaterThanOrEqual(0)
		expect(Number.isFinite(c.speed)).toBe(true)
	})

	it('reports nothing in free fall (no segments touched)', () => {
		const r = makeRider({ x: 0, y: 0 })
		const contacts: ContactEvent[] = []
		for (let i = 0; i < 30; i++) step(r, [], DT, contacts)
		expect(contacts.length).toBe(0)
	})

	it('reports at most once per contacted segment per step (not once per iteration)', () => {
		const r = makeRider({ x: 0, y: 40 })
		r.prev = { x: -2, y: 40 }
		run(r, [floor], 60) // settle onto the single floor line
		const contacts: ContactEvent[] = []
		step(r, [floor], DT, contacts)
		// One segment in contact -> exactly one event, despite step()'s 2 iterations.
		expect(contacts.length).toBe(1)
	})

	it('the multi-point body reports contacts through the sink too', () => {
		const body = makeBody({ x: 0, y: -40 })
		for (let i = 0; i < 200; i++) stepBody(body, [floor], DT) // settle on the floor
		const contacts: ContactEvent[] = []
		stepBody(body, [floor], DT, contacts)
		expect(contacts.length).toBeGreaterThan(0)
		expect(contacts.every((c) => c.kind === 'accelerate' && c.shape === 'line')).toBe(true)
	})
})

describe('physics: multi-point body', () => {
	const runBody = (body: Body, segments: Segment[], steps: number) => {
		for (let i = 0; i < steps; i++) stepBody(body, segments, DT)
		return body
	}

	// Edge rest lengths captured at spawn; used to assert the body holds shape.
	const edgeLengths = (body: Body) =>
		body.constraints.map((c) =>
			Math.hypot(
				body.points[c.i].pos.x - body.points[c.j].pos.x,
				body.points[c.i].pos.y - body.points[c.j].pos.y
			)
		)

	it('falls under gravity (center drifts down with no track)', () => {
		const body = makeBody({ x: 0, y: 0 })
		runBody(body, [], 60)
		expect(bodyCenter(body).y).toBeGreaterThan(0)
		expect(bodyVelocity(body, DT).y).toBeGreaterThan(0)
	})

	it('comes to rest on a floor instead of passing through', () => {
		const floor: Segment = { a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 } }
		const body = makeBody({ x: 0, y: -40 })
		runBody(body, [floor], 300)
		// Every point sits at or above the floor (within the contact radius).
		for (const p of body.points) {
			expect(p.pos.y).toBeLessThanOrEqual(50 + PHYSICS.bodyRadius)
		}
		// And it has settled: near-zero vertical velocity, not still driving down.
		expect(Math.abs(bodyVelocity(body, DT).y)).toBeLessThan(2)
	})

	it('holds its shape: constraint lengths stay near their rest length', () => {
		const floor: Segment = { a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 } }
		const rest = makeBody({ x: 0, y: -40 }).constraints.map((c) => c.rest)
		const body = makeBody({ x: 0, y: -40 })
		runBody(body, [floor], 300)
		const now = edgeLengths(body)
		now.forEach((len, idx) => {
			// Verlet distance constraints are soft, but the rig should stay within
			// ~25% of its rest shape rather than collapsing or exploding.
			expect(Math.abs(len - rest[idx]) / rest[idx]).toBeLessThan(0.25)
		})
	})

	it('rebounds off a bounce line higher than off a solid line', () => {
		// The in-game sled is a body, not a point, so verify bounce reads on it too.
		// Drop from the same height onto each surface; the bounce floor should fling
		// the body's center back higher (smaller min-y after contact) than solid.
		const apex = (kind: Segment['kind']) => {
			const floor: Segment = { a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 }, kind }
			const body = makeBody({ x: 0, y: -60 })
			let contacted = false
			let best = Infinity
			for (let i = 0; i < 200; i++) {
				stepBody(body, [floor], DT)
				// Contact = the body's lowest point reached the floor (the body's center
				// rests ~half its height above the line, so test the lowest point).
				const low = Math.max(...body.points.map((p) => p.pos.y))
				if (!contacted && low > 50 - PHYSICS.bodyRadius - 2) contacted = true
				if (contacted) best = Math.min(best, bodyCenter(body).y)
			}
			return best
		}
		expect(apex('bounce')).toBeLessThan(apex('solid'))
	})

	it('rebounds off a bounce line even when crossing it FAST in one substep', () => {
		// Lock-in for swept bounce detection: a body crossing a bounce line so fast it
		// jumps clean past the proximity contact band in a single substep must STILL be
		// detected as a bounce and rebound. With proximity-only detection the body
		// tunnels past the band, gets caught by resolveCollisions (suppressBounce=true)
		// as a dead wall, and keeps moving DOWN (no rebound). Runner spawns right at the
		// line and is slammed ~12000 px/s downward, so one integrate lands it ~100px
		// past the line — far beyond the ~20.75px band.
		const floor: Segment = { a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 }, kind: 'bounce' }
		const body = makeBody({ x: 0, y: 50 }) // runner exactly on the line
		for (const p of body.points) p.prev.y = p.pos.y - 100 // huge downward step
		stepBody(body, [floor], DT)
		// After a real bounce the body's center is moving back UP (outbound, vy<0),
		// not still driving down through a dead wall.
		expect(bodyVelocity(body, DT).y).toBeLessThan(0)
	})

	it('slides and rotates down a slope (a point sled cannot rotate)', () => {
		const slope: Segment = { a: { x: -300, y: -100 }, b: { x: 300, y: 200 } }
		const body = makeBody({ x: -200, y: -120 })
		const angleOf = (b: Body) =>
			Math.atan2(b.points[1].pos.y - b.points[0].pos.y, b.points[1].pos.x - b.points[0].pos.x)
		const before = angleOf(body)
		runBody(body, [slope], 180)
		// Moved down-slope (right and down) ...
		expect(bodyCenter(body).x).toBeGreaterThan(-200)
		expect(bodyCenter(body).y).toBeGreaterThan(-120)
		// ... and the body's top edge tilted as it rode (it tumbles, unlike a point).
		expect(Math.abs(angleOf(body) - before)).toBeGreaterThan(0.01)
	})

	// The in-game sled is a body, not a point. Surface drag fires per contacting
	// point and the constraint solve spreads it across the rig, so the body bleeds
	// far more tangential speed than the single-point step() does. These cases ride
	// the BODY down a realistic gentle downhill — the regression that made solid
	// and accelerate feel dead (heavy surfaceFriction stalling the rig / cancelling
	// gravity) was invisible to the point-only step() tests above.
	const downhill = (kind?: Segment['kind']): Segment => ({
		a: { x: -2000, y: -400 },
		b: { x: 2000, y: 400 },
		kind,
	})
	const slopeSpeed = (kind?: Segment['kind'], steps = 400) => {
		const body = makeBody({ x: -1900, y: -420 })
		runBody(body, [downhill(kind)], steps)
		const v = bodyVelocity(body, DT)
		return Math.hypot(v.x, v.y)
	}

	it('the body keeps gliding down a solid downhill (drag never cancels gravity)', () => {
		// A solid line is near-frictionless: the body should be moving briskly after
		// riding a long gentle downhill, not stalled to a crawl by surface drag.
		expect(slopeSpeed('solid')).toBeGreaterThan(150)
	})

	it('an accelerate downhill drives the body faster than solid OR ice', () => {
		// Accelerate actively pushes, so it must end up the fastest surface — it was
		// previously slower than ice because the boost was fighting heavy surface
		// drag. It rides at/under the speed cap (no runaway/tunneling).
		const accel = slopeSpeed('accelerate')
		expect(accel).toBeGreaterThan(slopeSpeed('solid'))
		expect(accel).toBeGreaterThan(slopeSpeed('ice'))
		expect(accel).toBeLessThanOrEqual(PHYSICS.accelerateMaxSpeed + 50)
	})

	it('an ice downhill preserves more glide than a solid one', () => {
		// Ice adds zero tangential drag, so the body coasts faster than on solid.
		expect(slopeSpeed('ice')).toBeGreaterThan(slopeSpeed('solid'))
	})
})

describe('physics: sled rig (upright + crash)', () => {
	const runBody = (body: Body, segments: Segment[], steps: number) => {
		for (let i = 0; i < steps; i++) stepBody(body, segments, DT)
		return body
	}

	it('spawns upright: the mast sits above the runner base', () => {
		const body = makeBody({ x: 0, y: 0 })
		const midy = (body.points[0].pos.y + body.points[1].pos.y) / 2
		// MAST (index 2) is above the base midpoint (smaller y = up in screen space).
		expect(body.points[2].pos.y).toBeLessThan(midy)
	})

	it('rides a slope without tumbling: the runner tracks the slope angle', () => {
		// On a ~27deg downhill the sled should settle to ride at roughly that angle,
		// not flip end-over-end. Compare the runner facing to the slope direction.
		const slope: Segment = { a: { x: -300, y: -150 }, b: { x: 300, y: 150 } }
		const slopeAngle = Math.atan2(300, 600) // ~0.46 rad
		const body = makeBody({ x: -200, y: -170 })
		runBody(body, [slope], 200)
		expect(body.crashed).toBe(false)
		// Facing within ~20deg of the slope: it's riding it, not tumbling.
		expect(Math.abs(bodyAngle(body) - slopeAngle)).toBeLessThan(0.35)
	})

	it('stays upright on flat ground (mast does not invert)', () => {
		const floor: Segment = { a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 } }
		const body = makeBody({ x: 0, y: -40 })
		runBody(body, [floor], 300)
		expect(body.crashed).toBe(false)
		const midy = (body.points[0].pos.y + body.points[1].pos.y) / 2
		expect(body.points[2].pos.y).toBeLessThan(midy) // mast still above
	})

	it('settles to a stable upright rest on a flat line (energy decays)', () => {
		// Lock-in for the applyUpright call-count fix: dropping the body onto a flat
		// solid line must SETTLE — the center stops descending, velocity decays toward
		// zero, the mast stays above the runner, and the constraints stay near rest.
		// This characterizes "settles upright" and must hold before and after the fix.
		const floor: Segment = { a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 } }
		const body = makeBody({ x: 0, y: -40 })
		runBody(body, [floor], 300) // let it come to rest
		const midY = (body.points[BACK].pos.y + body.points[FRONT].pos.y) / 2
		const yAtRest = bodyCenter(body).y
		runBody(body, [floor], 300) // run another 300 steps
		// Center did not keep descending (settled, not slowly sinking through).
		expect(bodyCenter(body).y).toBeLessThan(yAtRest + 1)
		// Velocity has decayed to near zero (no latent energy pumping the rig).
		expect(Math.hypot(bodyVelocity(body, DT).x, bodyVelocity(body, DT).y)).toBeLessThan(5)
		// Mast still above the runner (upright, not inverted/collapsed).
		expect(body.points[MAST].pos.y).toBeLessThan(midY)
		expect(body.crashed).toBe(false)
		// Constraints held within tolerance of rest length.
		const rest = makeBody({ x: 0, y: -40 }).constraints.map((c) => c.rest)
		body.constraints.forEach((c, idx) => {
			const len = Math.hypot(
				body.points[c.i].pos.x - body.points[c.j].pos.x,
				body.points[c.i].pos.y - body.points[c.j].pos.y
			)
			expect(Math.abs(len - rest[idx]) / rest[idx]).toBeLessThan(0.15)
		})
	})

	it('tracks the slope angle after settling on a sloped line', () => {
		// Lock-in for the applyUpright fix: after settling on a slope the runner must
		// align to the slope angle (it "tracks the slope"), not sit flat or tumble.
		// Long slope so the body stays on it for the whole window (a finite slope lets
		// it ride off the end and free-fall, which is correct but not what we measure).
		// Spawn ~70px above the surface so it lands gently and tracks, like the
		// existing "rides a slope" test (a harder drop spins out on landing).
		const slope: Segment = { a: { x: -600, y: -300 }, b: { x: 600, y: 300 } }
		const slopeAngle = Math.atan2(600, 1200)
		const body = makeBody({ x: -400, y: -270 }) // slope-y at x=-400 is -200
		runBody(body, [slope], 200)
		expect(body.crashed).toBe(false)
		expect(Math.abs(bodyAngle(body) - slopeAngle)).toBeLessThan(0.3)
	})

	it('crashes (ragdolls) when launched off a ramp and over-rotates', () => {
		// A steep UPWARD ramp flings the sled into the air; with no track under it
		// the rig over-rotates past the crash tilt and latches crashed (ragdoll).
		// (A flat-wall slam no longer crashes a body this size — the broad contact
		// radius arrests it without spinning it out — so we exercise the tilt path,
		// which is the realistic Line-Rider wipeout: over-rotating off a jump.)
		const ramp: Segment = { a: { x: -600, y: 0 }, b: { x: -200, y: -300 } }
		const body = makeBody({ x: -580, y: -20 })
		// Upright while still climbing the ramp (before it launches off the lip).
		runBody(body, [ramp], 15)
		expect(body.crashed).toBe(false)
		// After launching and tipping past vertical in the air, it latches crashed.
		runBody(body, [ramp], 100)
		expect(body.crashed).toBe(true)
	})

	it('a hard landing on a slope does not crash (settling spike is not a tumble)', () => {
		// Dropping onto a slope snaps the runner from flat to slope-aligned in a frame
		// or two — a brief spin spike. That transient must NOT latch a crash: only a
		// sustained spin does. (Regression guard: it used to crash on the landing.)
		const slope: Segment = { a: { x: -300, y: -150 }, b: { x: 300, y: 150 } }
		const body = makeBody({ x: -200, y: -170 }) // spawns above the slope, free-falls onto it
		runBody(body, [slope], 120)
		expect(body.crashed).toBe(false)
		// And it actually landed and is tracking the slope, not still falling.
		const slopeAngle = Math.atan2(300, 600)
		expect(Math.abs(bodyAngle(body) - slopeAngle)).toBeLessThan(0.3)
	})

	it('crash latches: once crashed it stays crashed', () => {
		const body = makeBody({ x: 0, y: 0 })
		body.crashed = true
		runBody(body, [{ a: { x: -1000, y: 50 }, b: { x: 1000, y: 50 } }], 200)
		expect(body.crashed).toBe(true)
	})
})

describe('physics: facing (which way the snail points)', () => {
	// Give a body point a velocity by back-dating its `prev` so (pos-prev)/dt === v.
	const setVel = (body: Body, i: number, vx: number, vy: number) => {
		const p = body.points[i]
		p.prev = { x: p.pos.x - vx * DT, y: p.pos.y - vy * DT }
	}

	// Rotate the runner about the body center so FRONT lands at a given angle
	// (radians, BACK->FRONT). Lets us test the runner's 180° ambiguity.
	const orientRunner = (body: Body, angle: number) => {
		const c = bodyCenter(body)
		const half = Math.hypot(
			body.points[FRONT].pos.x - body.points[BACK].pos.x,
			body.points[FRONT].pos.y - body.points[BACK].pos.y
		) / 2
		body.points[FRONT].pos = { x: c.x + Math.cos(angle) * half, y: c.y + Math.sin(angle) * half }
		body.points[BACK].pos = { x: c.x - Math.cos(angle) * half, y: c.y - Math.sin(angle) * half }
	}

	it('faces +1 when moving right, -1 when moving left (flat runner)', () => {
		const body = makeBody({ x: 0, y: 0 }) // flat, FRONT to the right (+x)
		setVel(body, BACK, 100, 0)
		setVel(body, FRONT, 100, 0)
		expect(bodyFacing(body, DT, 8, -1)).toBe(1) // overrides a stale hold

		setVel(body, BACK, -100, 0)
		setVel(body, FRONT, -100, 0)
		expect(bodyFacing(body, DT, 8, 1)).toBe(-1)
	})

	it('still faces travel when a tumble leaves FRONT on the left (180° runner)', () => {
		// FRONT now points left, but the snail still slides RIGHT down a ramp. The old
		// projection-onto-runner rule latched backward here; horizontal velocity wins.
		const body = makeBody({ x: 0, y: 0 })
		orientRunner(body, Math.PI) // FRONT to the left, cos(angle) < 0
		setVel(body, BACK, 100, 0) // moving right
		setVel(body, FRONT, 100, 0)
		expect(bodyFacing(body, DT, 8, -1)).toBe(-1) // sign(vx)+ * sign(cos)- = -1
	})

	it('holds the previous facing inside the dead-band', () => {
		const body = makeBody({ x: 0, y: 0 })
		setVel(body, BACK, 2, 0) // 2 px/s horizontal, below the 8 px/s dead-band
		setVel(body, FRONT, 2, 0)
		expect(bodyFacing(body, DT, 8, 1)).toBe(1)
		expect(bodyFacing(body, DT, 8, -1)).toBe(-1)
	})

	it('holds facing on a near-vertical runner (degenerate horizontal facing)', () => {
		const body = makeBody({ x: 0, y: 0 })
		orientRunner(body, Math.PI / 2) // runner straight up/down, cos(angle) ~ 0
		setVel(body, BACK, 0, 200) // dropping fast, no horizontal component
		setVel(body, FRONT, 0, 200)
		expect(bodyFacing(body, DT, 8, 1)).toBe(1)
		expect(bodyFacing(body, DT, 8, -1)).toBe(-1)
	})

	it('holds facing on a steep (~88deg) near-vertical runner instead of flipping', () => {
		// The runner is nearly vertical (cos(angle) tiny but nonzero). With the old
		// EPSILON guard the tiny cos sign still flipped the facing; with the
		// facingVerticalCos tunable the near-edge-on art HOLDS rather than snapping.
		const angle = (88 * Math.PI) / 180 // ~88deg, cos ~ +0.035 (well under threshold)
		const body = makeBody({ x: 0, y: 0 })
		orientRunner(body, angle)
		setVel(body, BACK, 100, 0) // moving right; sign(vx)=+, sign(cos)=+ would give +1
		setVel(body, FRONT, 100, 0)
		// Held at the previous value rather than snapping on the tiny cos sign.
		expect(bodyFacing(body, DT, 8, -1)).toBe(-1)
		expect(bodyFacing(body, DT, 8, 1)).toBe(1)
	})

	it('ignores the mast: its wobble cannot flip the facing at low speed', () => {
		// Runner crawls right; the mast swings hard left on its spring. A whole-body
		// mean would read leftward; the runner-only velocity stays rightward.
		const body = makeBody({ x: 0, y: 0 })
		setVel(body, BACK, 10, 0)
		setVel(body, FRONT, 10, 0)
		setVel(body, MAST, -500, 0)
		expect(bodyFacing(body, DT, 8, -1)).toBe(1)
	})
})
