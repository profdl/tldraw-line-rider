// Run lifecycle + per-substep stepping for the sled, extracted from Rider's rAF
// loop so the gameplay state machine is one cohesive, testable unit (the loop
// itself is DOM-bound and untestable in node; this is pure of React/tldraw).
//
// It owns the cross-frame gameplay state that used to be loose vars in the tick
// closure: the sled body, the frozen-at-run-start collision snapshot, the set of
// checkpoints collected this run, the facing sign, and the run/reset edge
// tracking. The Rider feeds it a `TrackSource` (the editor-bound reactive views)
// and the current input atoms each frame; the controller decides when to re-seat
// the body, snapshots the track at run start, and advances the physics.
//
// Pure of React/tldraw so the lifecycle (begin / reset / score / facing) can be
// unit-tested with a stub TrackSource — see runController.test.ts.

import {
	makeBody,
	stepBody,
	bodyCenter,
	bodyFacing,
	PHYSICS,
	type Body,
	type ContactEvent,
} from './physics'
import { collectCheckpointHits, type Checkpoint } from './checkpoints'
import type { TrackSegment } from './geometry'
import type { Vec2 } from './physics'
import type { GameMode } from './state'

// Half-width of the implicit ground plane injected in side mode, page px. Wide
// enough that a run never reaches its end (kept finite, not infinite, so
// sweptContact's span/corner logic stays well-defined — see the physics module).
const SIDE_GROUND_HALF_WIDTH = 100_000

/**
 * The track the controller rides, as the two reactive views the Rider already
 * builds (makeSegmentsComputed / makeCheckpointsComputed). Abstracted to this
 * minimal shape so the controller never imports tldraw and can be driven by a
 * stub in tests. `.get()` recomputes only when shapes change.
 */
export interface TrackSource {
	segments(): TrackSegment[]
	checkpoints(): Checkpoint[]
}

/** Inputs the rAF loop reads from atoms and hands to the controller each frame. */
export interface RunInputs {
	playing: boolean
	start: Vec2
	/** Reset nonce; a change re-seats the body even if `start` didn't move. */
	resetNonce: number
	/** Play style. 'side' adds forward thrust + an implicit ground plane. */
	mode: GameMode
}

/** What a fixed substep produced, for the loop's audio / scoring wiring. */
export interface SubstepResult {
	/** Contacts the sim reported this substep (the same array the loop passed in). */
	contacts: ContactEvent[]
	/** True when at least one new checkpoint scored this substep. */
	scored: boolean
}

/**
 * Owns the sled body and run lifecycle. Construct once per Rider mount with the
 * editor-bound TrackSource; the loop calls sync() once per frame, then beginRun()
 * fires implicitly inside it on the play edge. The body and collision snapshot
 * are exposed via getters for the loop's rendering / audio.
 */
export class RunController {
	private readonly track: TrackSource
	private body: Body
	// Collision snapshot frozen at run start so a mid-run edit can't change what
	// the sled hits (the track is read-only while playing; this defends it anyway).
	private segments: TrackSegment[] = []
	private checkpoints: Checkpoint[] = []
	// Checkpoint ids scored this run; reset when a run begins so flags re-arm.
	private collected = new Set<string>()
	// Horizontal facing of the art: +1 as-authored, -1 mirrored. Held across
	// frames (bodyFacing applies a dead-band) and reset to +1 with the body.
	private facingX: 1 | -1 = 1

	// The play style + spawn point frozen for the current run. Captured on the play
	// edge (with the track snapshot) so mode/ground can't change mid-run, matching
	// how the collision snapshot is frozen. `runStart` places the side-mode ground.
	private runMode: GameMode = 'line'
	private runStart: Vec2

	// Edge tracking so we only re-seat / snapshot on a transition, not every frame.
	private wasPlaying = false
	private lastStart: Vec2
	private lastReset: number
	// True once a run has begun and not yet been reset. Distinguishes the first
	// play (start fresh from the spawn point) from resuming after a pause (continue
	// the existing body). A reset / start-move clears it so the next play begins anew.
	private runActive = false

	constructor(track: TrackSource, inputs: RunInputs) {
		this.track = track
		this.body = makeBody(inputs.start)
		this.runStart = inputs.start
		this.lastStart = inputs.start
		this.lastReset = inputs.resetNonce
	}

	get currentBody(): Body {
		return this.body
	}

	/** The collision snapshot the sim is (or last) running against. */
	get currentSegments(): TrackSegment[] {
		return this.segments
	}

	/**
	 * The spawn point frozen for the current run. In side mode the implicit ground
	 * plane sits at this Y, so the Rider draws the visible ground line here during a
	 * run (matching the collision snapshot); while stopped it draws at the live
	 * start instead.
	 */
	get currentStart(): Vec2 {
		return this.runStart
	}

	get currentCheckpoints(): Checkpoint[] {
		return this.checkpoints
	}

	get collectedCount(): number {
		return this.collected.size
	}

	get facing(): 1 | -1 {
		return this.facingX
	}

