import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AmbientLight,
  AxesHelper,
  BufferGeometry,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import {
  boundsOf,
  formatNumber,
  inspectMesh,
  loadMesh,
  newDefaultSettings,
  repairMesh,
  type MeshReport,
  type RepairSummary,
  type RepairSettings,
} from "./mesh";

interface ViewPose {
  viewKey: string;
  position: [number, number, number];
  target: [number, number, number];
}

function ModelViewport({
  geometry,
  color,
  label,
  viewKey,
}: {
  geometry: BufferGeometry | null;
  color: string;
  label: string;
  viewKey: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const poseRef = useRef<ViewPose | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const scene = new Scene();
    const camera = new PerspectiveCamera(42, 1, 0.01, 100000);
    camera.position.set(3.5, 2.8, 4.5);
    const renderer = new WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.outputColorSpace = "srgb";
    container.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    scene.add(new AmbientLight(0xffffff, 1.8));
    const keyLight = new DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(4, 6, 5);
    scene.add(keyLight);
    const fillLight = new DirectionalLight(0x94baff, 0.8);
    fillLight.position.set(-4, 2, -3);
    scene.add(fillLight);
    const grid = new GridHelper(10, 20, 0x3a4657, 0x26313e);
    grid.position.y = -0.52;
    scene.add(grid);
    const axes = new AxesHelper(0.7);
    axes.position.set(-4.8, -0.5, -4.8);
    scene.add(axes);

    let model: Mesh | undefined;
    if (geometry) {
      geometry.computeBoundingBox();
      const bounds = boundsOf(geometry);
      const center = geometry.boundingBox!.getCenter(geometry.boundingBox!.min.clone());
      model = new Mesh(
        geometry,
        new MeshStandardMaterial({ color, roughness: 0.56, metalness: 0.05, side: DoubleSide }),
      );
      model.position.copy(center).negate();
      scene.add(model);
      const extent = Math.max(bounds.x, bounds.y, bounds.z, 0.01);
      camera.near = Math.max(extent / 10000, 0.0001);
      camera.far = extent * 100;
      camera.updateProjectionMatrix();
      controls.minDistance = extent * 0.05;
      controls.maxDistance = extent * 25;
      const savedPose = poseRef.current?.viewKey === viewKey ? poseRef.current : null;
      if (savedPose) {
        controls.target.fromArray(savedPose.target);
        camera.position.fromArray(savedPose.position);
      } else {
        controls.target.set(0, 0, 0);
        camera.position.set(extent * 1.7, extent * 1.25, extent * 2.1);
      }
      controls.update();
      grid.scale.setScalar(extent / 5);
      axes.scale.setScalar(extent);
    }

    const savePose = () => {
      poseRef.current = {
        viewKey,
        position: camera.position.toArray(),
        target: controls.target.toArray(),
      };
    };
    controls.addEventListener("change", savePose);
    savePose();

    let frame = 0;
    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      frame = requestAnimationFrame(render);
    };
    render();

    const resize = new ResizeObserver(() => {
      camera.aspect = container.clientWidth / Math.max(container.clientHeight, 1);
      camera.updateProjectionMatrix();
      renderer.setSize(container.clientWidth, container.clientHeight);
    });
    resize.observe(container);

    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      savePose();
      controls.removeEventListener("change", savePose);
      controls.dispose();
      if (model) {
        if (Array.isArray(model.material)) model.material.forEach((material) => material.dispose());
        else model.material.dispose();
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [geometry, color, viewKey]);

  return (
    <div className="viewport">
      <div className="viewport-label">{label}</div>
      <div className="viewport-canvas" ref={containerRef} />
      {!geometry && (
        <div className="viewport-empty">
          <span className="empty-cube">◇</span>
          <span>Load a model to begin</span>
          <small>STL · OBJ · 3MF</small>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, good }: { label: string; value: string; good?: boolean }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={good === undefined ? "" : good ? "good" : "bad"}>{value}</strong>
    </div>
  );
}

function ReportCard({ report, title }: { report: MeshReport | null; title: string }) {
  return (
    <section className="report-card">
      <div className="section-heading">
        <h3>{title}</h3>
        {report && (
          <span className={`status-pill ${report.printable ? "status-good" : "status-warn"}`}>
            <i />
            {report.printable ? "BASIC CHECKS PASS" : "NEEDS ATTENTION"}
          </span>
        )}
      </div>
      {!report ? (
        <p className="muted small">Load a model to inspect its mesh.</p>
      ) : (
        <div className="metric-grid">
          <Metric label="Triangles" value={formatNumber(report.triangles)} />
          <Metric label="Vertices" value={formatNumber(report.vertices)} />
          <Metric label="Boundary edges" value={formatNumber(report.boundaryEdges)} good={report.boundaryEdges === 0} />
          <Metric label="Non-manifold edges" value={formatNumber(report.nonManifoldEdges)} good={report.nonManifoldEdges === 0} />
          <Metric label="Degenerate faces" value={formatNumber(report.degenerateTriangles)} good={report.degenerateTriangles === 0} />
          <Metric label="Connected shells" value={formatNumber(report.components)} />
          <Metric label="Enclosed volume" value={`${formatNumber(report.volume)} mm³`} />
          <Metric label="Watertight" value={report.watertight ? "Yes" : "No"} good={report.watertight} />
        </div>
      )}
    </section>
  );
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const originalRef = useRef<BufferGeometry | null>(null);
  const repairedRef = useRef<BufferGeometry | null>(null);
  const [original, setOriginal] = useState<BufferGeometry | null>(null);
  const [repaired, setRepaired] = useState<BufferGeometry | null>(null);
  const [fileName, setFileName] = useState("");
  const [settings, setSettings] = useState<RepairSettings>(newDefaultSettings);
  const [repairSummary, setRepairSummary] = useState<RepairSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("");
  const [messageKind, setMessageKind] = useState<"info" | "error">("info");

  const originalReport = useMemo(() => (original ? inspectMesh(original) : null), [original]);
  const repairedReport = useMemo(() => (repaired ? inspectMesh(repaired) : null), [repaired]);
  const activeGeometry = repaired ?? original;

  const showMessage = useCallback((text: string, kind: "info" | "error" = "info") => {
    setMessage(text);
    setMessageKind(kind);
  }, []);

  const importFile = useCallback(async (file?: File) => {
    if (!file || busy) return;
    setBusy(true);
    setMessage("");
    try {
      const geometry = await loadMesh(file);
      geometry.computeVertexNormals();
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      originalRef.current?.dispose();
      repairedRef.current?.dispose();
      originalRef.current = geometry;
      repairedRef.current = null;
      setOriginal(geometry);
      setRepaired(null);
      setRepairSummary(null);
      setFileName(file.name);
      showMessage(`${file.name} loaded. The original model is kept unchanged.`, "info");
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "The model could not be opened.", "error");
    } finally {
      setBusy(false);
    }
  }, [busy, showMessage]);

  const updateSetting = <K extends keyof RepairSettings>(key: K, value: RepairSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const runRepair = async () => {
    if (!original) return;
    setBusy(true);
    setMessage("");
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    try {
      const result = repairMesh(original, settings);
      const report = inspectMesh(result.geometry);
      repairedRef.current?.dispose();
      repairedRef.current = result.geometry;
      setRepaired(result.geometry);
      setRepairSummary(result.summary);
      showMessage(
        result.summary.wallThicknessEnabled && result.summary.thickenedFaces === 0
          ? `No open-boundary surface components were found. No wall thickness was added; ${result.summary.cappedHoles} holes capped.`
          : result.summary.changed
          ? `Repair changed the mesh: ${result.summary.weldedVertices} vertices welded, ${result.summary.removedTriangles} degenerate faces removed, ${result.summary.cappedHoles} holes capped.`
          : report.printable
            ? "No geometry changes were needed: the model already passes the selected mesh checks."
            : "No geometry changes were made. The selected fixes found nothing they could safely repair; see the boundary and defect counts below.",
        report.printable ? "info" : "error",
      );
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "Mesh repair failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const exportStl = async () => {
    if (!activeGeometry) return;
    const report = inspectMesh(activeGeometry);
    const exportMessage = report.printable
      ? "STL exported. The mesh passed the basic closure checks."
      : `STL exported with warnings: ${formatNumber(report.boundaryEdges)} boundary edges, ${formatNumber(report.nonManifoldEdges)} non-manifold edges, and ${formatNumber(report.degenerateTriangles)} degenerate faces. Check it in a slicer before printing.`;
    try {
      const result = new STLExporter().parse(new Mesh(activeGeometry), { binary: true });
      const bytes = new Uint8Array(result.byteLength);
      bytes.set(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
      const suggestedName = `${fileName.replace(/\.[^.]+$/, "") || "model"}-export.stl`;
      if (window.meshcraft) {
        const saved = await window.meshcraft.saveStl(suggestedName, bytes.buffer);
        if (saved) showMessage(exportMessage, report.printable ? "info" : "error");
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: "model/stl" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = suggestedName;
        anchor.click();
        URL.revokeObjectURL(url);
        showMessage(exportMessage, report.printable ? "info" : "error");
      }
    } catch (error) {
      showMessage(error instanceof Error ? error.message : "STL export failed.", "error");
    }
  };

  useEffect(() => () => {
    originalRef.current?.dispose();
    repairedRef.current?.dispose();
  }, []);

  return (
    <main
      className={`app-shell ${dragging ? "is-dragging" : ""}`}
      onDragOver={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        setDragging(false);
      }}
      onDrop={(event) => {
        if (!Array.from(event.dataTransfer.types).includes("Files")) return;
        event.preventDefault();
        setDragging(false);
        void importFile(event.dataTransfer.files[0]);
      }}
    >
      <input
        ref={inputRef}
        className="hidden-input"
        type="file"
        accept=".stl,.obj,.3mf,model/stl,model/obj,application/vnd.ms-package.3dmanufacturing-3dmodel+xml"
        onChange={(event) => {
          void importFile(event.target.files?.[0]);
          event.target.value = "";
        }}
      />
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">M</div>
          <div>
            <strong>meshcraft</strong>
            <span>3D PRINT PREP</span>
          </div>
        </div>
        <div className="topbar-workspace">
          <button className="button button-secondary import-button" onClick={() => inputRef.current?.click()} disabled={busy}>
            <span className="button-icon">＋</span> Import model
          </button>
          <div className="topbar-center">
            <span className="local-indicator" />
            LOCAL WORKSPACE
            <span className="topbar-divider">/</span>
            {fileName || "NO MODEL LOADED"}
          </div>
        </div>
        <div className="topbar-actions">
          <button className="button button-primary repair-button" onClick={() => void runRepair()} disabled={!original || busy}>
            {busy ? <span className="spinner" /> : <span>✦</span>}
            {busy ? "Working…" : repaired ? "Apply repair again" : "Run repair"}
          </button>
          <button
            className="button button-secondary export-button"
            onClick={() => void exportStl()}
            disabled={!activeGeometry || busy}
          >
            Export STL <span>↗</span>
          </button>
        </div>
      </header>

      <div className="workspace">
        <section className="main-column">
          <div className="page-title">
            <div>
              <p className="eyebrow">LOCAL MESH WORKBENCH</p>
              <h1>Make your model printable.</h1>
              <p className="muted">Inspect mesh integrity, repair common defects, and export a checked STL.</p>
            </div>
            <div className="file-chip">
              <span className="file-icon">▱</span>
              <span>{fileName || "No file selected"}</span>
            </div>
          </div>

          <div className="preview-heading">
            <div>
              <h2>Model preview</h2>
              <span className="muted small">Drag to orbit · scroll to zoom</span>
            </div>
            {original && (
              <span className="dimensions">
                {(() => {
                  const size = boundsOf(original);
                  return `${formatNumber(size.x)} × ${formatNumber(size.y)} × ${formatNumber(size.z)} mm`;
                })()}
              </span>
            )}
          </div>

          <div className="preview-grid">
            <ModelViewport geometry={original} color="#94b8ed" label="ORIGINAL" viewKey={fileName} />
            <ModelViewport
              geometry={repaired ?? original}
              color={repaired ? "#69dbb2" : "#53657d"}
              label={repaired ? "REPAIRED · ACTIVE" : "REPAIRED · RUN A REPAIR"}
              viewKey={fileName}
            />
          </div>

          {dragging && <div className="drop-overlay">Drop an STL, OBJ, or 3MF model to open it</div>}
          {message && (
            <div className={`message message-${messageKind}`} role="status">
              <span>{messageKind === "error" ? "!" : "✓"}</span>
              {message}
            </div>
          )}

          <div className="reports">
            <ReportCard report={originalReport} title="Original mesh" />
            <ReportCard report={repairedReport} title="Repaired mesh" />
          </div>
          {repairSummary && (
            <div className={`repair-summary ${repairSummary.changed ? "" : "repair-summary-unchanged"}`}>
              <strong>
                {repairSummary.wallThicknessEnabled
                  ? `Surface thickening · ${repairSummary.surfaceSide} · ${formatNumber(repairSummary.wallThicknessMm)} mm`
                  : "Surface thickening disabled"}
              </strong>
              <span>
                {repairSummary.weldedVertices} vertices welded · {repairSummary.removedTriangles} degenerate faces removed ·{" "}
                {repairSummary.cappedHoles} holes capped ({repairSummary.cappedBoundaryEdges} boundary edges)
              </span>
              {repairSummary.wallThicknessEnabled && (
                <span>{formatNumber(repairSummary.thickenedFaces)} faces thickened ({repairSummary.thicknessScope === "all" ? "all surfaces" : "open-boundary components"})</span>
              )}
              {repairSummary.remainingBoundaryEdges > 0 && (
                <span className="repair-summary-hint">
                  {formatNumber(repairSummary.remainingBoundaryEdges)} boundary edges remain. Raise weld tolerance or maximum hole size if appropriate; branched, non-manifold, or self-intersecting defects require a different repair tool.
                </span>
              )}
            </div>
          )}
          <div className="repair-note repair-note-centered">
            <span>ⓘ</span>
            STL/OBJ units are assumed to be millimeters; 3MF units are converted. Surface thickening retains detail but may leave intersections. Check the output in a slicer.
          </div>
          <p className="privacy-note privacy-note-centered"><span>⬡</span> Models are processed locally and stay on this device.</p>
        </section>

        <aside className="settings-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">REPAIR WORKFLOW</p>
              <h2>Mesh repair</h2>
            </div>
            <span className="spark-icon">✳</span>
          </div>
          <p className="panel-description">Choose which common mesh issues to fix. Your source model is never overwritten.</p>

          <div className="settings-section">
            <div className="settings-heading">
              <h3>Repair operations</h3>
              <span>SELECT FIXES</span>
            </div>
            <label className="toggle-row">
              <span><strong>Weld nearby vertices</strong><small>Join duplicate points within tolerance</small></span>
              <input type="checkbox" checked={settings.weldVertices} onChange={(event) => updateSetting("weldVertices", event.target.checked)} />
            </label>
            <label className="toggle-row">
              <span><strong>Remove degenerate faces</strong><small>Drop zero-area triangles</small></span>
              <input type="checkbox" checked={settings.removeDegenerate} onChange={(event) => updateSetting("removeDegenerate", event.target.checked)} />
            </label>
            <label className="toggle-row">
              <span><strong>Close small holes</strong><small>Cap simple, closed boundary loops</small></span>
              <input type="checkbox" checked={settings.closeHoles} onChange={(event) => updateSetting("closeHoles", event.target.checked)} />
            </label>
            <label className="toggle-row">
              <span><strong>Add wall thickness</strong><small>Offset the surface to create a wall</small></span>
              <input type="checkbox" checked={settings.addWallThickness} onChange={(event) => updateSetting("addWallThickness", event.target.checked)} />
            </label>
          </div>

          <div className="settings-section slider-section">
            <div className="slider-label">
              <div><strong>Weld tolerance</strong><small>Distance in millimeters</small></div>
              <code>{Number(settings.weldTolerance.toFixed(4))} mm</code>
            </div>
            <input
              type="range"
              min="-4"
              max="0"
              step="0.1"
              value={Math.log10(settings.weldTolerance)}
              onChange={(event) => updateSetting("weldTolerance", 10 ** Number(event.target.value))}
              disabled={!settings.weldVertices}
              aria-label="Weld tolerance"
            />
            <div className="range-labels"><span>Precise</span><span>More aggressive</span></div>
          </div>

          <div className="settings-section slider-section">
            <div className="slider-label">
              <div><strong>Maximum hole size</strong><small>Boundary edges per loop to cap</small></div>
              <code>{settings.maxHoleEdges} edges</code>
            </div>
            <input
              type="range"
              min="3"
              max="240"
              step="1"
              value={settings.maxHoleEdges}
              onChange={(event) => updateSetting("maxHoleEdges", Number(event.target.value))}
              disabled={!settings.closeHoles}
              aria-label="Maximum boundary edges per hole"
            />
            <div className="range-labels"><span>Small openings</span><span>Larger openings</span></div>
          </div>

          <div className="settings-section slider-section">
            <div className="slider-label">
              <div><strong>Wall thickness</strong><small>Target thickness in millimeters</small></div>
              <code>{settings.wallThicknessMm.toFixed(1)} mm</code>
            </div>
            <input
              type="range"
              min="0.1"
              max="10"
              step="0.1"
              value={settings.wallThicknessMm}
              onChange={(event) => updateSetting("wallThicknessMm", Number(event.target.value))}
              disabled={!settings.addWallThickness}
              aria-label="Wall thickness in millimeters"
            />
            <div className="range-labels"><span>0.1 mm</span><span>10 mm</span></div>
          </div>

          {settings.addWallThickness && (
            <div className="settings-section">
              <div className="settings-heading">
                <h3>Surfaces to thicken</h3>
                <span>WALL COVERAGE</span>
              </div>
              {([
                ["all", "All surfaces", "Add thickness to every surface component."],
                ["single-sided", "Only single-sided faces", "Thicken components connected to open boundary edges; leave closed components unchanged."],
              ] as const).map(([scope, label, description]) => (
                <label key={scope} className={`coverage-option ${settings.thicknessScope === scope ? "selected" : ""}`}>
                  <input
                    type="radio"
                    name="thickness-scope"
                    checked={settings.thicknessScope === scope}
                    onChange={() => updateSetting("thicknessScope", scope)}
                  />
                  <span><strong>{label}</strong><small>{description}</small></span>
                </label>
              ))}
            </div>
          )}

          {settings.addWallThickness && (
            <div className="settings-section">
              <div className="settings-heading">
                <h3>Thicken toward</h3>
                <span>SURFACE SIDE</span>
              </div>
              <div className="side-options">
                {([
                  ["outside", "Outside"],
                  ["inside", "Inside"],
                  ["both", "Both sides"],
                ] as const).map(([side, label]) => (
                  <label key={side} className={`side-option ${settings.surfaceSide === side ? "selected" : ""}`}>
                    <input
                      type="radio"
                      name="surface-side"
                      checked={settings.surfaceSide === side}
                      onChange={() => updateSetting("surfaceSide", side)}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <p className="side-help">
                {settings.surfaceSide === "both"
                  ? "Half the wall thickness is added to each side."
                  : `The full wall thickness is added to the ${settings.surfaceSide}.`}
              </p>
            </div>
          )}

        </aside>
      </div>
      <footer className="statusbar">
        <span><i className="local-indicator" /> Offline-capable local processing</span>
        <span>STL · OBJ · 3MF <b>•</b> STL EXPORT</span>
      </footer>
    </main>
  );
}
