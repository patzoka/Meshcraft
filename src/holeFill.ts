import { BufferAttribute, BufferGeometry, ShapeUtils, Vector2, Vector3 } from "three";

export interface HoleFillOptions {
  method: "planar" | "edge-flow";
  maxHoleEdges: number;
  keepOuterRim: boolean;
  maxHoleRatio: number;
  fair: boolean;
}

export interface SkippedHole {
  edges: number;
  reason: string;
}

export interface HoleFillResult {
  geometry: BufferGeometry;
  cappedHoles: number;
  cappedBoundaryEdges: number;
  patchVertices: number;
  preservedRims: number;
  fallbackHoles: number;
  skippedHoles: SkippedHole[];
}

/** Largest loop triangulated directly by dynamic programming; bigger loops are split first. */
export const MAX_DP_EDGES = 300;
/** A component's largest loop is an outer rim when its cap would cover this share of the surface. */
const RIM_AREA_RATIO = 0.4;
/** Liepa's density factor for centroid splits. */
const REFINE_ALPHA = Math.SQRT2;
const MAX_PATCH_TRIANGLES = 200_000;
/** Patch triangles may not fold back on a neighbour by more than about 154 degrees. */
const FOLD_LIMIT = -0.9;

interface IndexedMesh {
  points: Vector3[];
  faces: number[];
  vertexCount: number;
  tolerance: number;
  halfEdgeFace: Map<number, number>;
  edgeUses: Map<number, number>;
}

interface Loop {
  vertices: number[];
  perimeter: number;
  capArea: number;
  component: number;
}

function buildIndexedMesh(geometry: BufferGeometry): IndexedMesh {
  const position = geometry.getAttribute("position");
  geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox?.getSize(new Vector3()).length() ?? 0;
  const tolerance = Math.max(diagonal * 1e-7, 1e-9);
  const quantize = (value: number) => Math.round(value / tolerance);
  const points: Vector3[] = [];
  const pointIds = new Map<string, number>();
  const ids = new Array<number>(position.count);
  for (let i = 0; i < position.count; i++) {
    const point = new Vector3(position.getX(i), position.getY(i), position.getZ(i));
    const key = `${quantize(point.x)},${quantize(point.y)},${quantize(point.z)}`;
    let id = pointIds.get(key);
    if (id === undefined) {
      id = points.length;
      points.push(point);
      pointIds.set(key, id);
    }
    ids[i] = id;
  }

  const faces: number[] = [];
  const indexCount = geometry.index?.count ?? position.count;
  for (let i = 0; i + 2 < indexCount; i += 3) {
    for (let corner = 0; corner < 3; corner++) faces.push(ids[geometry.index?.getX(i + corner) ?? i + corner]);
  }

  const vertexCount = points.length;
  const halfEdgeFace = new Map<number, number>();
  const edgeUses = new Map<number, number>();
  for (let face = 0; face < faces.length / 3; face++) {
    const [a, b, c] = faces.slice(face * 3, face * 3 + 3);
    if (a === b || b === c || c === a) continue;
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      halfEdgeFace.set(start * vertexCount + end, face);
      const key = Math.min(start, end) * vertexCount + Math.max(start, end);
      edgeUses.set(key, (edgeUses.get(key) ?? 0) + 1);
    }
  }
  return { points, faces, vertexCount, tolerance, halfEdgeFace, edgeUses };
}

function isBoundaryEdge(mesh: IndexedMesh, a: number, b: number): boolean {
  const n = mesh.vertexCount;
  return mesh.edgeUses.get(Math.min(a, b) * n + Math.max(a, b)) === 1;
}

/** Splits a walk that revisits a vertex (two holes touching at a pinch) into simple loops. */
function splitAtRepeats(walk: number[]): number[][] {
  const seen = new Map<number, number>();
  for (let i = 0; i < walk.length; i++) {
    const first = seen.get(walk[i]);
    if (first !== undefined) {
      return [
        ...splitAtRepeats(walk.slice(first, i)),
        ...splitAtRepeats([...walk.slice(0, first), ...walk.slice(i)]),
      ];
    }
    seen.set(walk[i], i);
  }
  return [walk];
}

