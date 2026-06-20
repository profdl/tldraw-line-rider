import { describe, it, expect } from 'vitest'
import { pointInCheckpoint, collectCheckpointHits, type Checkpoint } from './checkpoints'

const box = (id: string, minX: number, minY: number, maxX: number, maxY: number): Checkpoint => ({
	id,
	minX,
	minY,
	maxX,
	maxY,
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
