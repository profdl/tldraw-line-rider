// Checkpoint scoring. A checkpoint is a page-space axis-aligned box; the sled
// "collects" it the first time its position lands inside the box during a run.
// This module is pure (no tldraw / framework deps) so the crossing logic stays
// unit-testable, mirroring physics.ts. tldraw note shapes are turned into these
// boxes in geometry.ts.

import type { Vec2 } from './physics'

/** A page-space axis-aligned checkpoint region. */
export interface Checkpoint {
	/** Stable id (the source shape id) used to track which are collected. */
	id: string
	minX: number
	minY: number
	maxX: number
	maxY: number
}

/** True when point `p` lies within checkpoint `c`'s box (inclusive). */
export function pointInCheckpoint(p: Vec2, c: Checkpoint): boolean {
	return p.x >= c.minX && p.x <= c.maxX && p.y >= c.minY && p.y <= c.maxY
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