/**
 * Returns boundary loops in patch order: each consecutive pair (p, q) is the reverse of
 * an existing boundary half-edge, so a triangle (v_i, v_m, v_k) with i < m < k is wound
 * consistently with the surrounding faces.
 */
function extractLoops(mesh: IndexedMesh): { loops: number[][]; openChains: number[] } {
  const n = mesh.vertexCount;
  const outgoing = new Map<number, number[]>();
  for (let face = 0; face < mesh.faces.length / 3; face++) {
    const [a, b, c] = mesh.faces.slice(face * 3, face * 3 + 3);
    if (a === b || b === c || c === a) continue;
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      if (isBoundaryEdge(mesh, start, end)) outgoing.set(start, [...(outgoing.get(start) ?? []), end]);
    }
  }

  const used = new Set<number>();
  const loops: number[][] = [];
  const openChains: number[] = [];
  for (const [start, targets] of outgoing) {
    for (const firstTarget of targets) {
      if (used.has(start * n + firstTarget)) continue;
      used.add(start * n + firstTarget);
      const walk = [start];
      let current = firstTarget;
      let closed = false;
      while (true) {
        if (current === start) {
          closed = true;
          break;
        }
        walk.push(current);
        const from = current;
        const next = (outgoing.get(from) ?? []).find((target) => !used.has(from * n + target));
        if (next === undefined) break;
        used.add(from * n + next);
        current = next;
      }
      if (!closed) {
        openChains.push(walk.length);
        continue;
      }
      for (const loop of splitAtRepeats(walk)) {
        if (loop.length >= 3) loops.push(loop.reverse());
      }
    }
  }
  return { loops, openChains };
}

function newellNormal(points: Vector3[]): Vector3 {
  const normal = new Vector3();
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    normal.x += (a.y - b.y) * (a.z + b.z);
    normal.y += (a.z - b.z) * (a.x + b.x);
    normal.z += (a.x - b.x) * (a.y + b.y);
  }
  return normal;
}

function triangleNormal(a: Vector3, b: Vector3, c: Vector3): Vector3 {
  return new Vector3().subVectors(b, a).cross(new Vector3().subVectors(c, a));
}

/** Mesh neighbours and incident faces of every boundary vertex. */
function boundaryAdjacency(mesh: IndexedMesh, loops: number[][]): {
  adjacency: Map<number, Set<number>>;
  rimFaces: Map<number, number[]>;
} {
  const adjacency = new Map<number, Set<number>>();
  const rimFaces = new Map<number, number[]>();
  for (const loop of loops) {
    for (const vertex of loop) {
      adjacency.set(vertex, new Set());
      rimFaces.set(vertex, []);
    }
  }
  for (let face = 0; face < mesh.faces.length / 3; face++) {
    const corners = mesh.faces.slice(face * 3, face * 3 + 3);
    if (corners[0] === corners[1] || corners[1] === corners[2] || corners[2] === corners[0]) continue;
    for (let i = 0; i < 3; i++) {
      const neighbors = adjacency.get(corners[i]);
      if (!neighbors) continue;
      rimFaces.get(corners[i])!.push(face);
      for (let j = 0; j < 3; j++) if (j !== i) neighbors.add(corners[j]);
    }
  }
  return { adjacency, rimFaces };
}

