import { describe, it, expect } from 'vitest'
import { RunController, type TrackSource, type RunInputs } from './runController'
import { bodyCenter, type ContactEvent } from './physics'
import type { TrackSegment } from './geometry'
import type { Checkpoint } from './checkpoints'

// A controllable stub for the editor-bound reactive views. Returns whatever
// arrays it's currently holding, so a test can change the "track" and assert the
// controller only snapshots it on a run start.
function stubTrack(
	segments: TrackSegment[] = [],
	checkpoints: Checkpoint[] = []
): TrackSource & { segments: () => TrackSegment[]; setSegments: (s: TrackSegment[]) => void; setCheckpoints: (c: Checkpoint[]) => void } {
	let segs = segments
	let cps = checkpoints
	return {
		segments: () => segs,
		checkpoints: () => cps,
		setSegments: (s) => { segs = s },
		setCheckpoints: (c) => { cps = c },
	}
}

const inputs = (over: Partial<RunInputs> = {}): RunInputs => ({
	playing: false,
	start: { x: 0, y: 0 },
	resetNonce: 0,
	...over,
})

// A flat solid floor a little below the spawn, so a played sled lands and rides
// rather than falling forever — keeps the body near a known region for scoring.
const floor: TrackSegment = { a: { x: -1000, y: 80 }, b: { x: 1000, y: 80 }, kind: 'solid' }

const flagAt = (id: string, x: number, y: number): Checkpoint => ({
	id, cx: x, cy: y, halfW: 60, halfH: 60, rotation: 0,
})

const DT = 1 / 120

describe('RunController: construction', () => {
	it('spawns the body at the start point, facing +x', () => {
		const c = new RunController(stubTrack(), inputs({ start: { x: 50, y: 20 } }))
		const center = bodyCenter(c.currentBody)
		// makeBody centers the rig on the spawn point (mast offset averages out only
		// partially, but center x equals spawn x by construction of the runner).
		expect(center.x).toBeCloseTo(50, 5)
		expect(c.facing).toBe(1)
		expect(c.currentBody.crashed).toBe(false)
	})
})

describe('RunController: re-seat on start / reset change', () => {
	it('rebuilds the body when the start point moves', () => {
		const c = new RunController(stubTrack(), inputs({ start: { x: 0, y: 0 } }))
		const out = c.sync(inputs({ start: { x: 200, y: 0 } }))
		expect(out.reseated).toBe(true)
		expect(out.runStarted).toBe(false)
		expect(bodyCenter(c.currentBody).x).toBeCloseTo(200, 5)
	})

	it('rebuilds the body when the reset nonce bumps, even if start is unchanged', () => {
		const start = { x: 10, y: 10 }
		const c = new RunController(stubTrack(), inputs({ start }))
		// Move it, then reset: a fresh body at the same start.
		const out = c.sync(inputs({ start, resetNonce: 1 }))
		expect(out.reseated).toBe(true)
		expect(bodyCenter(c.currentBody).x).toBeCloseTo(10, 5)
	})

	it('does not re-seat when nothing changed', () => {
		const start = { x: 0, y: 0 }
		const c = new RunController(stubTrack(), inputs({ start }))
		const out = c.sync(inputs({ start }))
		expect(out.reseated).toBe(false)
	})

	it('treats a same-VALUE but different-REFERENCE start as a change (identity compare)', () => {
		// The Rider compares atom values by identity (start !== lastStart); a new
		// object with equal coords still counts as a change. Pin that.
		const c = new RunController(stubTrack(), inputs({ start: { x: 0, y: 0 } }))
		const out = c.sync(inputs({ start: { x: 0, y: 0 } }))
		expect(out.reseated).toBe(true)
	})
})

