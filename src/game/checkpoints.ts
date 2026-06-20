// Checkpoint scoring. A checkpoint is a page-space (possibly rotated) box; the
// sled "collects" it the first time its position lands inside the box during a
// run. This module is pure (no tldraw / framework deps) so the crossing logic
// stays unit-testable, mirroring physics.ts. tldraw note shapes are turned into
// these boxes in geometry.ts.

import type { Vec2 } from './physics'

/**
 * A checkpoint region: an oriented (possibly rotated) box in page space.
 * Stored as a center, half-extents, and rotation so a rotated note's catch
 * region matches the note's actual footprint rather than its inflated
 * axis-aligned bounding box.
 */
export interface Checkpoint {
	/** Stable id (the source shape id) used to track which are collected. */
	id: string
	/** Box center in page space. */
	cx: number
	cy: number
	/** Half-width and half-height along the box's own (unrotated) axes. */
	halfW: number
	halfH: number
	/** Box rotation in radians (matches the source shape's page rotation). */
	rotation: number
}

/**
 * Build a checkpoint's oriented box from a source shape's LOCAL bounds and its
 * page transform's decomposed scale/rotation plus its page-space center. Pure
 * (the editor-coupled extraction lives in geometry.ts) so the rotation/scale
 * math is unit-testable.
 *
 * `halfW`/`halfH` come from the local half-extents scaled by |scale|, so a
 * scaled note's box matches its on-page footprint; `Math.abs` normalizes a
 * mirrored (negative-scale) note to a positive extent. `rotation` is taken
 * verbatim from the transform so the box's axes follow the note's.
 */
export function makeCheckpoint(
	id: string,
	center: Vec2,
	localBounds: { w: number; h: number },
	scaleX: number,
	scaleY: number,
	rotation: number
): Checkpoint {
	return {
		id,
		cx: center.x,
		cy: center.y,
		halfW: (localBounds.w / 2) * Math.abs(scaleX),
		halfH: (localBounds.h / 2) * Math.abs(scaleY),
		rotation,
	}
}

/** True when point `p` lies within checkpoint `c`'s oriented box (inclusive). */
export function pointInCheckpoint(p: Vec2, c: Checkpoint): boolean {
	// Translate into the box's local frame, then rotate by -rotation so the box
	// is axis-aligned, and compare against the half-extents.
	const dx = p.x - c.cx
	const dy = p.y - c.cy
	const cos = Math.cos(-c.rotation)
	const sin = Math.sin(-c.rotation)
	const localX = dx * cos - dy * sin
	const localY = dx * sin + dy * cos
	return Math.abs(localX) <= c.halfW && Math.abs(localY) <= c.halfH
}

/**
 * Given the sled position this step and the set of already-collected ids,
 * return the ids of checkpoints newly entered. Mutates `collected` to include
 * them so each checkpoint scores at most once per run.
 */
export function collectCheckpointHits(
	pos: Vec2,
	checkpoints: Checkpoint[],
	collected: Set<string>
): string[] {
	const hits: string[] = []
	for (const c of checkpoints) {
		if (collected.has(c.id)) continue
		if (pointInCheckpoint(pos, c)) {
			collected.add(c.id)
			hits.push(c.id)
		}
	}
	return hits
}