function classifyLoops(
  mesh: IndexedMesh,
  rawLoops: number[][],
  options: HoleFillOptions,
): { holes: Loop[]; preservedRims: number; skipped: SkippedHole[] } {
  const parent = mesh.points.map((_point, index) => index);
  const find = (value: number): number => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const faceAreas: { root: number; area: number }[] = [];
  for (let face = 0; face < mesh.faces.length / 3; face++) {
    const [a, b, c] = mesh.faces.slice(face * 3, face * 3 + 3);
    if (a === b || b === c || c === a) continue;
    const rootA = find(a);
    for (const other of [b, c]) {
      const root = find(other);
      if (root !== rootA) parent[root] = rootA;
    }
    faceAreas.push({ root: a, area: triangleNormal(mesh.points[a], mesh.points[b], mesh.points[c]).length() / 2 });
  }
  const componentArea = new Map<number, number>();
  for (const { root, area } of faceAreas) {
    const component = find(root);
    componentArea.set(component, (componentArea.get(component) ?? 0) + area);
  }

  const byComponent = new Map<number, Loop[]>();
  for (const vertices of rawLoops) {
    const points = vertices.map((id) => mesh.points[id]);
    let perimeter = 0;
    for (let i = 0; i < points.length; i++) perimeter += points[i].distanceTo(points[(i + 1) % points.length]);
    const loop = {
      vertices,
      perimeter,
      capArea: newellNormal(points).length() / 2,
      component: find(vertices[0]),
    };
    byComponent.set(loop.component, [...(byComponent.get(loop.component) ?? []), loop]);
  }

  const holes: Loop[] = [];
  const skipped: SkippedHole[] = [];
  let preservedRims = 0;
  for (const [component, loops] of byComponent) {
    loops.sort((a, b) => b.perimeter - a.perimeter);
    const largest = loops[0];
    const rim = options.keepOuterRim && largest.capArea >= RIM_AREA_RATIO * (componentArea.get(component) ?? 0)
      ? largest
      : undefined;
    for (const loop of loops) {
      if (loop === rim) {
        preservedRims++;
      } else if (rim && loop.perimeter > options.maxHoleRatio * rim.perimeter) {
        skipped.push({
          edges: loop.vertices.length,
          reason: `kept open: perimeter is over ${Math.round(options.maxHoleRatio * 100)}% of the outer rim`,
        });
      } else if (loop.vertices.length > options.maxHoleEdges) {
        skipped.push({
          edges: loop.vertices.length,
          reason: `more than ${options.maxHoleEdges} boundary edges`,
        });
      } else {
        holes.push(loop);
      }
    }
  }
  return { holes, preservedRims, skipped };
}

/** Holds the vertices a patch adds until the patch is accepted. */
class PatchVertices {
  readonly base: number;
  readonly added: Vector3[] = [];

  constructor(private readonly mesh: IndexedMesh) {
    this.base = mesh.points.length;
  }

  get(id: number): Vector3 {
    return id < this.base ? this.mesh.points[id] : this.added[id - this.base];
  }

  add(point: Vector3): number {
    this.added.push(point);
    return this.base + this.added.length - 1;
  }
}

/**
 * Minimum-weight triangulation (Liepa 2003; Barequet and Sharir 1995). Weight is the pair
 * (worst dihedral angle against neighbouring triangles, total area), compared in that order.
 * `edgeNormals[j]` is the unit normal of the mesh face across polygon edge j → j+1, or null
 * for a chord introduced by splitting.
 */
