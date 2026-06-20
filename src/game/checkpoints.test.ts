import { describe, it, expect } from 'vitest'
import {
	pointInCheckpoint,
	collectCheckpointHits,
	makeCheckpoint,
	type Checkpoint,
} from './checkpoints'

// Build an axis-aligned checkpoint from min/max corners (rotation 0).
const box = (id: string, minX: number, minY: number, maxX: number, maxY: number): Checkpoint => ({
	id,
	cx: (minX + maxX) / 2,
	cy: (minY + maxY) / 2,
	halfW: (maxX - minX) / 2,
	halfH: (maxY - minY) / 2,
	rotation: 0,
})

describe('checkpoints: pointInCheckpoint', () => {
	const c = box('a', 0, 0, 10, 10)

	it('is inside for a point within the box', () => {
		expect(pointInCheckpoint({ x: 5, y: 5 }, c)).toBe(true)
	})

	it('includes the boundary', () => {
		expect(pointInCheckpoint({ x: 0, y: 10 }, c)).toBe(true)
	})

	it('is outside beyond the box', () => {
		expect(pointInCheckpoint({ x: 11, y: 5 }, c)).toBe(false)
	})
})

describe('checkpoints: rotated boxes', () => {
	// A 20x20 box centered at the origin, rotated 45°. Its corners reach out to
	// ~±14.1 along the axes (half-diagonal = 10*sqrt(2)), but the box's own
	// footprint near an axis corner is empty — an axis-aligned test would wrongly
	// score there.
	const rotated: Checkpoint = { id: 'r', cx: 0, cy: 0, halfW: 10, halfH: 10, rotation: Math.PI / 4 }

	it('scores a point at the rotated box center', () => {
		expect(pointInCheckpoint({ x: 0, y: 0 }, rotated)).toBe(true)
	})

	it('scores a point along the rotated diagonal (a real corner)', () => {
		// The +x axis is a diagonal of the rotated box; its corner sits at ~14.1.
		expect(pointInCheckpoint({ x: 13, y: 0 }, rotated)).toBe(true)
	})

	it('does NOT score a point that only an axis-aligned bbox would catch', () => {
		// (9.5, 9.5) is inside the 45°-rotated box's AABB (which spans ±14.1) but
		// outside the box itself — distance along each box axis exceeds 10.
		expect(pointInCheckpoint({ x: 9.5, y: 9.5 }, rotated)).toBe(false)
	})
})

describe('checkpoints: makeCheckpoint (oriented-box construction)', () => {
	// These pin the rotation/scale math in the construction path — the part that
	// reads the note's local bounds + decomposed page transform. Inputs here are
	// exactly what geometry.ts feeds in (center in page space, local bounds, the
	// decomposed scaleX/scaleY/rotation), so this covers that math without a live
	// editor.
	const localBounds = { w: 20, h: 20 }

	it('un-rotated, unit-scale box matches the old axis-aligned bbox semantics', () => {
		// A note at page center (50,50), 20x20, no rotation/scale. The old code
		// stored {minX:40,minY:40,maxX:60,maxY:60}; the oriented box must score the
		// same points — including the exact AABB boundary corners.
		const c = makeCheckpoint('n', { x: 50, y: 50 }, localBounds, 1, 1, 0)
		expect(c).toMatchObject({ cx: 50, cy: 50, halfW: 10, halfH: 10, rotation: 0 })
		// Interior, all four boundary corners (inclusive), and just-outside.
		expect(pointInCheckpoint({ x: 50, y: 50 }, c)).toBe(true)
		expect(pointInCheckpoint({ x: 40, y: 40 }, c)).toBe(true)
		expect(pointInCheckpoint({ x: 60, y: 60 }, c)).toBe(true)
		expect(pointInCheckpoint({ x: 40, y: 60 }, c)).toBe(true)
		expect(pointInCheckpoint({ x: 60, y: 40 }, c)).toBe(true)
		expect(pointInCheckpoint({ x: 60.01, y: 50 }, c)).toBe(false)
	})

	it('scale inflates the half-extents to the on-page footprint', () => {
		// A 20x20 local box drawn at 1.5x scale covers ±15 on each axis.
		const c = makeCheckpoint('n', { x: 0, y: 0 }, localBounds, 1.5, 1.5, 0)
		expect(c.halfW).toBeCloseTo(15)
		expect(c.halfH).toBeCloseTo(15)
		expect(pointInCheckpoint({ x: 14.9, y: 0 }, c)).toBe(true)
		expect(pointInCheckpoint({ x: 15.1, y: 0 }, c)).toBe(false)
	})

	it('non-uniform scale produces independent half-extents', () => {
		const c = makeCheckpoint('n', { x: 0, y: 0 }, localBounds, 2, 0.5, 0)
		expect(c.halfW).toBeCloseTo(20) // 10 * 2
		expect(c.halfH).toBeCloseTo(5) //  10 * 0.5
	})

	it('negative (mirrored) scale normalizes to a positive extent', () => {
		// A mirrored note must still have a positive catch region of the same size
		// — Math.abs(scale). Without the abs, halfW/halfH would go negative and the
		// box would never score anything.
		const c = makeCheckpoint('n', { x: 0, y: 0 }, localBounds, -1, -1, 0)
		expect(c.halfW).toBeCloseTo(10)
		expect(c.halfH).toBeCloseTo(10)
		expect(pointInCheckpoint({ x: 0, y: 0 }, c)).toBe(true)
		expect(pointInCheckpoint({ x: 9, y: 9 }, c)).toBe(true)
	})

	it('carries rotation through so the box axes follow the note', () => {
		const c = makeCheckpoint('n', { x: 0, y: 0 }, localBounds, 1, 1, Math.PI / 4)
		expect(c.rotation).toBeCloseTo(Math.PI / 4)
		// A point along the rotated diagonal scores; a point only the AABB would
		// catch does not (mirrors the rotated-box suite above).
		expect(pointInCheckpoint({ x: 13, y: 0 }, c)).toBe(true)
		expect(pointInCheckpoint({ x: 9.5, y: 9.5 }, c)).toBe(false)
	})
})

describe('checkpoints: collectCheckpointHits', () => {
	const checkpoints = [box('a', 0, 0, 10, 10), box('b', 100, 0, 110, 10)]

	it('scores a checkpoint the first time the sled enters it', () => {
		const collected = new Set<string>()
		const hits = collectCheckpointHits({ x: 5, y: 5 }, checkpoints, collected)
		expect(hits).toEqual(['a'])
		expect(collected.has('a')).toBe(true)
	})

	it('does not re-score an already-collected checkpoint', () => {
		const collected = new Set<string>(['a'])
		const hits = collectCheckpointHits({ x: 5, y: 5 }, checkpoints, collected)
		expect(hits).toEqual([])
	})

	it('scores nothing when the sled is outside every checkpoint', () => {
		const collected = new Set<string>()
		const hits = collectCheckpointHits({ x: 50, y: 50 }, checkpoints, collected)
		expect(hits).toEqual([])
		expect(collected.size).toBe(0)
	})

	it('accumulates distinct checkpoints across successive positions', () => {
		const collected = new Set<string>()
		collectCheckpointHits({ x: 5, y: 5 }, checkpoints, collected)
		collectCheckpointHits({ x: 105, y: 5 }, checkpoints, collected)
		expect(collected.size).toBe(2)
	})
})
