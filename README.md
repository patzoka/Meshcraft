# Meshcraft

A local-first desktop app for importing STL, OBJ, and 3MF triangle meshes, inspecting common topology defects, applying basic repairs to a copy, and exporting binary STL.

## Run it

Requires Node.js 22.12+.

```powershell
npm install
npm run dev
```

Build the renderer and run the mesh tests:

```powershell
npm run build
npm test
```

Launch the built desktop app with `npm start`.

## Build a Windows app for other PCs

On a Windows x64 machine with Node.js 22.12+ installed, run:

```powershell
npm install
npm run dist:win
```

The `release` folder contains:

- `Meshcraft Setup 0.1.0.exe` — standard per-user installer with Start Menu and optional desktop shortcuts. Copy this installer to each Windows x64 PC and run it there.
- `Meshcraft-0.1.0-Portable.exe` — portable build that can be run without installing; each machine still needs permission to launch downloaded applications.

Recipients do not need Node.js or Python. Meshcraft processes models locally. These builds are currently unsigned, so Windows SmartScreen or antivirus may warn when they are first downloaded or launched. For broader distribution, sign the installer and portable executable with a trusted code-signing certificate before sharing. Build and sign on a trusted machine, and share the generated installer (or portable executable) rather than the project folder.

## Workflow

1. Import an `.stl`, `.obj`, or `.3mf` file, or drop it into the app.
2. Review the original mesh diagnostics and rotate/zoom the previews.
3. Choose whether to weld nearby vertices, remove zero-area triangles, cap simple boundary loops, and add wall thickness. Turn **Add wall thickness** off to skip surface offsets while keeping hole repair available. Adjust the millimeter weld tolerance and maximum hole perimeter to fit the model.
4. For wall thickness, choose **All surfaces** or **Only single-sided faces**. The latter thickens connected surface components that have open boundary edges and leaves already-closed components unchanged. Choose outside, inside, or both sides (half the thickness per side), then set the thickness in 0.1 mm increments.
5. Run repair to create a separate working copy. The app reports the number of vertices welded, faces removed, holes capped, faces thickened, and remaining boundary edges, alongside the before/after topology reports.
6. Export the active mesh as binary STL at any point, even if repair fails or mesh checks still report defects. The app warns when the exported model has boundary edges, non-manifold edges, degenerate faces, or zero volume; verify it in a slicer before printing.

Processing is local; model data is not uploaded. STL and OBJ do not encode physical units, so their coordinates are assumed to be millimeters. 3MF model units are normalized to millimeters during import.

## Limitations

This is a first-pass mesh repair tool, not a slicer or a guarantee of printability. Surface thickening offsets the source triangles in the selected direction and can create intersections on tightly curved or self-crossing geometry. For open surfaces, direction follows triangle winding. **Only single-sided faces** applies to entire connected mesh components with open boundary edges; it does not identify individual face back sides, and already-closed components are left unchanged. Hole filling is intended for simple boundary loops; non-manifold junctions, self-intersections, inconsistent winding, and severe topology defects may still need work in a dedicated mesh editor. Always inspect the repaired preview and run the exported STL through a slicer before printing. A successful topology check does not establish printer-specific suitability.