function triangulateMinWeight(
  loop: number[],
  edgeNormals: (Vector3 | null)[],
  vertices: PatchVertices,
  adjacency: Map<number, Set<number>>,
  tolerance: number,
): number[][] | null {
  const n = loop.length;
  if (n === 3) return [[loop[0], loop[1], loop[2]]];
  const points = loop.map((id) => vertices.get(id));
  const angle = new Float64Array(n * n);
  const area = new Float64Array(n * n);
  const best = new Int32Array(n * n).fill(-1);
  const normals = new Float64Array(n * n * 3);
  const neighborNormal = (i: number, k: number): Vector3 | null => {
    if (k === i + 1) return edgeNormals[i];
    const at = (i * n + k) * 3;
    return new Vector3(normals[at], normals[at + 1], normals[at + 2]);
  };
  const dihedral = (normal: Vector3, other: Vector3 | null) =>
    other ? Math.acos(Math.min(1, Math.max(-1, normal.dot(other)))) : 0;

  for (let span = 2; span < n; span++) {
    for (let i = 0; i + span < n; i++) {
      const k = i + span;
      const cell = i * n + k;
      angle[cell] = Infinity;
      if (span < n - 1 && adjacency.get(loop[i])?.has(loop[k])) continue;
      let bestAngle = Infinity;
      let bestArea = Infinity;
      for (let m = i + 1; m < k; m++) {
        const left = angle[i * n + m];
        const right = angle[m * n + k];
        if (left === Infinity || right === Infinity) continue;
        const normal = triangleNormal(points[i], points[m], points[k]);
        const doubleArea = normal.length();
        if (doubleArea <= tolerance * tolerance) continue;
        normal.divideScalar(doubleArea);
        let worst = Math.max(
          left,
          right,
          dihedral(normal, neighborNormal(i, m)),
          dihedral(normal, neighborNormal(m, k)),
        );
        if (span === n - 1) worst = Math.max(worst, dihedral(normal, edgeNormals[n - 1]));
        const total = area[i * n + m] + area[m * n + k] + doubleArea / 2;
        if (worst < bestAngle - 1e-9 || (Math.abs(worst - bestAngle) <= 1e-9 && total < bestArea)) {
          bestAngle = worst;
          bestArea = total;
          best[cell] = m;
          normals[cell * 3] = normal.x;
          normals[cell * 3 + 1] = normal.y;
          normals[cell * 3 + 2] = normal.z;
        }
      }
      angle[cell] = bestAngle;
      area[cell] = bestArea;
    }
  }
  if (best[n - 1] < 0) return null;

  const triangles: number[][] = [];
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length > 0) {
    const [i, k] = stack.pop()!;
    const m = best[i * n + k];
    triangles.push([loop[i], loop[m], loop[k]]);
    if (m - i >= 2) stack.push([i, m]);
    if (k - m >= 2) stack.push([m, k]);
  }
  return triangles;
}

/**
 * Triangulates loops of any size: loops over MAX_DP_EDGES are split along their shortest
 * balanced chord and each half is triangulated on its own.
 */
function triangulateLoop(
  loop: number[],
  edgeNormals: (Vector3 | null)[],
  vertices: PatchVertices,
  adjacency: Map<number, Set<number>>,
  tolerance: number,
): number[][] | null {
  const n = loop.length;
  if (n <= MAX_DP_EDGES) return triangulateMinWeight(loop, edgeNormals, vertices, adjacency, tolerance);

  const points = loop.map((id) => vertices.get(id));
  const along = [0];
  for (let i = 1; i <= n; i++) along.push(along[i - 1] + points[i - 1].distanceTo(points[i % n]));
  const perimeter = along[n];
  const minSide = Math.max(3, Math.floor(n / 4));
  const step = Math.max(1, Math.floor(n / 600));
  let chord: [number, number] | null = null;
  let bestRatio = Infinity;
  for (let i = 0; i < n; i += step) {
    for (let j = i + minSide; j <= i + n - minSide && j < n; j++) {
      if (adjacency.get(loop[i])?.has(loop[j])) continue;
      const arc = along[j] - along[i];
      const ratio = points[i].distanceTo(points[j]) / Math.min(arc, perimeter - arc);
      if (ratio < bestRatio) {
        bestRatio = ratio;
        chord = [i, j];
      }
    }
  }
  if (!chord) return null;
  const [i, j] = chord;
  const first = triangulateLoop(
    loop.slice(i, j + 1),
    [...edgeNormals.slice(i, j), null],
    vertices,
    adjacency,
    tolerance,
  );
  const second = triangulateLoop(
    [...loop.slice(j), ...loop.slice(0, i + 1)],
    [...edgeNormals.slice(j), ...edgeNormals.slice(0, i), null],
    vertices,
    adjacency,
    tolerance,
  );
  return first && second ? [...first, ...second] : null;
}

function edgeKey(a: number, b: number): string {
  return `${a},${b}`;
}

function thirdVertex(triangle: number[], a: number, b: number): number {
  for (let r = 0; r < 3; r++) {
    if (triangle[r] === a && triangle[(r + 1) % 3] === b) return triangle[(r + 2) % 3];
  }
  throw new Error("Edge is not part of the triangle.");
}

class PatchTriangles {
  readonly triangles: number[][] = [];
  readonly edges = new Map<string, number>();

