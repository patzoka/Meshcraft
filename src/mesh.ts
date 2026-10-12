import {
  BufferAttribute,
  BufferGeometry,
  Mesh,
  Object3D,
  Vector3,
} from "three";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { unzipSync } from "fflate";
import { fillHoles, type SkippedHole } from "./holeFill";

export interface MeshReport {
  triangles: number;
  vertices: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  degenerateTriangles: number;
  components: number;
  volume: number;
  watertight: boolean;
  printable: boolean;
}

export interface RepairSettings {
  weldVertices: boolean;
  removeDegenerate: boolean;
  closeHoles: boolean;
  holeFillMethod: "planar" | "edge-flow";
  keepOuterRim: boolean;
  maxHoleRatio: number;
  fairHoles: boolean;
  maxHoleEdges: number;
  weldTolerance: number;
  addWallThickness: boolean;
  surfaceSide: "outside" | "inside" | "both";
  thicknessScope: "all" | "single-sided";
  wallThicknessMm: number;
}

export interface RepairSummary {
  weldedVertices: number;
  removedTriangles: number;
  cappedHoles: number;
  cappedBoundaryEdges: number;
  remainingBoundaryEdges: number;
  patchVertices: number;
  preservedRims: number;
  fallbackHoles: number;
  skippedHoles: SkippedHole[];
  thickenedFaces: number;
  wallThicknessEnabled: boolean;
  wallThicknessMm: number;
  thicknessScope: "all" | "single-sided";
  surfaceSide: "outside" | "inside" | "both";
  changed: boolean;
}

export interface RepairResult {
  geometry: BufferGeometry;
  summary: RepairSummary;
}

interface DirectedEdge {
  start: number;
  end: number;
}

interface Topology {
  ids: number[];
  positions: Vector3[];
  boundary: DirectedEdge[];
  report: MeshReport;
  signedVolume: number;
  tolerance: number;
}

const DEFAULT_SETTINGS: RepairSettings = {
  weldVertices: true,
  removeDegenerate: true,
  closeHoles: true,
  holeFillMethod: "planar",
  keepOuterRim: true,
  maxHoleRatio: 0.5,
  fairHoles: true,
  maxHoleEdges: 240,
  weldTolerance: 0.05,
  addWallThickness: true,
  thicknessScope: "all",
  surfaceSide: "both",
  wallThicknessMm: 1.5,
};

function makePositionGeometry(positions: number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(new Float32Array(positions), 3));
  return geometry;
}

function collectMeshes(object: Object3D): BufferGeometry {
  object.updateMatrixWorld(true);
  const positions: number[] = [];

  object.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const source = child.geometry.index ? child.geometry.toNonIndexed() : child.geometry.clone();
    source.applyMatrix4(child.matrixWorld);
    const attribute = source.getAttribute("position");
    for (let i = 0; i < attribute.count; i++) {
      positions.push(attribute.getX(i), attribute.getY(i), attribute.getZ(i));
    }
    source.dispose();
  });

  if (positions.length === 0) throw new Error("The selected file contains no triangle mesh.");
  return makePositionGeometry(positions);
}

export async function loadMesh(file: File): Promise<BufferGeometry> {
  const extension = file.name.split(".").pop()?.toLowerCase();
  let object: Object3D;

  if (extension === "stl") {
    const { STLLoader } = await import("three/examples/jsm/loaders/STLLoader.js");
    object = new Mesh(new STLLoader().parse(await file.arrayBuffer()));
  } else if (extension === "obj") {
    const { OBJLoader } = await import("three/examples/jsm/loaders/OBJLoader.js");
    object = new OBJLoader().parse(await file.text());
  } else if (extension === "3mf") {
    const { ThreeMFLoader } = await import("three/examples/jsm/loaders/3MFLoader.js");
    const data = await file.arrayBuffer();
    object = new ThreeMFLoader().parse(data);
    object.scale.multiplyScalar(threeMfScaleToMillimeters(data));
  } else {
    throw new Error("Choose an STL, OBJ, or 3MF model.");
  }

  return collectMeshes(object);
}

