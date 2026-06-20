// Lightweight Line Rider physics: a point-mass "sled" under gravity that
// collides against a set of static line segments. Uses Verlet integration
// (position-based) which is stable and simple for this kind of sim.

export interface Vec2 {
	x: number
	y: number
}

/** A line segment in world (page) space that the sled can ride on. */
export interface Segment {
	a: Vec2
	b: Vec2
}

/** Tunable constants. Units are page-pixels and seconds. */
export const PHYSICS = {
	gravity: 1800, // px/s^2, pulls the sled down
	friction: 0.999, // velocity retained per step along free fall
	restitution: 0.0, // 0 = no bounce off lines (classic Line Rider feel)
	surfaceFriction: 0.0015, // tangential drag when riding a line (Line Rider lines are near-frictionless)
	riderRadius: 6, // collision radius of the sled point
	maxSpeed: 4000, // clamp to avoid tunneling/explosions
}

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
 * Advance the rider by one fixed timestep. Mutates and returns `state`.
 * Resolves collisions against every segment by projecting the rider out of
 * the line and reflecting/damping the velocity component into the surface.
 */
export function step(state: RiderState, segments: Segment[], dt: number): RiderState {
	// --- Verlet integration with gravity ---
	const vx = (state.pos.x - state.prev.x) * PHYSICS.friction
	const vy = (state.pos.y - state.prev.y) * PHYSICS.friction

	state.prev.x = state.pos.x
	state.prev.y = state.pos.y

	state.pos.x += vx
	state.pos.y += vy + PHYSICS.gravity * dt * dt

	// --- Collision resolution (iterate for stability) ---
	const r = PHYSICS.riderRadius
	for (let iter = 0; iter < 2; iter++) {
		for (const seg of segments) {
			const { point } = closestPointOnSegment(state.pos, seg.a, seg.b)
			const diff = sub(state.pos, point)
			const dist = len(diff)
			if (dist < r && dist > 1e-6) {
				// Surface normal pointing from line toward the rider.
				const nx = diff.x / dist
				const ny = diff.y / dist
				const penetration = r - dist

				// Push the rider out along the normal.
				state.pos.x += nx * penetration
				state.pos.y += ny * penetration

				// Remove the velocity component into the surface (+ optional bounce),
				// and apply tangential friction so the sled "rides" the line.
				let vX = state.pos.x - state.prev.x
				let vY = state.pos.y - state.prev.y
				const vn = vX * nx + vY * ny // velocity along normal
				if (vn < 0) {
					vX -= (1 + PHYSICS.restitution) * vn * nx
					vY -= (1 + PHYSICS.restitution) * vn * ny
				}
				// Tangential component damping (surface friction).
				const tX = vX - (vX * nx + vY * ny) * nx
				const tY = vY - (vX * nx + vY * ny) * ny
				vX -= tX * PHYSICS.surfaceFriction
				vY -= tY * PHYSICS.surfaceFriction

				state.prev.x = state.pos.x - vX
				state.prev.y = state.pos.y - vY
			}
		}
	}

	// --- Speed clamp ---
	const sx = state.pos.x - state.prev.x
	const sy = state.pos.y - state.prev.y
	const speed = Math.hypot(sx, sy) / dt
	if (speed > PHYSICS.maxSpeed) {
		const scale = (PHYSICS.maxSpeed * dt) / Math.hypot(sx, sy)
		state.prev.x = state.pos.x - sx * scale
		state.prev.y = state.pos.y - sy * scale
	}

	return state
}

/** Current velocity (px/s) derived from Verlet positions. */
export function velocity(state: RiderState, dt: number): Vec2 {
	return {
		x: (state.pos.x - state.prev.x) / dt,
		y: (state.pos.y - state.prev.y) / dt,
	}
}