  constructor(triangles: number[][]) {
    for (const triangle of triangles) this.push(triangle);
  }

  push(triangle: number[]) {
    this.triangles.push(triangle);
    this.link(this.triangles.length - 1);
  }

  set(index: number, triangle: number[]) {
    const old = this.triangles[index];
    for (let r = 0; r < 3; r++) {
      const key = edgeKey(old[r], old[(r + 1) % 3]);
      if (this.edges.get(key) === index) this.edges.delete(key);
    }
    this.triangles[index] = triangle;
    this.link(index);
  }

  private link(index: number) {
    const triangle = this.triangles[index];
    for (let r = 0; r < 3; r++) this.edges.set(edgeKey(triangle[r], triangle[(r + 1) % 3]), index);
  }
}

function cornerAngle(apex: Vector3, a: Vector3, b: Vector3): number {
  return new Vector3().subVectors(a, apex).angleTo(new Vector3().subVectors(b, apex));
}

/** Flips interior patch edges that are not locally Delaunay. */
function relaxPatch(
  patch: PatchTriangles,
  vertices: PatchVertices,
  adjacency: Map<number, Set<number>>,
) {
  for (let pass = 0; pass < 100; pass++) {
    let flipped = false;
    for (const key of [...patch.edges.keys()]) {
      const [a, b] = key.split(",").map(Number);
      if (a > b) continue;
      const first = patch.edges.get(edgeKey(a, b));
      const second = patch.edges.get(edgeKey(b, a));
      if (first === undefined || second === undefined) continue;
      const c = thirdVertex(patch.triangles[first], a, b);
      const d = thirdVertex(patch.triangles[second], b, a);
      if (c === d || patch.edges.has(edgeKey(c, d)) || patch.edges.has(edgeKey(d, c))) continue;
      if (adjacency.get(c)?.has(d)) continue;
      const [pa, pb, pc, pd] = [a, b, c, d].map((id) => vertices.get(id));
      if (cornerAngle(pc, pa, pb) + cornerAngle(pd, pa, pb) <= Math.PI + 1e-9) continue;
      const before = triangleNormal(pa, pb, pc).normalize().add(triangleNormal(pb, pa, pd).normalize());
      if (triangleNormal(pa, pd, pc).dot(before) <= 0 || triangleNormal(pb, pc, pd).dot(before) <= 0) continue;
      patch.set(first, [a, d, c]);
      patch.set(second, [b, c, d]);
      flipped = true;
    }
    if (!flipped) return;
  }
}

/** Liepa's refinement: split triangles until their size matches the surrounding edge lengths. */
function refinePatch(
  patch: PatchTriangles,
  vertices: PatchVertices,
  sigma: Map<number, number>,
  adjacency: Map<number, Set<number>>,
) {
  while (patch.triangles.length < MAX_PATCH_TRIANGLES) {
    let split = false;
    const count = patch.triangles.length;
    for (let index = 0; index < count && patch.triangles.length < MAX_PATCH_TRIANGLES; index++) {
      const [i, j, k] = patch.triangles[index];
      const corners = [i, j, k].map((id) => vertices.get(id));
      const centroid = new Vector3().add(corners[0]).add(corners[1]).add(corners[2]).divideScalar(3);
      const centroidSigma = ([i, j, k].reduce((sum, id) => sum + (sigma.get(id) ?? 0), 0)) / 3;
      const shouldSplit = [i, j, k].every((id, corner) => {
        const scaled = REFINE_ALPHA * centroid.distanceTo(corners[corner]);
        return scaled > centroidSigma && scaled > (sigma.get(id) ?? 0);
      });
      if (!shouldSplit) continue;
      const center = vertices.add(centroid);
      sigma.set(center, centroidSigma);
      patch.set(index, [i, j, center]);
      patch.push([j, k, center]);
      patch.push([k, i, center]);
      split = true;
    }
    if (!split) return;
    relaxPatch(patch, vertices, adjacency);
  }
}

