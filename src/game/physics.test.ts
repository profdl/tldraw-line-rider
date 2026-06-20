import { describe, it, expect } from 'vitest'
import { makeRider, step, velocity, PHYSICS, type Segment } from './physics'

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
		// Settled: not still accelerating downward through the floor.
		expect(v.y).toBeLessThan(50)
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
})
