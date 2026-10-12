import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Mesh } from "three";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { inspectMesh, loadMesh, newDefaultSettings, repairMesh, threeMfScaleToMillimeters } from "./mesh";

function openCube(): BufferGeometry {
  const cube = new BoxGeometry(1, 1, 1).toNonIndexed();
  const positions = cube.getAttribute("position");
  const remaining: number[] = [];
  for (let face = 0; face < positions.count / 3; face++) {
    const x = positions.getX(face * 3);
    if (
      Math.abs(x - 0.5) < 1e-6 &&
      Math.abs(positions.getX(face * 3 + 1) - x) < 1e-6 &&
      Math.abs(positions.getX(face * 3 + 2) - x) < 1e-6
    ) continue;
    remaining.push(
      positions.getX(face * 3), positions.getY(face * 3), positions.getZ(face * 3),
      positions.getX(face * 3 + 1), positions.getY(face * 3 + 1), positions.getZ(face * 3 + 1),
      positions.getX(face * 3 + 2), positions.getY(face * 3 + 2), positions.getZ(face * 3 + 2),
    );
  }
  return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(remaining, 3));
}

describe("mesh diagnostics and repair", () => {
  it.skipIf(!existsSync("TEST_STL"))("repairs sample vehicle STLs with surface thickening", () => {
    const directory = "TEST_STL";
    for (const name of readdirSync(directory).filter((entry) => entry.toLowerCase().endsWith(".stl"))) {
      const bytes = readFileSync(`${directory}/${name}`);
      const geometry = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      const repaired = repairMesh(geometry, newDefaultSettings());
      expect(repaired.geometry.getAttribute("position").count, name).toBeGreaterThan(0);
      expect(repaired.summary.thickenedFaces, name).toBeGreaterThan(0);
      repaired.geometry.dispose();
      geometry.dispose();
    }
  });

  it("recognizes a closed box as watertight and printable", () => {
    const report = inspectMesh(new BoxGeometry(1, 1, 1));
    expect(report.watertight).toBe(true);
    expect(report.printable).toBe(true);
    expect(report.boundaryEdges).toBe(0);
  });

  it("detects open boundaries and closes a simple missing face", () => {
    const open = openCube();
    expect(inspectMesh(open).boundaryEdges).toBeGreaterThan(0);
    const repaired = repairMesh(open, {
      ...newDefaultSettings(),
      weldVertices: true,
      removeDegenerate: true,
      closeHoles: true,
      maxHoleEdges: 80,
      weldTolerance: 1e-5,
    });
    expect(inspectMesh(repaired.geometry)).toMatchObject({
      printable: true,
      watertight: true,
      boundaryEdges: 0,
      nonManifoldEdges: 0,
    });
    expect(repaired.summary).toMatchObject({ cappedHoles: 1, cappedBoundaryEdges: 4, changed: true });
    const unrepaired = repairMesh(open, {
      ...newDefaultSettings(),
      weldVertices: true,
      removeDegenerate: true,
      closeHoles: false,
      maxHoleEdges: 3,
      weldTolerance: 1e-5,
    });
    expect(unrepaired.summary).toMatchObject({ cappedHoles: 0, changed: true });
    expect(inspectMesh(unrepaired.geometry).watertight).toBe(true);
  });

  it("does not claim a zero-volume sheet is printable", () => {
    const sheet = new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0], 3),
    );
    expect(inspectMesh(sheet).printable).toBe(false);
  });

  it("converts 3MF model units to millimeters", () => {
    const bytes = zipSync({
      "3D/3dmodel.model": strToU8('<model unit="inch"><resources/><build/></model>'),
    });
    const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(threeMfScaleToMillimeters(data)).toBe(25.4);
  });

  it("loads triangle meshes from OBJ and STL", async () => {
    const obj = new File(
      [
        "v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\n",
        "f 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n",
      ],
      "tetra.obj",
    );
    const stl = new File(
      [
        "solid tetra\n",
        "facet normal 0 0 -1\n outer loop\n vertex 0 0 0\n vertex 0 1 0\n vertex 1 0 0\n endloop\nendfacet\n",
        "facet normal 0 -1 0\n outer loop\n vertex 0 0 0\n vertex 1 0 0\n vertex 0 0 1\n endloop\nendfacet\n",
        "facet normal -1 0 0\n outer loop\n vertex 0 0 0\n vertex 0 0 1\n vertex 0 1 0\n endloop\nendfacet\n",
        "facet normal 1 1 1\n outer loop\n vertex 1 0 0\n vertex 0 1 0\n vertex 0 0 1\n endloop\nendfacet\nendsolid tetra\n",
      ],
      "tetra.stl",
    );

    expect(inspectMesh(await loadMesh(obj)).printable).toBe(true);
    expect(inspectMesh(await loadMesh(stl)).printable).toBe(true);
  });

  it("exports a checked mesh as binary STL", () => {
    const exported = new STLExporter().parse(new Mesh(new BoxGeometry(1, 1, 1)), { binary: true });
    const bytes = new Uint8Array(exported.buffer, exported.byteOffset, exported.byteLength);
    const roundTrip = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(inspectMesh(roundTrip).printable).toBe(true);
  });

  it("serializes an open mesh as binary STL so it can still be exported with warnings", () => {
    const exported = new STLExporter().parse(new Mesh(openCube()), { binary: true });
    const bytes = new Uint8Array(exported.buffer, exported.byteOffset, exported.byteLength);
    const roundTrip = new STLLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    expect(inspectMesh(roundTrip).boundaryEdges).toBeGreaterThan(0);
    expect(exported.byteLength).toBeGreaterThan(84);
  });

  it("adds a closed wall around an open surface", () => {
    const repaired = repairMesh(openCube(), {
      ...newDefaultSettings(),
      closeHoles: false,
      wallThicknessMm: 0.1,
    });
    expect(inspectMesh(repaired.geometry)).toMatchObject({ watertight: true, printable: true });
    expect(repaired.summary.wallThicknessMm).toBe(0.1);
  });

  it("skips surface thickening when the option is disabled", () => {
    const plane = new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    const repaired = repairMesh(plane, {
      ...newDefaultSettings(),
      addWallThickness: false,
      weldVertices: false,
      removeDegenerate: false,
      closeHoles: false,
    });
    repaired.geometry.computeBoundingBox();
    expect(repaired.geometry.boundingBox!.min.z).toBeCloseTo(0, 5);
    expect(repaired.geometry.boundingBox!.max.z).toBeCloseTo(0, 5);
    expect(repaired.summary.wallThicknessEnabled).toBe(false);
  });

  it.each([
    ["outside", 0, 1.5],
    ["inside", -1.5, 0],
    ["both", -0.75, 0.75],
  ] as const)("thickens an open surface toward the %s", (surfaceSide, expectedMinZ, expectedMaxZ) => {
    const plane = new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    const repaired = repairMesh(plane, {
      ...newDefaultSettings(),
      closeHoles: false,
      wallThicknessMm: 1.5,
      surfaceSide,
    });
    repaired.geometry.computeBoundingBox();
    expect(inspectMesh(repaired.geometry)).toMatchObject({ watertight: true, printable: true });
    expect(repaired.geometry.boundingBox!.min.z).toBeCloseTo(expectedMinZ, 5);
    expect(repaired.geometry.boundingBox!.max.z).toBeCloseTo(expectedMaxZ, 5);
    expect(repaired.summary.surfaceSide).toBe(surfaceSide);
  });

  it("thickens open components only when single-sided coverage is selected", () => {
    const plane = new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0], 3),
    );
    const closed = new BoxGeometry(1, 1, 1).toNonIndexed();
    closed.translate(5, 0, 0);
    const combined = new BufferGeometry().setAttribute(
      "position",
      new Float32BufferAttribute([
        ...Array.from(plane.getAttribute("position").array),
        ...Array.from(closed.getAttribute("position").array),
      ], 3),
    );
    const repaired = repairMesh(combined, {
      ...newDefaultSettings(),
      closeHoles: false,
      thicknessScope: "single-sided",
      surfaceSide: "both",
    });
    repaired.geometry.computeBoundingBox();
    expect(inspectMesh(repaired.geometry)).toMatchObject({ watertight: true, components: 2 });
    expect(repaired.geometry.boundingBox!.max.x).toBeCloseTo(5.5, 5);
    expect(repaired.summary.thicknessScope).toBe("single-sided");
    expect(repaired.summary.thickenedFaces).toBeGreaterThan(0);
  });

  it("does not add wall thickness to a closed component in single-sided mode", () => {
    const box = new BoxGeometry(2, 2, 2);
    const repaired = repairMesh(box, {
      ...newDefaultSettings(),
      closeHoles: false,
      thicknessScope: "single-sided",
    });
    repaired.geometry.computeBoundingBox();
    expect(repaired.summary.thickenedFaces).toBe(0);
    expect(repaired.geometry.boundingBox!.min.x).toBeCloseTo(-1, 5);
    expect(repaired.geometry.boundingBox!.max.x).toBeCloseTo(1, 5);
  });

  it("thickens closed components when all surfaces are selected", () => {
    const repaired = repairMesh(new BoxGeometry(2, 2, 2), {
      ...newDefaultSettings(),
      closeHoles: false,
      surfaceSide: "both",
    });
    repaired.geometry.computeBoundingBox();
    expect(repaired.geometry.boundingBox!.min.x).toBeLessThan(-1);
    expect(repaired.geometry.boundingBox!.max.x).toBeGreaterThan(1);
    expect(repaired.summary.thicknessScope).toBe("all");
  });
});