/**
 * Thin-plate fairing: moves the patch's new vertices to minimise the sum of squared
 * Laplacians over the patch and its rim, keeping the rim and the mesh around it fixed.
 * Cotangent weights make the Laplacian vanish on planes however the patch is triangulated,
 * so flat holes stay flat and curved ones follow the surface. Solved per axis with conjugate
 * gradients on the normal equations.
 */
function fairPatch(
  patch: PatchTriangles,
  vertices: PatchVertices,
  rim: number[],
  mesh: IndexedMesh,
  rimFaces: Map<number, number[]>,
) {
  if (vertices.added.length === 0) return;
  const weights = new Map<number, Map<number, number>>();
  const addWeight = (a: number, b: number, weight: number) => {
    let around = weights.get(a);
    if (!around) weights.set(a, (around = new Map()));
    around.set(b, (around.get(b) ?? 0) + weight);
  };
  const addTriangle = (ids: number[]) => {
    for (let r = 0; r < 3; r++) {
      const [apex, p, q] = [ids[r], ids[(r + 1) % 3], ids[(r + 2) % 3]];
      const u = new Vector3().subVectors(vertices.get(p), vertices.get(apex));
      const v = new Vector3().subVectors(vertices.get(q), vertices.get(apex));
      const cross = u.clone().cross(v).length();
      const cot = cross > 0 ? u.dot(v) / cross : 0;
      addWeight(p, q, cot / 2);
      addWeight(q, p, cot / 2);
    }
  };
  for (const triangle of patch.triangles) addTriangle(triangle);
  const meshFaces = new Set(rim.flatMap((id) => rimFaces.get(id) ?? []));
  for (const face of meshFaces) addTriangle(mesh.faces.slice(face * 3, face * 3 + 3));

  const free = vertices.added.map((_point, index) => vertices.base + index);
  const column = new Map(free.map((id, index) => [id, index]));
  const rows = [...free, ...rim.filter((id) => [...(weights.get(id)?.keys() ?? [])].some((other) => column.has(other)))];
  // Obtuse corners give negative cotangents; a small floor keeps every row well-posed.
  const rowNeighbors = rows.map((id) => {
    const around = [...(weights.get(id) ?? new Map<number, number>())].map(([other, weight]) =>
      [other, Math.max(weight, 0.01)] as const);
    const total = around.reduce((sum, [, weight]) => sum + weight, 0);
    return around.map(([other, weight]) => [other, weight / total] as const);
  });
  const size = free.length;

  const apply = (x: Float64Array): Float64Array => {
    const out = new Float64Array(size);
    rows.forEach((id, row) => {
      const around = rowNeighbors[row];
      let value = 0;
      for (const [other, weight] of around) {
        const col = column.get(other);
        if (col !== undefined) value += x[col] * weight;
      }
      const own = column.get(id);
      if (own !== undefined) value -= x[own];
      for (const [other, weight] of around) {
        const col = column.get(other);
        if (col !== undefined) out[col] += value * weight;
      }
      if (own !== undefined) out[own] -= value;
    });
    return out;
  };

  for (const axis of ["x", "y", "z"] as const) {
    const fixed = new Float64Array(size);
    rows.forEach((id, row) => {
      const around = rowNeighbors[row];
      let value = 0;
      for (const [other, weight] of around) if (!column.has(other)) value += vertices.get(other)[axis] * weight;
      if (!column.has(id)) value -= vertices.get(id)[axis];
      for (const [other, weight] of around) {
        const col = column.get(other);
        if (col !== undefined) fixed[col] -= value * weight;
      }
      const own = column.get(id);
      if (own !== undefined) fixed[own] += value;
    });
    const x = Float64Array.from(free, (id) => vertices.get(id)[axis]);
    const ax = apply(x);
    const residual = fixed.map((value, index) => value - ax[index]);
    const direction = Float64Array.from(residual);
    let rr = residual.reduce((sum, value) => sum + value * value, 0);
    const target = rr * 1e-20;
    for (let iteration = 0; iteration < Math.max(200, 2 * size) && rr > target && rr > 1e-30; iteration++) {
      const ad = apply(direction);
      const dAd = direction.reduce((sum, value, index) => sum + value * ad[index], 0);
      if (dAd <= 0) break;
      const step = rr / dAd;
      for (let i = 0; i < size; i++) {
        x[i] += step * direction[i];
        residual[i] -= step * ad[i];
      }
      const next = residual.reduce((sum, value) => sum + value * value, 0);
      for (let i = 0; i < size; i++) direction[i] = residual[i] + (next / rr) * direction[i];
      rr = next;
    }
    free.forEach((id, index) => {
      vertices.get(id)[axis] = x[index];
    });
  }
}

