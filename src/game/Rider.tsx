import { useEffect, useRef } from 'react'
import { useEditor, toDomPrecision } from 'tldraw'
import { makeRider, step, velocity, PHYSICS, type Vec2 } from './physics'
import { collectSegments, collectCheckpoints } from './geometry'
import { collectCheckpointHits, type Checkpoint } from './checkpoints'

const FIXED_DT = 1 / 120 // physics substep (s)
const STATS_EVERY = 4 // throttle React stat updates to every Nth frame
// Sled is drawn at its physics collision diameter so visuals match collisions.
const SLED_DIAMETER = PHYSICS.riderRadius * 2

// Fraction of the gap to the sled the camera closes each frame while following.
// Low enough to glide smoothly, high enough to keep a fast sled on screen.
const CAMERA_FOLLOW_LERP = 0.12

interface RiderProps {
	playing: boolean
	follow: boolean
	startPoint: Vec2
	onStats: (distance: number, speed: number) => void
	/** Reports checkpoint progress: how many of `total` flags collected this run. */
	onScore: (collected: number, total: number) => void
}

// The sled overlay. Rendered via components.InFrontOfTheCanvas. A single rAF
// loop runs continuously: while playing it advances the physics; in all states
// it positions the sled by recomputing editor.pageToScreen() each frame, so the
// sled stays glued to the canvas under pan / zoom / resize without any
// per-frame React re-render (we write the DOM transform imperatively).
export function Rider({ playing, follow, startPoint, onStats, onScore }: RiderProps) {
	const editor = useEditor()
	const elRef = useRef<HTMLDivElement | null>(null)
	const stateRef = useRef(makeRider(startPoint))
	const startRef = useRef(startPoint)

	// Keep the latest props in refs so the long-lived rAF loop never goes stale.
	// Sync in effects (not during render) so React 19 / StrictMode is happy.
	const playingRef = useRef(playing)
	const followRef = useRef(follow)
	const onStatsRef = useRef(onStats)
	const onScoreRef = useRef(onScore)
	useEffect(() => {
		playingRef.current = playing
	}, [playing])
	useEffect(() => {
		followRef.current = follow
	}, [follow])
	useEffect(() => {
		onStatsRef.current = onStats
	}, [onStats])
	useEffect(() => {
		onScoreRef.current = onScore
	}, [onScore])

	// Snap the sled to the start point whenever the start point moves (so "set
	// start here" gives immediate feedback even while stopped), and re-seat it at
	// the start whenever a run begins. Stopping is intentionally NOT a reset, so
	// the sled holds its final resting position for inspection.
	useEffect(() => {
		startRef.current = startPoint
		stateRef.current = makeRider(startPoint)
	}, [startPoint])

	useEffect(() => {
		if (playing) stateRef.current = makeRider(startRef.current)
	}, [playing])

	useEffect(() => {
		let raf = 0
		let last = performance.now()
		let acc = 0
		let frameCount = 0
		let segments = collectSegments(editor)
		let checkpoints: Checkpoint[] = collectCheckpoints(editor)
		// Ids collected this run; reset when a run begins so flags re-arm.
		let collected = new Set<string>()

		// Re-snapshot collision geometry each time a run begins.
		let wasPlaying = false

		const tick = (now: number) => {
			const isPlaying = playingRef.current
			if (isPlaying && !wasPlaying) {
				segments = collectSegments(editor)
				checkpoints = collectCheckpoints(editor)
				collected = new Set<string>()
				onScoreRef.current(0, checkpoints.length)
				last = now
				acc = 0
				frameCount = 0 // restart stats cadence so the first run frame samples predictably
			}
			wasPlaying = isPlaying

			if (isPlaying) {
				let frame = (now - last) / 1000
				last = now
				if (frame > 0.05) frame = 0.05 // avoid spiral-of-death after tab blur
				acc += frame
				let scored = false
				while (acc >= FIXED_DT) {
					step(stateRef.current, segments, FIXED_DT)
					// Test checkpoints per substep so a fast sled can't tunnel past a
					// flag between rendered frames. collectCheckpointHits mutates
					// `collected` so each flag scores once.
					if (checkpoints.length > 0) {
						const hits = collectCheckpointHits(stateRef.current.pos, checkpoints, collected)
						if (hits.length > 0) scored = true
					}
					acc -= FIXED_DT
				}
				if (scored) onScoreRef.current(collected.size, checkpoints.length)
				if (++frameCount % STATS_EVERY === 0) {
					const p = stateRef.current.pos
					const d = Math.hypot(p.x - startRef.current.x, p.y - startRef.current.y)
					const v = velocity(stateRef.current, FIXED_DT)
					onStatsRef.current(d, Math.hypot(v.x, v.y))
				}

				// Camera follow: ease the viewport center toward the sled so a fast
				// ride stays on screen. Lerping (not snapping) avoids a jarring lock,
				// and skipping when already close avoids fighting a settled sled with
				// sub-pixel camera nudges. history:'ignore' keeps it off the undo
				// stack; the camera move must not be an undoable edit.
				if (followRef.current) {
					const center = editor.getViewportPageBounds().center
					const p = stateRef.current.pos
					const dx = p.x - center.x
					const dy = p.y - center.y
					if (Math.hypot(dx, dy) > 1) {
						// Ease the viewport center a fraction of the way to the sled.
						const target = {
							x: center.x + dx * CAMERA_FOLLOW_LERP,
							y: center.y + dy * CAMERA_FOLLOW_LERP,
						}
						editor.run(() => editor.centerOnPoint(target), { history: 'ignore' })
					}
				}
			} else {
				last = now // keep timebase fresh while paused
			}

			// Position the sled. pageToScreen reads live camera + screenBounds,
			// so this is correct under pan/zoom/resize in every state.
			const el = elRef.current
			if (el) {
				const s = editor.pageToScreen(stateRef.current.pos)
				const z = editor.getCamera().z
				const size = SLED_DIAMETER * z
				el.style.transform = `translate(${toDomPrecision(s.x)}px, ${toDomPrecision(s.y)}px)`
				el.style.width = `${size}px`
				el.style.height = `${size}px`
				el.style.marginLeft = `${-size / 2}px`
				el.style.marginTop = `${-size / 2}px`
			}

			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [editor])

	// Static appearance lives in App.css (.lr-sled); the rAF loop only writes the
	// dynamic transform/size. Initial size is set so the first paint isn't 0×0.
	return (
		<div
			ref={elRef}
			className="lr-sled"
			style={{ width: SLED_DIAMETER, height: SLED_DIAMETER, marginLeft: -SLED_DIAMETER / 2, marginTop: -SLED_DIAMETER / 2 }}
		/>
	)
}
