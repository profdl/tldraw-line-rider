// Shared gameplay state, held in tldraw atoms rather than React state.
//
// Why atoms and not props/React state: the rider overlay is mounted through
// <Tldraw>'s `components.InFrontOfTheCanvas`. tldraw remounts a slot whenever the
// `components` object identity changes, so that object must stay stable. If the
// volatile gameplay values (play/pause, follow, start point, live stats) rode in
// React state and threaded through `components`, every change would mint a new
// object and remount the rider — tearing down its rAF loop and snapping the sled
// to the start mid-ride. Routing them through atoms lets the App pass a constant
// `components` object: the rider reads inputs and writes outputs via these atoms,
// and the panel mirrors them reactively with useValue.

import { atom } from 'tldraw'
import type { Vec2 } from './physics'

/** Whether a run is in progress. */
export const playingAtom = atom('lr-playing', false)

/** Whether the camera eases to follow the sled while playing. */
export const followAtom = atom('lr-follow', true)

/** Whether surface sounds are muted. Off (audible) by default. */
export const mutedAtom = atom('lr-muted', false)

/**
 * Debug overlay: when on, the rider draws the collision geometry it actually
 * simulates — every collidable shape's page-space segments plus the sled rig's
 * per-point contact circles — so you can see what the physics "sees" vs. the
 * drawn art. Off by default.
 */
export const showCollisionsAtom = atom('lr-showCollisions', false)

/** Page-space point the sled spawns from at the start of a run. */
export const startPointAtom = atom<Vec2>('lr-startPoint', { x: 200, y: 100 })

/**
 * Monotonic counter the Reset button bumps to re-seat the sled at the start
 * point without moving the start itself. The rider re-builds its body whenever
 * this changes (and whenever startPointAtom changes); a counter — not a boolean —
 * so repeated resets to the same start still register as a change.
 */
export const resetNonceAtom = atom('lr-resetNonce', 0)

/** Live run telemetry the rider publishes for the panel. */
export const statsAtom = atom('lr-stats', { distance: 0, speed: 0 })

/** Checkpoint progress: how many of `total` flags collected this run. */
export const scoreAtom = atom('lr-score', { collected: 0, total: 0 })