function patchIsValid(
  triangles: number[][],
  vertices: PatchVertices,
  mesh: IndexedMesh,
  claimedEdges: Set<string>,
): boolean {
  const n = mesh.vertexCount;
  const edges = new Map<string, Vector3>();
  for (const [a, b, c] of triangles) {
    const normal = triangleNormal(vertices.get(a), vertices.get(b), vertices.get(c));
    const length = normal.length();
    if (length <= mesh.tolerance * mesh.tolerance) return false;
    normal.divideScalar(length);
    for (const [p, q] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKey(p, q);
      if (edges.has(key) || claimedEdges.has(key)) return false;
      if (p < n && q < n && mesh.halfEdgeFace.has(p * n + q)) return false;
      edges.set(key, normal);
    }
  }
  for (const [key, normal] of edges) {
    const [p, q] = key.split(",").map(Number);
    const twin = edges.get(edgeKey(q, p));
    if (twin) {
      if (normal.dot(twin) < FOLD_LIMIT) return false;
      continue;
    }
    const face = p < n && q < n ? mesh.halfEdgeFace.get(q * n + p) : undefined;
    if (face === undefined || !isBoundaryEdge(mesh, p, q)) return false;
    const [fa, fb, fc] = mesh.faces.slice(face * 3, face * 3 + 3).map((id) => mesh.points[id]);
    if (normal.dot(triangleNormal(fa, fb, fc).normalize()) < FOLD_LIMIT) return false;
  }
  return true;
}

function edgeFlowPatch(
  mesh: IndexedMesh,
  loop: number[],
  adjacency: Map<number, Set<number>>,
  rimFaces: Map<number, number[]>,
  claimedEdges: Set<string>,
  fair: boolean,
): { triangles: number[][]; added: Vector3[] } | null {
  const n = mesh.vertexCount;
  const vertices = new PatchVertices(mesh);
  const edgeNormals = loop.map((from, index) => {
    const to = loop[(index + 1) % loop.length];
    const face = mesh.halfEdgeFace.get(to * n + from);
    if (face === undefined) return null;
    const [a, b, c] = mesh.faces.slice(face * 3, face * 3 + 3).map((id) => mesh.points[id]);
    const normal = triangleNormal(a, b, c);
    return normal.lengthSq() > 0 ? normal.normalize() : null;
  });
  const initial = triangulateLoop(loop, edgeNormals, vertices, adjacency, mesh.tolerance);
  if (!initial || !patchIsValid(initial, vertices, mesh, claimedEdges)) return null;

  const sigma = new Map<number, number>();
  for (const vertex of loop) {
    const around = [...(adjacency.get(vertex) ?? [])];
    const total = around.reduce((sum, other) => sum + mesh.points[vertex].distanceTo(mesh.points[other]), 0);
    sigma.set(vertex, around.length > 0 ? total / around.length : 0);
  }
  const patch = new PatchTriangles(initial);
  relaxPatch(patch, vertices, adjacency);
  refinePatch(patch, vertices, sigma, adjacency);
  const refined = vertices.added.map((point) => point.clone());
  if (fair) {
    fairPatch(patch, vertices, loop, mesh, rimFaces);
    if (patchIsValid(patch.triangles, vertices, mesh, claimedEdges)) {
      return { triangles: patch.triangles, added: vertices.added };
    }
    refined.forEach((point, index) => vertices.added[index].copy(point));
  }
  if (patchIsValid(patch.triangles, vertices, mesh, claimedEdges)) {
    return { triangles: patch.triangles, added: vertices.added };
  }
  return { triangles: initial, added: [] };
}