export function threeMfScaleToMillimeters(data: ArrayBuffer): number {
  const entries = unzipSync(new Uint8Array(data));
  const canonicalModel = entries["3D/3dmodel.model"];
  const modelFiles = Object.entries(entries).filter(([name]) => /\.model$/i.test(name));
  const modelData = canonicalModel ?? (modelFiles.length === 1 ? modelFiles[0][1] : undefined);
  if (!modelData) throw new Error("The 3MF package has no unambiguous model document.");

  const xml = new TextDecoder().decode(modelData);
  const modelTag = xml.match(/<model\b[^>]*>/i)?.[0];
  if (!modelTag) throw new Error("The 3MF model document is invalid.");
  const unit = modelTag.match(/\bunit\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase() ?? "millimeter";
  const millimetersPerUnit: Record<string, number> = {
    micron: 0.001,
    millimeter: 1,
    centimeter: 10,
    inch: 25.4,
    foot: 304.8,
    meter: 1000,
    millifoot: 0.3048,
  };
  const scale = millimetersPerUnit[unit];
  if (scale === undefined) throw new Error(`Unsupported 3MF unit: ${unit}.`);
  return scale;
}

function getIndex(geometry: BufferGeometry, vertex: number): number {
  return geometry.index?.getX(vertex) ?? vertex;
}

function topologyOf(geometry: BufferGeometry): Topology {
  const position = geometry.getAttribute("position");
  if (!position || position.count < 3) throw new Error("The model has no usable triangle geometry.");

  geometry.computeBoundingBox();
  const diagonal = geometry.boundingBox?.getSize(new Vector3()).length() ?? 0;
  const tolerance = Math.max(diagonal * 1e-7, 1e-9);
  const positions: Vector3[] = [];
  const ids = new Array<number>(position.count);
  const pointIds = new Map<string, number>();
  const quantize = (value: number) => Math.round(value / tolerance);

  for (let i = 0; i < position.count; i++) {
    const point = new Vector3(position.getX(i), position.getY(i), position.getZ(i));
    const key = `${quantize(point.x)},${quantize(point.y)},${quantize(point.z)}`;
    let id = pointIds.get(key);
    if (id === undefined) {
      id = positions.length;
      positions.push(point);
      pointIds.set(key, id);
    }
    ids[i] = id;
  }

  const edgeCounts = new Map<string, { count: number; edge: DirectedEdge }>();
  const parent = positions.map((_point, index) => index);
  const find = (value: number): number => {
    while (parent[value] !== value) {
      parent[value] = parent[parent[value]];
      value = parent[value];
    }
    return value;
  };
  const unite = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  let degenerateTriangles = 0;
  let signedVolume = 0;
  const triangleCount = Math.floor((geometry.index?.count ?? position.count) / 3);

  for (let face = 0; face < triangleCount; face++) {
    const a = ids[getIndex(geometry, face * 3)];
    const b = ids[getIndex(geometry, face * 3 + 1)];
    const c = ids[getIndex(geometry, face * 3 + 2)];
    if (a === b || b === c || c === a) {
      degenerateTriangles++;
      continue;
    }
    const pa = positions[a];
    const pb = positions[b];
    const pc = positions[c];
    const cross = new Vector3().subVectors(pb, pa).cross(new Vector3().subVectors(pc, pa));
    const area2 = cross.length();
    if (area2 <= tolerance * tolerance) degenerateTriangles++;
    signedVolume += pa.dot(new Vector3().crossVectors(pb, pc)) / 6;

    unite(a, b);
    unite(b, c);
    for (const [start, end] of [[a, b], [b, c], [c, a]]) {
      const key = start < end ? `${start}:${end}` : `${end}:${start}`;
      const entry = edgeCounts.get(key);
      if (entry) entry.count++;
      else edgeCounts.set(key, { count: 1, edge: { start, end } });
    }
  }

  const boundary = [...edgeCounts.values()].filter((edge) => edge.count === 1).map(({ edge }) => edge);
  const nonManifoldEdges = [...edgeCounts.values()].filter((edge) => edge.count > 2).length;
  const usedRoots = new Set<number>();
  for (let i = 0; i < positions.length; i++) usedRoots.add(find(i));
  const volume = Math.abs(signedVolume);
  const watertight = boundary.length === 0 && nonManifoldEdges === 0 && degenerateTriangles === 0;

  return {
    ids,
    positions,
    boundary,
    tolerance,
    signedVolume,
    report: {
      triangles: triangleCount,
      vertices: positions.length,
      boundaryEdges: boundary.length,
      nonManifoldEdges,
      degenerateTriangles,
      components: usedRoots.size,
      volume,
      watertight,
      printable: watertight && volume > tolerance ** 3,
    },
  };
}

export function inspectMesh(geometry: BufferGeometry): MeshReport {
  return topologyOf(geometry).report;
}

function removeDegenerateTriangles(geometry: BufferGeometry): BufferGeometry {
  const position = geometry.getAttribute("position");
  const topology = topologyOf(geometry);
  const kept: number[] = [];
  const indexCount = geometry.index?.count ?? position.count;

  for (let i = 0; i + 2 < indexCount; i += 3) {
    const ia = getIndex(geometry, i);
    const ib = getIndex(geometry, i + 1);
    const ic = getIndex(geometry, i + 2);
    const a = topology.ids[ia];
    const b = topology.ids[ib];
    const c = topology.ids[ic];
    if (a === b || b === c || c === a) continue;
    const area = new Vector3()
      .subVectors(topology.positions[b], topology.positions[a])
      .cross(new Vector3().subVectors(topology.positions[c], topology.positions[a]))
      .length();
    if (area <= topology.tolerance ** 2) continue;
    kept.push(
      position.getX(ia), position.getY(ia), position.getZ(ia),
      position.getX(ib), position.getY(ib), position.getZ(ib),
      position.getX(ic), position.getY(ic), position.getZ(ic),
    );
  }

  return makePositionGeometry(kept);
}

function splitBoundaryComponents(geometry: BufferGeometry): {
  open: BufferGeometry;
  closed: BufferGeometry;
  openFaces: number;
} {
  const topology = topologyOf(geometry);
  const position = geometry.getAttribute("position");
  const indexCount = geometry.index?.count ?? position.count;
  const faceCount = Math.floor(indexCount / 3);
  const parent = Array.from({ length: faceCount }, (_value, face) => face);
  const find = (face: number): number => {
    while (parent[face] !== face) {
      parent[face] = parent[parent[face]];
      face = parent[face];
    }
    return face;
  };
  const unite = (a: number, b: number) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const firstFaceAtVertex = new Map<number, number>();
  const edgeFaces = new Map<string, { count: number; face: number }>();
  const faceVertices: number[][] = [];

  for (let face = 0; face < faceCount; face++) {
    const vertices = [0, 1, 2].map((corner) => topology.ids[getIndex(geometry, face * 3 + corner)]);
    faceVertices.push(vertices);
    for (const vertex of vertices) {
      const firstFace = firstFaceAtVertex.get(vertex);
      if (firstFace === undefined) firstFaceAtVertex.set(vertex, face);
      else unite(face, firstFace);
    }
    for (const [a, b] of [[vertices[0], vertices[1]], [vertices[1], vertices[2]], [vertices[2], vertices[0]]]) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const entry = edgeFaces.get(key);
      if (entry) entry.count++;
      else edgeFaces.set(key, { count: 1, face });
    }
  }

  const openRoots = new Set<number>();
  for (const edge of edgeFaces.values()) {
    if (edge.count === 1) openRoots.add(find(edge.face));
  }
  const openTriangles: number[] = [];
  const closedTriangles: number[] = [];
  for (let face = 0; face < faceCount; face++) {
    const destination = openRoots.has(find(face)) ? openTriangles : closedTriangles;
    for (let corner = 0; corner < 3; corner++) {
      const vertex = getIndex(geometry, face * 3 + corner);
      destination.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex));
    }
  }
  return {
    open: makePositionGeometry(openTriangles),
    closed: makePositionGeometry(closedTriangles),
    openFaces: openTriangles.length / 9,
  };
}