	/**
	 * Reconcile against this frame's inputs BEFORE stepping. Re-seats the body when
	 * the start point moves or the reset nonce bumps (immediate feedback even while
	 * stopped, and it ends any active run so the next play starts fresh). Snapshots
	 * the track + clears run state only on the FIRST play of a run; a play edge while
	 * a run is already active is a resume (pause -> continue) and leaves the body be.
	 * Returns a discriminated outcome so the loop can react (clear telemetry on a
	 * re-seat; resume audio + publish the fresh score on a run start).
	 */
	sync(inputs: RunInputs): { reseated: boolean; runStarted: boolean } {
		let reseated = false
		if (inputs.start !== this.lastStart || inputs.resetNonce !== this.lastReset) {
			this.lastStart = inputs.start
			this.lastReset = inputs.resetNonce
			this.reseat(inputs.start)
			this.runActive = false
			reseated = true
		}

		// Begin a run only on the first play after a reset/start-move. Toggling play
		// off then on while a run is active resumes it — no re-seat.
		let runStarted = false
		if (inputs.playing && !this.wasPlaying && !this.runActive) {
			this.beginRun(inputs.start, inputs.mode)
			this.runActive = true
			runStarted = true
		} else if (inputs.playing && !this.wasPlaying) {
			// Resume after a pause: the body continues where it left off, but mode +
			// the track are editable while paused (App drops read-only on pause), so a
			// shape moved/rotated/recolored — or a mode switch — mid-pause would leave
			// the frozen snapshot stale (the sled would collide against the OLD
			// geometry — the rotated-shape glitch). Re-freeze mode + the snapshot from
			// the live inputs on every play edge so resume picks up any edits, without
			// disturbing the body.
			this.runMode = inputs.mode
			this.snapshotTrack()
		}
		this.wasPlaying = inputs.playing

		return { reseated, runStarted }
	}

	/** Rebuild the body at `start`, facing +x; does not touch the track snapshot. */
	private reseat(start: Vec2): void {
		this.body = makeBody(start)
		this.facingX = 1
	}

	/**
	 * A run begins: capture the play mode + spawn, re-seat at the start, and freeze
	 * the current track as this run's collision + checkpoint snapshot, re-arming all
	 * flags. Mode/start are frozen here (and re-frozen on resume) so they can't
	 * change mid-run, matching the collision snapshot.
	 */
	private beginRun(start: Vec2, mode: GameMode): void {
		this.runMode = mode
		this.runStart = start
		this.reseat(start)
		this.snapshotTrack()
		this.collected = new Set<string>()
	}

	/**
	 * Freeze the live track as this run's collision + checkpoint snapshot. The sim
	 * runs against this frozen copy (the canvas is read-only while playing). Called
	 * at run start AND on resume after a pause, so edits made while paused (e.g.
	 * rotating a shape) take effect rather than leaving the sled colliding against
	 * stale geometry. Does not touch `collected`, so a resume keeps scored flags.
	 *
	 * In 'side' mode this also appends the implicit ground plane — one wide
	 * horizontal solid segment at the spawn's Y — so the character starts on the
	 * ground and ramps drawn above it launch via the same collision path. Rebuilt
	 * from `runStart` here, so moving the start (which re-freezes on the next play)
	 * moves the ground with it.
	 */
	private snapshotTrack(): void {
		this.segments = this.track.segments()
		this.checkpoints = this.track.checkpoints()
		if (this.runMode === 'side') {
			const y = this.runStart.y
			this.segments = [
				...this.segments,
				{
					a: { x: this.runStart.x - SIDE_GROUND_HALF_WIDTH, y },
					b: { x: this.runStart.x + SIDE_GROUND_HALF_WIDTH, y },
					kind: 'solid',
					strength: 1,
				},
			]
		}
	}

	/**
	 * Advance the sled one fixed substep against the frozen snapshot, then test the
	 * body center against the checkpoints (per substep so a fast sled can't tunnel
	 * past a flag between rendered frames). `contacts` is the caller's reused buffer
	 * (cleared here) so the loop stays allocation-free; the sim fills it and it's
	 * returned for the loop's audio diffing.
	 */
	stepFixed(dt: number, contacts: ContactEvent[]): SubstepResult {
		contacts.length = 0
		// Side mode drives the body with constant forward thrust (grounded-only, see
		// stepBody); line mode omits opts so the classic gravity-only sled is
		// byte-identical.
		const opts =
			this.runMode === 'side'
				? { thrust: PHYSICS.sideThrust, cruise: PHYSICS.sideCruiseSpeed }
				: undefined
		stepBody(this.body, this.segments, dt, contacts, opts)

		let scored = false
		if (this.checkpoints.length > 0) {
			const hits = collectCheckpointHits(bodyCenter(this.body), this.checkpoints, this.collected)
			if (hits.length > 0) scored = true
		}
		return { contacts, scored }
	}

	/**
	 * Update and return the art's horizontal facing from the runner's motion. Held
	 * while crashed (a ragdoll has no meaningful "forward") and inside the speed
	 * dead-band, so a slow/stationary snail doesn't strobe.
	 */
	updateFacing(dt: number, deadband: number): 1 | -1 {
		if (!this.body.crashed) {
			this.facingX = bodyFacing(this.body, dt, deadband, this.facingX)
		}
		return this.facingX
	}
}
