import { describe, expect, it } from "vitest";
import {
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  Float32BufferAttribute,
  SphereGeometry,
  Vector3,
} from "three";
import { inspectMesh, newDefaultSettings, repairMesh, type RepairSettings } from "./mesh";

type Triangle = [Vector3, Vector3, Vector3];

function trianglesOf(geometry: BufferGeometry): Triangle[] {
  const source = geometry.index ? geometry.toNonIndexed() : geometry;
  const position = source.getAttribute("position");
  const triangles: Triangle[] = [];
  for (let i = 0; i + 2 < position.count; i += 3) {
    triangles.push([0, 1, 2].map((corner) => new Vector3().fromBufferAttribute(position, i + corner)) as Triangle);
  }
  return triangles;
}

function fromTriangles(triangles: Triangle[]): BufferGeometry {
  return new BufferGeometry().setAttribute(
    "position",
    new Float32BufferAttribute(triangles.flatMap((triangle) => triangle.flatMap((point) => point.toArray())), 3),
  );
}

function withoutTriangles(geometry: BufferGeometry, remove: (centroid: Vector3, triangle: Triangle) => boolean) {
  return fromTriangles(trianglesOf(geometry).filter((triangle) => !remove(centroidOf(triangle), triangle)));
}

function centroidOf([a, b, c]: Triangle): Vector3 {
  return new Vector3().add(a).add(b).add(c).divideScalar(3);
}

/** Triangles in `output` that were not in `input`. */
function addedTriangles(input: BufferGeometry, output: BufferGeometry): Triangle[] {
  const key = (triangle: Triangle) =>
    triangle.map((point) => point.toArray().map((value) => value.toFixed(4)).join(",")).sort().join("|");
  const original = new Set(trianglesOf(input).map(key));
  return trianglesOf(output).filter((triangle) => !original.has(key(triangle)));
}

/** An n × n grid over [-1, 1]² with z = height(x, y), skipping cells where `hole` is true. */
function gridSheet(n: number, height: (x: number, y: number) => number, hole: (i: number, j: number) => boolean) {
  const point = (i: number, j: number) => {
    const x = -1 + (2 * i) / n;
    const y = -1 + (2 * j) / n;
    return new Vector3(x, y, height(x, y));
  };
  const triangles: Triangle[] = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (hole(i, j)) continue;
      triangles.push([point(i, j), point(i + 1, j), point(i + 1, j + 1)]);
      triangles.push([point(i, j), point(i + 1, j + 1), point(i, j + 1)]);
    }
  }
  return fromTriangles(triangles);
}