function thickenSurface(
  geometry: BufferGeometry,
  thicknessMm: number,
  side: RepairSettings["surfaceSide"],
): BufferGeometry {
  if (!geometry.getAttribute("position") || geometry.getAttribute("position").count < 3) {
    throw new Error("Surface thickening needs at least one triangle.");
  }
  const working = geometry.index ? geometry.clone() : mergeVertices(geometry, 1e-7);
  if (!working.index) {
    const indexed = mergeVertices(working, 1e-7);
    working.dispose();
    return thickenSurface(indexed, thicknessMm, side);
  }
  working.computeBoundingBox();
  working.computeVertexNormals();
  const topology = topologyOf(working);
  const halfThickness = Math.max(0.1, thicknessMm) / 2;
  const center = working.boundingBox?.getCenter(new Vector3()) ?? new Vector3();
  const normalSums = topology.positions.map(() => new Vector3());
  const index = working.index!;
  for (let i = 0; i + 2 < index.count; i += 3) {
    const a = topology.ids[index.getX(i)];
    const b = topology.ids[index.getX(i + 1)];
    const c = topology.ids[index.getX(i + 2)];
    const normal = new Vector3()
      .subVectors(topology.positions[b], topology.positions[a])
      .cross(new Vector3().subVectors(topology.positions[c], topology.positions[a]));
    normalSums[a].add(normal);
    normalSums[b].add(normal);
    normalSums[c].add(normal);
  }
  const orientation = topology.report.watertight && topology.signedVolume < 0 ? -1 : 1;
  const normals = normalSums.map((normal, id) => {
    if (normal.lengthSq() > 1e-12) return normal.multiplyScalar(orientation).normalize();
    return topology.positions[id].clone().sub(center).normalize();
  });
  const outerDistance = side === "outside" ? Math.max(0.1, thicknessMm) : side === "both" ? halfThickness : 0;
  const innerDistance = side === "inside" ? -Math.max(0.1, thicknessMm) : side === "both" ? -halfThickness : 0;
  const outer = topology.positions.map((point, id) => point.clone().addScaledVector(normals[id], outerDistance));
  const inner = topology.positions.map((point, id) => point.clone().addScaledVector(normals[id], innerDistance));
  const positions: number[] = [];
  const pushTriangle = (a: Vector3, b: Vector3, c: Vector3) => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };
  for (let i = 0; i + 2 < index.count; i += 3) {
    const a = topology.ids[index.getX(i)];
    const b = topology.ids[index.getX(i + 1)];
    const c = topology.ids[index.getX(i + 2)];
    pushTriangle(outer[a], outer[b], outer[c]);
    pushTriangle(inner[c], inner[b], inner[a]);
  }
  for (const { start, end } of topology.boundary) {
    pushTriangle(outer[start], outer[end], inner[end]);
    pushTriangle(outer[start], inner[end], inner[start]);
  }
  working.dispose();
  const result = makePositionGeometry(positions);
  result.computeVertexNormals();
  return result;
}

