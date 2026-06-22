import { computed, getPointsFromDrawSegment, type Computed, type Editor, type TLShape, type TLDrawShape, type Vec } from 'tldraw'
import type { LineKind, Segment, Vec2 } from './physics'
import { makeCheckpoint, type Checkpoint } from './checkpoints'

// The "kind" of a track line is derived from a native shape's color. This keeps
// us fully on tldraw's native stack — users draw with the native pencil/geo
// tools and pick a color; we interpret the color as gameplay behavior.
// `LineKind` is defined in physics.ts (the consumer); we map colors onto it.

// Map native tldraw colors -> gameplay line kinds. Each entry carries a
// `strength` (0..1) so a "light-" color can reuse its base kind at a weaker
// magnitude (per PLANNING.md's "same kind, tuned constant" decision). Strength
// is a no-op for kinds that don't read it (solid/oneway/scenery).
interface KindSpec {
	kind: LineKind
	strength: number
	/** For 'oneway': block from the opposite side. See Segment.flip. */
	flip?: boolean
}

const COLOR_TO_KIND: Record<string, KindSpec> = {
	black: { kind: 'solid', strength: 1 },
	// grey is ice: white reads as 'ice' in PLANNING but is invisible in tldraw's
	// light mode, so grey is the usable frictionless surface. black stays solid.
	grey: { kind: 'ice', strength: 1 },
	red: { kind: 'accelerate', strength: 1 },
	'light-red': { kind: 'accelerate', strength: 0.5 },
	orange: { kind: 'brake', strength: 1 },
	yellow: { kind: 'bounce', strength: 1 },
	blue: { kind: 'oneway', strength: 1 },
	// light-blue is a one-way facing the opposite way from blue, so the two
	// shades give you both collide-from-above and collide-from-below gates.
	'light-blue': { kind: 'oneway', strength: 1, flip: true },
	violet: { kind: 'sticky', strength: 1 },
	'light-violet': { kind: 'sticky', strength: 0.5 },
	white: { kind: 'ice', strength: 1 },
	green: { kind: 'scenery', strength: 1 },
	'light-green': { kind: 'scenery', strength: 1 },
}

const DEFAULT_SPEC: KindSpec = { kind: 'solid', strength: 1 }

// Only these native shape types become collision track. Everything else (text,
// image, video, frame, embed, bookmark, note, highlight, …) is treated as
// scenery — it would otherwise act as an invisible solid wall, since those
// shapes carry no track-meaningful color. An allowlist (not a denylist) means a
// future tldraw shape type is non-collidable by default rather than a surprise
// wall. These four are the shapes whose geometry reads as a ridable line/path.
const COLLIDABLE_TYPES = new Set(['draw', 'line', 'geo', 'arrow'])

/** A page-space collision segment with a definite gameplay kind. */
export interface TrackSegment extends Segment {
	kind: LineKind
}

function specOf(shape: TLShape): KindSpec {
	// Most drawable shapes carry a `color` prop; default to solid otherwise.
	const color = (shape.props as { color?: string }).color
	if (color && color in COLOR_TO_KIND) return COLOR_TO_KIND[color]
	return DEFAULT_SPEC
}

/**
 * A reactive view of the track segments, bound to one editor. Reading `.get()`
 * recomputes only when the page's shapes change (tldraw memoizes the computed by
 * its reactive dependencies), so the rAF loop can read it every frame without
 * re-walking the whole page each time. Used by the live debug overlay (which
 * needs the track to reflect edits while stopped) and as the gameplay snapshot
 * source at run start (read `.get()` once to freeze the track for the run).
 * Create one per editor and reuse it.
 */
export function makeSegmentsComputed(editor: Editor): Computed<TrackSegment[]> {
	return computed('lr-track-segments', () => collectSegmentsNow(editor))
}

/** Reactive view of the checkpoint boxes, bound to one editor. See makeSegmentsComputed. */
export function makeCheckpointsComputed(editor: Editor): Computed<Checkpoint[]> {
	return computed('lr-checkpoints', () => collectCheckpointsNow(editor))
}

/**
 * Convert collidable shapes on the current page into page-space collision
 * segments.
 *
 * For each shape we ask tldraw for its geometry (LOCAL coords), read the
 * outline `vertices`, and transform them to page space with the shape's page
 * transform. Consecutive vertices become segments. This works uniformly for
 * native draw strokes, geo shapes, lines, arrows, etc. — no custom shape type.
 *
 * Skipped: non-track shape types (see COLLIDABLE_TYPES) and scenery-colored
 * shapes — both decorative / non-collidable.
 *
 * NOTE on freshness: tldraw's geometry/transform caches (getShapeGeometry /
 * getShapePageTransform) are reactive computeds that invalidate automatically
 * when a shape's props change (epoch-based). The freshness bug this used to hit
 * was caused by passing the enumerated *snapshot* object to those calls instead
 * of the shape *id*; passing shape.id (below) is what makes the cache resolve
 * against the live record. (We deliberately do NOT wrap these reads in an
 * editor.run transaction — a transaction does not force a recompute, and reads
 * inside a `computed` are tracked as dependencies on their own.)
 */