function edgeFlow(overrides: Partial<RepairSettings> = {}): RepairSettings {
  return {
    ...newDefaultSettings(),
    holeFillMethod: "edge-flow",
    addWallThickness: false,
    weldTolerance: 1e-4,
    ...overrides,
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

describe("edge-flow hole filling", () => {
  it("keeps a planar hole flat when no interior vertices are needed", () => {
    const open = withoutTriangles(new BoxGeometry(1, 1, 1), (centroid) => Math.abs(centroid.x - 0.5) < 1e-6);
    const repaired = repairMesh(open, edgeFlow());
    expect(inspectMesh(repaired.geometry)).toMatchObject({ watertight: true, printable: true });
    for (const triangle of addedTriangles(open, repaired.geometry)) {
      for (const point of triangle) expect(point.x).toBeCloseTo(0.5, 6);
    }
  });

  it("restores the curvature of a removed spherical cap", () => {
    const sphere = new SphereGeometry(10, 64, 32);
    const open = withoutTriangles(sphere, (centroid) => centroid.y > 10 * Math.cos(Math.PI / 6));
    const curved = repairMesh(open, edgeFlow());
    const flat = repairMesh(open, edgeFlow({ holeFillMethod: "planar" }));
    expect(inspectMesh(curved.geometry)).toMatchObject({ watertight: true, nonManifoldEdges: 0 });
    expect(curved.summary.patchVertices).toBeGreaterThan(0);
    const patchPoints = (geometry: BufferGeometry) => addedTriangles(open, geometry).flat();
    const top = (geometry: BufferGeometry) => Math.max(...patchPoints(geometry).map((point) => point.y));
    expect(mean(patchPoints(curved.geometry).map((point) => point.length()))).toBeGreaterThan(0.98 * 10);
    expect(top(flat.geometry)).toBeLessThan(8.9);
    expect(top(curved.geometry)).toBeGreaterThan(9.7);
  });

  it("follows a saddle surface across a non-planar hole", () => {
    const saddle = (x: number, y: number) => x * x - y * y;
    const sheet = gridSheet(16, saddle, (i, j) => i >= 5 && i < 11 && j >= 5 && j < 11);
    const repaired = repairMesh(sheet, edgeFlow());
    const flat = repairMesh(sheet, edgeFlow({ holeFillMethod: "planar" }));
    expect(repaired.summary).toMatchObject({ cappedHoles: 1, preservedRims: 1 });
    expect(inspectMesh(repaired.geometry).nonManifoldEdges).toBe(0);
    const error = (geometry: BufferGeometry) => mean(addedTriangles(sheet, geometry).map((triangle) => {
      const centroid = centroidOf(triangle);
      return Math.abs(centroid.z - saddle(centroid.x, centroid.y));
    }));
    expect(error(repaired.geometry)).toBeLessThan(0.5 * error(flat.geometry));
    for (const triangle of addedTriangles(sheet, repaired.geometry)) {
      const normal = new Vector3().subVectors(triangle[1], triangle[0]).cross(new Vector3().subVectors(triangle[2], triangle[0]));
      expect(normal.z).toBeGreaterThan(0);
    }
  });

  it("matches the surrounding edge density and curvature on a cylinder", () => {
    const step = (2 * Math.PI) / 64;
    const cylinder = new CylinderGeometry(5, 5, 10, 64, 16);
    const open = withoutTriangles(cylinder, (centroid) => {
      const angle = Math.atan2(centroid.x, centroid.z);
      return Math.hypot(centroid.x, centroid.z) > 4 && angle > 0 && angle < 12 * step && Math.abs(centroid.y) < 2.5;
    });
    expect(inspectMesh(open).boundaryEdges).toBe(40);
    const repaired = repairMesh(open, edgeFlow());
    expect(inspectMesh(repaired.geometry)).toMatchObject({ watertight: true, nonManifoldEdges: 0 });
    const patch = addedTriangles(open, repaired.geometry);
    const lengths = patch.flatMap(([a, b, c]) => [a.distanceTo(b), b.distanceTo(c), c.distanceTo(a)]);
    // 24 edges around the circumference and 16 along the axis.
    const rimEdge = (24 * 2 * 5 * Math.sin(step / 2) + 16 * 0.625) / 40;
    expect(Math.min(...lengths)).toBeGreaterThan(0.5 * rimEdge * 0.5);
    expect(mean(lengths)).toBeGreaterThan(0.5 * rimEdge);
    expect(mean(lengths)).toBeLessThan(2 * rimEdge);
    expect(mean(patch.map((triangle) => Math.hypot(centroidOf(triangle).x, centroidOf(triangle).z)))).toBeGreaterThan(4.85);
  });

  it("fills a hole in an open sheet and keeps its outer rim open", () => {
    const sheet = gridSheet(8, () => 0, (i, j) => i >= 3 && i < 5 && j >= 3 && j < 5);
    const repaired = repairMesh(sheet, edgeFlow());
    expect(repaired.summary).toMatchObject({ cappedHoles: 1, preservedRims: 1, cappedBoundaryEdges: 8 });
    expect(inspectMesh(repaired.geometry)).toMatchObject({ boundaryEdges: 32, nonManifoldEdges: 0 });
    for (const triangle of addedTriangles(sheet, repaired.geometry)) {
      for (const point of triangle) expect(point.z).toBeCloseTo(0, 6);
    }
  });

  it("caps the outer rim too when keeping it open is turned off", () => {
    const sheet = gridSheet(4, () => 0, () => false);
    const kept = repairMesh(sheet, edgeFlow());
    expect(kept.summary).toMatchObject({ cappedHoles: 0, preservedRims: 1 });
    const capped = repairMesh(sheet, edgeFlow({ keepOuterRim: false }));
    expect(capped.summary).toMatchObject({ cappedHoles: 1, preservedRims: 0 });
  });

  it("thickens a holed sheet as a sheet in single-sided mode", () => {
    const sheet = gridSheet(8, () => 0, (i, j) => i >= 3 && i < 5 && j >= 3 && j < 5);
    const repaired = repairMesh(sheet, edgeFlow({
      addWallThickness: true,
      thicknessScope: "single-sided",
      surfaceSide: "both",
      wallThicknessMm: 0.2,
    }));
    repaired.geometry.computeBoundingBox();
    expect(inspectMesh(repaired.geometry)).toMatchObject({ watertight: true, printable: true });
    expect(repaired.summary).toMatchObject({ cappedHoles: 1, preservedRims: 1 });
    expect(repaired.geometry.boundingBox!.max.z).toBeCloseTo(0.1, 5);
  });

  it("fills two holes that touch at a single vertex", () => {
    const box = new BoxGeometry(1, 1, 1, 4, 4, 4);
    const cell = (value: number) => Math.floor((value + 0.5) * 4);
    const open = withoutTriangles(box, (centroid) => Math.abs(centroid.y - 0.5) < 1e-6 &&
      ((cell(centroid.x) === 1 && cell(centroid.z) === 1) || (cell(centroid.x) === 2 && cell(centroid.z) === 2)));
    expect(inspectMesh(open).boundaryEdges).toBe(8);
    for (const holeFillMethod of ["planar", "edge-flow"] as const) {
      const repaired = repairMesh(open, edgeFlow({ holeFillMethod }));
      expect(repaired.summary.cappedHoles, holeFillMethod).toBe(2);
      expect(inspectMesh(repaired.geometry), holeFillMethod).toMatchObject({ watertight: true, nonManifoldEdges: 0 });
    }
  });

  it("splits a 1,000-edge hole and fills it without falling back to a planar cap", () => {
    const open = withoutTriangles(new CylinderGeometry(10, 10, 10, 1000, 1), (_centroid, triangle) =>
      triangle.every((point) => Math.abs(point.y - 5) < 1e-6));
    expect(inspectMesh(open).boundaryEdges).toBe(1000);
    const repaired = repairMesh(open, edgeFlow({ maxHoleEdges: 1000 }));
    expect(repaired.summary).toMatchObject({ cappedHoles: 1, fallbackHoles: 0, skippedHoles: [] });
    expect(inspectMesh(repaired.geometry)).toMatchObject({ watertight: true, nonManifoldEdges: 0 });
  }, 20_000);

  it("reports holes over the edge limit instead of skipping them silently", () => {
    const open = withoutTriangles(new CylinderGeometry(10, 10, 10, 64, 1), (_centroid, triangle) =>
      triangle.every((point) => Math.abs(point.y - 5) < 1e-6));
    const repaired = repairMesh(open, edgeFlow({ maxHoleEdges: 32 }));
    expect(repaired.summary.cappedHoles).toBe(0);
    expect(repaired.summary.skippedHoles).toEqual([{ edges: 64, reason: "more than 32 boundary edges" }]);
  });

  it("fills a 300-edge hole in under a second", () => {
    const open = withoutTriangles(new CylinderGeometry(10, 10, 10, 300, 1), (_centroid, triangle) =>
      triangle.every((point) => Math.abs(point.y - 5) < 1e-6));
    const started = performance.now();
    const repaired = repairMesh(open, edgeFlow({ maxHoleEdges: 300 }));
    const elapsed = performance.now() - started;
    expect(repaired.summary.cappedHoles).toBe(1);
    expect(elapsed).toBeLessThan(1000);
  }, 20_000);
});