export function repairMesh(
  source: BufferGeometry,
  settings: RepairSettings = DEFAULT_SETTINGS,
): RepairResult {
  let geometry = source.clone();
  const original = topologyOf(source).report;
  if (settings.weldVertices) {
    geometry = mergeVertices(geometry, Math.max(settings.weldTolerance, 1e-9));
  }
  const afterWeld = topologyOf(geometry).report;
  const weldedVertices = Math.max(0, original.vertices - afterWeld.vertices);
  const beforeDegenerateRemoval = afterWeld.triangles;
  if (settings.removeDegenerate) geometry = removeDegenerateTriangles(geometry);
  const removedTriangles = Math.max(0, beforeDegenerateRemoval - topologyOf(geometry).report.triangles);
  let cappedHoles = 0;
  let cappedBoundaryEdges = 0;
  let patchVertices = 0;
  let preservedRims = 0;
  let fallbackHoles = 0;
  const skippedHoles: SkippedHole[] = [];
  let thickenedFaces = 0;
  const closeHoles = (target: BufferGeometry) => {
    if (!settings.closeHoles) return target;
    const result = fillHoles(target, {
      method: settings.holeFillMethod,
      maxHoleEdges: Math.floor(settings.maxHoleEdges),
      keepOuterRim: settings.keepOuterRim,
      maxHoleRatio: settings.maxHoleRatio,
      fair: settings.fairHoles,
    });
    cappedHoles += result.cappedHoles;
    cappedBoundaryEdges += result.cappedBoundaryEdges;
    patchVertices += result.patchVertices;
    preservedRims += result.preservedRims;
    fallbackHoles += result.fallbackHoles;
    skippedHoles.push(...result.skippedHoles);
    if (result.geometry !== target) target.dispose();
    return result.geometry;
  };

  if (settings.addWallThickness && settings.thicknessScope === "single-sided") {
    const split = splitBoundaryComponents(geometry);
    geometry.dispose();
    if (split.openFaces > 0) {
      const selected = closeHoles(split.open);
      const thickened = thickenSurface(selected, settings.wallThicknessMm, settings.surfaceSide);
      thickenedFaces = Math.floor(selected.getAttribute("position").count / 3);
      selected.dispose();
      const unchanged = split.closed.getAttribute("position").count > 0
        ? closeHoles(split.closed)
        : split.closed;
      const positions: number[] = [];
      for (const component of [unchanged, thickened]) {
        const attribute = component.getAttribute("position");
        for (let vertex = 0; vertex < attribute.count; vertex++) {
          positions.push(attribute.getX(vertex), attribute.getY(vertex), attribute.getZ(vertex));
        }
        component.dispose();
      }
      geometry = makePositionGeometry(positions);
    } else {
      geometry = closeHoles(split.closed);
      split.open.dispose();
    }
  } else {
    geometry = closeHoles(geometry);
    if (settings.addWallThickness) {
      thickenedFaces = Math.floor((geometry.index?.count ?? geometry.getAttribute("position").count) / 3);
      const thickened = thickenSurface(geometry, settings.wallThicknessMm, settings.surfaceSide);
      geometry.dispose();
      geometry = thickened;
    }
  }
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  const remainingBoundaryEdges = topologyOf(geometry).report.boundaryEdges;
  const summary = {
    weldedVertices,
    removedTriangles,
    cappedHoles,
    cappedBoundaryEdges,
    remainingBoundaryEdges,
    patchVertices,
    preservedRims,
    fallbackHoles,
    skippedHoles,
    thickenedFaces,
    wallThicknessEnabled: settings.addWallThickness,
    wallThicknessMm: settings.wallThicknessMm,
    thicknessScope: settings.thicknessScope,
    surfaceSide: settings.surfaceSide,
    changed: true,
  };
  return { geometry, summary };
}

export function boundsOf(geometry: BufferGeometry): Vector3 {
  geometry.computeBoundingBox();
  return geometry.boundingBox?.getSize(new Vector3()) ?? new Vector3();
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value);
}

export function newDefaultSettings(): RepairSettings {
  return { ...DEFAULT_SETTINGS };
}

export function asMesh(geometry: BufferGeometry): Mesh {
  return new Mesh(geometry);
}