describe('RunController: run start snapshots the track', () => {
	it('freezes segments + checkpoints at the play edge and re-arms flags', () => {
		const track = stubTrack([floor], [flagAt('f1', 0, 0)])
		const c = new RunController(track, inputs())
		const out = c.sync(inputs({ playing: true }))
		expect(out.runStarted).toBe(true)
		expect(c.currentSegments).toHaveLength(1)
		expect(c.currentCheckpoints).toHaveLength(1)
		expect(c.collectedCount).toBe(0)
	})

	it('ignores track edits made mid-run (snapshot is frozen at start)', () => {
		const track = stubTrack([floor], [])
		const c = new RunController(track, inputs())
		c.sync(inputs({ playing: true }))
		// Edit the track AFTER the run began.
		track.setSegments([floor, { a: { x: 0, y: 0 }, b: { x: 1, y: 1 }, kind: 'ice' }])
		// Still playing, no new edge: snapshot must not change.
		c.sync(inputs({ playing: true }))
		expect(c.currentSegments).toHaveLength(1)
	})

	it('re-snapshots on the next run start (after a reset)', () => {
		const start = { x: 0, y: 0 }
		const track = stubTrack([floor], [])
		const c = new RunController(track, inputs({ start }))
		c.sync(inputs({ start, playing: true }))
		c.sync(inputs({ start, playing: false })) // pause
		track.setCheckpoints([flagAt('f1', 0, 0)])
		// A reset between runs is what makes the next play a fresh run.
		c.sync(inputs({ start, playing: false, resetNonce: 1 }))
		c.sync(inputs({ start, playing: true, resetNonce: 1 })) // play again -> fresh snapshot
		expect(c.currentCheckpoints).toHaveLength(1)
	})

	it('fires runStarted only on the false->true edge, not every playing frame', () => {
		const c = new RunController(stubTrack([floor]), inputs())
		expect(c.sync(inputs({ playing: true })).runStarted).toBe(true)
		expect(c.sync(inputs({ playing: true })).runStarted).toBe(false)
	})
})

describe('RunController: pause / resume vs. restart', () => {
	// These tests thread ONE stable `start` object reference through every sync()
	// call: the controller treats a new-but-equal start object as a move (identity
	// compare, see the test above), which would spuriously re-seat and defeat the
	// pause/resume distinction we're pinning here. A reset is modelled by bumping
	// resetNonce while keeping the same start object.
	it('resumes the existing body on play after a pause (no re-seat, no new run)', () => {
		const start = { x: 0, y: 0 }
		const c = new RunController(stubTrack([floor]), inputs({ start }))
		c.sync(inputs({ start, playing: true })) // run begins
		// Advance the body so it has clearly moved off the spawn.
		for (let i = 0; i < 30; i++) c.stepFixed(DT, [])
		const movedY = bodyCenter(c.currentBody).y
		expect(movedY).toBeGreaterThan(0)

		c.sync(inputs({ start, playing: false })) // pause
		const resume = c.sync(inputs({ start, playing: true })) // play again
		// A resume is NOT a new run: the body keeps its advanced position.
		expect(resume.runStarted).toBe(false)
		expect(resume.reseated).toBe(false)
		expect(bodyCenter(c.currentBody).y).toBeCloseTo(movedY, 5)
	})

	it('does not re-snapshot the track on a pause/resume', () => {
		const start = { x: 0, y: 0 }
		const track = stubTrack([floor], [])
		const c = new RunController(track, inputs({ start }))
		c.sync(inputs({ start, playing: true })) // snapshot: no checkpoints
		c.sync(inputs({ start, playing: false })) // pause
		track.setCheckpoints([flagAt('f1', 0, 0)]) // edit while paused
		c.sync(inputs({ start, playing: true })) // resume — must keep the frozen snapshot
		expect(c.currentCheckpoints).toHaveLength(0)
	})

	it('starts over (re-seat + fresh run) when reset bumps between runs', () => {
		const start = { x: 0, y: 0 }
		const c = new RunController(stubTrack([floor]), inputs({ start }))
		const spawnY = bodyCenter(c.currentBody).y // freshly-built body's center-y
		c.sync(inputs({ start, playing: true }))
		for (let i = 0; i < 30; i++) c.stepFixed(DT, [])
		expect(bodyCenter(c.currentBody).y).toBeGreaterThan(spawnY)

		c.sync(inputs({ start, playing: false, resetNonce: 1 })) // Reset to start
		expect(bodyCenter(c.currentBody).y).toBeCloseTo(spawnY, 5) // re-seated at spawn
		const fresh = c.sync(inputs({ start, playing: true, resetNonce: 1 }))
		expect(fresh.runStarted).toBe(true) // a brand-new run
	})

	it('keeps resuming the same run across repeated pause/play with no reset', () => {
		const start = { x: 0, y: 0 }
		const c = new RunController(stubTrack([floor]), inputs({ start }))
		expect(c.sync(inputs({ start, playing: true })).runStarted).toBe(true) // first run
		c.sync(inputs({ start, playing: false }))
		expect(c.sync(inputs({ start, playing: true })).runStarted).toBe(false) // resume
		c.sync(inputs({ start, playing: false }))
		expect(c.sync(inputs({ start, playing: true })).runStarted).toBe(false) // resume again
	})
})