function collectSegmentsNow(editor: Editor): TrackSegment[] {
	const segments: TrackSegment[] = []

	for (const shape of editor.getCurrentPageShapes()) {
		// Skip non-track shape types (text/image/frame/…) so they don't act as
		// invisible walls, independent of color.
		if (!COLLIDABLE_TYPES.has(shape.type)) continue

		const spec = specOf(shape)
		if (spec.kind === 'scenery') continue

		// Use the shape id so the transform/geometry caches resolve against the
		// live record, not the enumerated snapshot object.
		const transform = editor.getShapePageTransform(shape.id)
		if (!transform) continue

		// Draw (pencil) shapes can contain multiple strokes separated by
		// pen-lifts. Their flattened geometry would bridge the gaps with a
		// phantom line, so decode each stroke separately and never connect
		// across strokes.
		if (shape.type === 'draw') {
			const draw = shape as TLDrawShape
			const scale = draw.props.scale
			const strokes = draw.props.segments
			let firstPt: Vec | undefined
			let lastPt: Vec | undefined
			let totalPts = 0
			for (const stroke of strokes) {
				const localPts = getPointsFromDrawSegment(stroke, scale, scale)
				const pts = transform.applyToPoints(localPts)
				if (pts.length === 0) continue
				// Push each stroke on its own so we never bridge a pen-lift gap
				// with a phantom line between strokes.
				pushPolyline(segments, pts, spec, false, shape.type)
				if (!firstPt) firstPt = pts[0]
				lastPt = pts[pts.length - 1]
				totalPts += pts.length
			}
			// A closed freehand loop connects the overall last point back to the
			// overall first point. Guard on the total point count (not the final
			// stroke's) so a closed loop ending in a degenerate tap still closes.
			if (draw.props.isClosed && firstPt && lastPt && totalPts > 2) {
				segments.push(makeSeg(lastPt, firstPt, spec, shape.type))
			}
			continue
		}

		// Everything else: use tldraw's geometry outline (local) -> page space.
		// Pass the shape id (like the transform/bounds reads above) so the geometry
		// cache resolves against the live record, per the CLAUDE.md gotcha.
		const geometry = editor.getShapeGeometry(shape.id)
		const localVerts = geometry.vertices
		if (!localVerts || localVerts.length < 2) continue
		const verts = transform.applyToPoints(localVerts)
		pushPolyline(segments, verts, spec, geometry.isClosed, shape.type)
	}

	return segments
}

/** Emit segments between consecutive points; optionally close the loop. */
function pushPolyline(out: TrackSegment[], pts: Vec[], spec: KindSpec, closed: boolean, shapeType: string) {
	for (let i = 0; i < pts.length - 1; i++) {
		out.push(makeSeg(pts[i], pts[i + 1], spec, shapeType))
	}
	if (closed && pts.length > 2) {
		out.push(makeSeg(pts[pts.length - 1], pts[0], spec, shapeType))
	}
}

function makeSeg(a: Vec2, b: Vec2, spec: KindSpec, shapeType: string): TrackSegment {
	const seg: TrackSegment = {
		a: { x: a.x, y: a.y },
		b: { x: b.x, y: b.y },
		kind: spec.kind,
		strength: spec.strength,
		// Carry the source shape type so the audio layer can vary a sound by shape
		// (draw/line/geo/arrow) as well as by kind. Physics ignores it.
		shape: shapeType,
	}
	if (spec.flip) seg.flip = true
	return seg
}

// Native sticky-note shapes act as scoring flags / checkpoints. Using a distinct
// native tool (the note tool) for a distinct gameplay role mirrors the
// color->line-kind contract, and keeps us off custom records. Notes are never
// collidable track (they're not in COLLIDABLE_TYPES), so this is the only place
// they matter to gameplay.
//
// The oriented-box construction below decomposes the page transform into a single
// rotation + axis scales. That's exact for notes specifically: a native note's
// transform is only ever translate + rotate + (uniform) scale — never skew or
// non-uniform scale — so decompose() recovers its true rotation and footprint.
// (If a future CHECKPOINT_TYPE could be skewed, the box would approximate it; the
// pure box math is covered by checkpoints.test.ts.)
const CHECKPOINT_TYPE = 'note'

/**
 * Collect the page-space boxes of every checkpoint (note) shape on the current
 * page. Backs makeCheckpointsComputed; see the freshness note on
 * collectSegmentsNow about passing shape.id to the reactive caches.
 */
function collectCheckpointsNow(editor: Editor): Checkpoint[] {
	const checkpoints: Checkpoint[] = []
	for (const shape of editor.getCurrentPageShapes()) {
		if (shape.type !== CHECKPOINT_TYPE) continue
		// Build an oriented box from the note's LOCAL geometry bounds + page
		// transform, so a rotated note's catch region matches its actual footprint
		// rather than its inflated axis-aligned page bounding box. (Reading page
		// bounds would over-collect: a 45°-rotated note's AABB is ~2x its area.)
		const geometry = editor.getShapeGeometry(shape.id)
		const transform = editor.getShapePageTransform(shape.id)
		if (!transform) continue
		const lb = geometry.bounds
		// Local center -> page space gives the box center under any rotation.
		const center = transform.applyToPoint({ x: lb.x + lb.w / 2, y: lb.y + lb.h / 2 })
		// Decompose so the half-extents pick up any page-space scale (a note's
		// `scale` prop) alongside the rotation — local bounds alone would be wrong
		// for a scaled note. The box math itself lives in the pure makeCheckpoint.
		const { scaleX, scaleY, rotation } = transform.decompose()
		checkpoints.push(makeCheckpoint(shape.id, center, lb, scaleX, scaleY, rotation))
	}
	return checkpoints
}
