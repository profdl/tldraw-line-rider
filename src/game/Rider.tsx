import { useEffect, useRef } from 'react'
import { useEditor, toDomPrecision } from 'tldraw'
import { makeRider, step, velocity, type Vec2 } from './physics'
import { collectSegments } from './geometry'

const FIXED_DT = 1 / 120 // physics substep (s)
const STATS_EVERY = 4 // throttle React stat updates to every Nth frame

interface RiderProps {
	playing: boolean
	startPoint: Vec2
	onStats: (distance: number, speed: number) => void
}

// The sled overlay. Rendered via components.InFrontOfTheCanvas. A single rAF
// loop runs continuously: while playing it advances the physics; in all states
// it positions the sled by recomputing editor.pageToScreen() each frame, so the
// sled stays glued to the canvas under pan / zoom / resize without any
// per-frame React re-render (we write the DOM transform imperatively).
export function Rider({ playing, startPoint, onStats }: RiderProps) {
	const editor = useEditor()
	const elRef = useRef<HTMLDivElement | null>(null)
	const stateRef = useRef(makeRider(startPoint))
	const startRef = useRef(startPoint)

	// Keep the latest props in refs so the long-lived rAF loop never goes stale.
	const playingRef = useRef(playing)
	const onStatsRef = useRef(onStats)
	playingRef.current = playing
	onStatsRef.current = onStats

	// Reset the sim whenever play starts or the start point moves.
	useEffect(() => {
		stateRef.current = makeRider(startPoint)
		startRef.current = startPoint
	}, [playing, startPoint.x, startPoint.y])

	useEffect(() => {
		let raf = 0
		let last = performance.now()
		let acc = 0
		let frameCount = 0
		let segments = collectSegments(editor)

		// Re-snapshot collision geometry each time a run begins.
		let wasPlaying = false

		const tick = (now: number) => {
			const isPlaying = playingRef.current
			if (isPlaying && !wasPlaying) {
				segments = collectSegments(editor)
				last = now
				acc = 0
			}
			wasPlaying = isPlaying

			if (isPlaying) {
				let frame = (now - last) / 1000
				last = now
				if (frame > 0.05) frame = 0.05 // avoid spiral-of-death after tab blur
				acc += frame
				while (acc >= FIXED_DT) {
					step(stateRef.current, segments, FIXED_DT)
					acc -= FIXED_DT
				}
				if (++frameCount % STATS_EVERY === 0) {
					const p = stateRef.current.pos
					const d = Math.hypot(p.x - startRef.current.x, p.y - startRef.current.y)
					const v = velocity(stateRef.current, FIXED_DT)
					onStatsRef.current(d, Math.hypot(v.x, v.y))
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
				const size = 16 * z
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

	return (
		<div
			ref={elRef}
			style={{
				position: 'absolute',
				left: 0,
				top: 0,
				width: 16,
				height: 16,
				marginLeft: -8,
				marginTop: -8,
				borderRadius: '50%',
				background: '#4263eb',
				boxShadow: '0 0 0 3px rgba(66,99,235,0.25)',
				pointerEvents: 'none',
				zIndex: 300,
			}}
		/>
	)
}