describe('RunController: stepping + scoring', () => {
	it('advances the body and clears the contacts buffer each substep', () => {
		const c = new RunController(stubTrack([floor]), inputs())
		c.sync(inputs({ playing: true }))
		const buf: ContactEvent[] = [{ kind: 'solid', strength: 1, speed: 0 }]
		const before = bodyCenter(c.currentBody).y
		const res = c.stepFixed(DT, buf)
		expect(res.contacts).toBe(buf) // same array returned (allocation-free)
		// Gravity pulls it down at least a hair in one substep.
		expect(bodyCenter(c.currentBody).y).toBeGreaterThan(before)
	})

	it('scores a checkpoint the body center sits inside, once', () => {
		// Flag right at the spawn so the body center is inside from step one.
		const track = stubTrack([floor], [flagAt('f1', 0, 0)])
		const c = new RunController(track, inputs({ start: { x: 0, y: 0 } }))
		c.sync(inputs({ playing: true }))
		const buf: ContactEvent[] = []
		const first = c.stepFixed(DT, buf)
		expect(first.scored).toBe(true)
		expect(c.collectedCount).toBe(1)
		// Already collected: a second step inside the same flag does not re-score.
		const second = c.stepFixed(DT, buf)
		expect(second.scored).toBe(false)
		expect(c.collectedCount).toBe(1)
	})

	it('does not score when there are no checkpoints', () => {
		const c = new RunController(stubTrack([floor]), inputs())
		c.sync(inputs({ playing: true }))
		expect(c.stepFixed(DT, []).scored).toBe(false)
	})

	it('re-arms a previously collected flag on the next run (after a reset)', () => {
		const start = { x: 0, y: 0 }
		const track = stubTrack([floor], [flagAt('f1', 0, 0)])
		const c = new RunController(track, inputs({ start }))
		c.sync(inputs({ start, playing: true }))
		c.stepFixed(DT, [])
		expect(c.collectedCount).toBe(1)
		c.sync(inputs({ start, playing: false, resetNonce: 1 })) // Reset to start
		c.sync(inputs({ start, playing: true, resetNonce: 1 })) // new run
		expect(c.collectedCount).toBe(0)
	})

	it('keeps the collected flags on a pause/resume (same run)', () => {
		const start = { x: 0, y: 0 }
		const track = stubTrack([floor], [flagAt('f1', 0, 0)])
		const c = new RunController(track, inputs({ start }))
		c.sync(inputs({ start, playing: true }))
		c.stepFixed(DT, [])
		expect(c.collectedCount).toBe(1)
		c.sync(inputs({ start, playing: false })) // pause
		c.sync(inputs({ start, playing: true })) // resume — same run, flag stays collected
		expect(c.collectedCount).toBe(1)
	})
})

describe('RunController: facing', () => {
	it('resets facing to +x on a re-seat', () => {
		const c = new RunController(stubTrack(), inputs())
		// Force a known facing then re-seat; it must come back to +1.
		c.sync(inputs({ start: { x: 5, y: 0 } }))
		expect(c.facing).toBe(1)
	})

	it('holds facing inside the speed dead-band', () => {
		const c = new RunController(stubTrack([floor]), inputs())
		c.sync(inputs({ playing: true }))
		// Huge dead-band: any motion is "too slow to flip", so facing holds at +1.
		expect(c.updateFacing(DT, 1e9)).toBe(1)
	})

	it('does not reorient while crashed', () => {
		const c = new RunController(stubTrack([floor]), inputs())
		c.sync(inputs({ playing: true }))
		c.currentBody.crashed = true
		// Even with a zero dead-band, a crashed body holds its facing.
		expect(c.updateFacing(DT, 0)).toBe(c.facing)
	})
})
