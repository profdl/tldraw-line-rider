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
	type Body,
	type ContactEvent,
} from './physics'
import { collectCheckpointHits, type Checkpoint } from './checkpoints'
import type { TrackSegment } from './geometry'
import type { Vec2 } from './physics'

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

	// Edge tracking so we only re-seat / snapshot on a transition, not every frame.
	private wasPlaying = false
	private lastStart: Vec2
	private lastReset: number

	constructor(track: TrackSource, inputs: RunInputs) {
		this.track = track
		this.body = makeBody(inputs.start)
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
	 * stopped), and snapshots the track + clears run state on the play edge.
	 * Returns a discriminated outcome so the loop can react (clear telemetry on a
	 * re-seat; resume audio + publish the fresh score on a run start).
	 */
	sync(inputs: RunInputs): { reseated: boolean; runStarted: boolean } {
		let reseated = false
		if (inputs.start !== this.lastStart || inputs.resetNonce !== this.lastReset) {
			this.lastStart = inputs.start
			this.lastReset = inputs.resetNonce
			this.reseat(inputs.start)
			reseated = true
		}

		let runStarted = false
		if (inputs.playing && !this.wasPlaying) {
			this.beginRun(inputs.start)
			runStarted = true
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
	 * A run begins: re-seat at the start and freeze the current track as this run's
	 * collision + checkpoint snapshot, re-arming all flags.
	 */
	private beginRun(start: Vec2): void {
		this.reseat(start)
		this.segments = this.track.segments()
		this.checkpoints = this.track.checkpoints()
		this.collected = new Set<string>()
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
		stepBody(this.body, this.segments, dt, contacts)

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