/**
 * The original flat cap: project onto the loop's best-fit plane and ear-clip. It walks the
 * loop in boundary order, as the old implementation did, so it picks the same diagonals.
 */
function planarCap(loop: number[], mesh: IndexedMesh): number[][] | null {
  const walk = [...loop].reverse();
  const points = walk.map((id) => mesh.points[id]);
  const center = points.reduce((sum, point) => sum.add(point), new Vector3()).multiplyScalar(1 / points.length);
  const normal = newellNormal(points);
  if (normal.lengthSq() <= mesh.tolerance ** 2) return null;
  normal.normalize();
  const axis = Math.abs(normal.x) < 0.8 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
  const basisX = new Vector3().crossVectors(axis, normal).normalize();
  const basisY = new Vector3().crossVectors(normal, basisX).normalize();
  const contour = points.map((point) => {
    const relative = point.clone().sub(center);
    return new Vector2(relative.dot(basisX), relative.dot(basisY));
  });
  if (Math.abs(ShapeUtils.area(contour)) <= mesh.tolerance ** 2) return null;
  const triangles = ShapeUtils.triangulateShape(contour, []);
  if (triangles.length === 0) return null;
  return triangles.map((triangle) => {
    const ids = triangle.map((index) => walk[index]);
    const facing = triangleNormal(mesh.points[ids[0]], mesh.points[ids[1]], mesh.points[ids[2]]).dot(normal);
    return facing > 0 ? ids.reverse() : ids;
  });
}

export function fillHoles(geometry: BufferGeometry, options: HoleFillOptions): HoleFillResult {
  const result: HoleFillResult = {
    geometry,
    cappedHoles: 0,
    cappedBoundaryEdges: 0,
    patchVertices: 0,
    preservedRims: 0,
    fallbackHoles: 0,
    skippedHoles: [],
  };
  const position = geometry.getAttribute("position");
  if (!position || position.count < 3 || options.maxHoleEdges < 3) return result;

  const mesh = buildIndexedMesh(geometry);
  const { loops, openChains } = extractLoops(mesh);
  for (const edges of openChains) {
    result.skippedHoles.push({ edges, reason: "open boundary chain at a non-manifold vertex" });
  }
  if (loops.length === 0) return result;

  const { adjacency, rimFaces } = boundaryAdjacency(mesh, loops);
  const { holes, preservedRims, skipped } = classifyLoops(mesh, loops, options);
  result.preservedRims = preservedRims;
  result.skippedHoles.push(...skipped);

  const patches: number[][] = [];
  const claimedEdges = new Set<string>();
  for (const hole of holes) {
    let triangles: number[][] | null = null;
    if (options.method === "edge-flow") {
      const patch = edgeFlowPatch(mesh, hole.vertices, adjacency, rimFaces, claimedEdges, options.fair);
      if (patch) {
        mesh.points.push(...patch.added);
        result.patchVertices += patch.added.length;
        triangles = patch.triangles;
      }
    }
    if (!triangles) {
      triangles = planarCap(hole.vertices, mesh);
      if (triangles && options.method === "edge-flow") result.fallbackHoles++;
    }
    if (!triangles) {
      result.skippedHoles.push({ edges: hole.vertices.length, reason: "could not be triangulated" });
      continue;
    }
    for (const [a, b, c] of triangles) {
      for (const [p, q] of [[a, b], [b, c], [c, a]]) claimedEdges.add(edgeKey(p, q));
    }
    patches.push(...triangles);
    result.cappedHoles++;
    result.cappedBoundaryEdges += hole.vertices.length;
  }
  if (patches.length === 0) return result;

  const positions: number[] = [];
  for (const id of mesh.faces) positions.push(mesh.points[id].x, mesh.points[id].y, mesh.points[id].z);
  for (const triangle of patches) {
    for (const id of triangle) positions.push(mesh.points[id].x, mesh.points[id].y, mesh.points[id].z);
  }
  const filled = new BufferGeometry();
  filled.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  result.geometry = filled;
  return result;
}
