import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  AmbientLight,
  AxesHelper,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  GridHelper,
  Group as Object3DGroup,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Info,
  Grid3x3,
  Mouse,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import {
  boundsOf,
  formatNumber,
  inspectMesh,
  loadMesh,
  newDefaultSettings,
  type MeshReport,
  type RepairSummary,
  type RepairSettings,
} from "./mesh";
import { repairInBackground } from "./repairClient";

type ViewMode = "source" | "repaired";
type UpAxis = "y" | "z";

const UP_AXIS_KEY = "meshcraft.upAxis";
const WIREFRAME_KEY = "meshcraft.wireframe";

function readPreference(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writePreference(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable; the choice then lasts for this session only.
  }
}

const readUpAxis = (): UpAxis => (readPreference(UP_AXIS_KEY) === "z" ? "z" : "y");
const readWireframe = () => readPreference(WIREFRAME_KEY) === "1";

interface ViewPose {
  viewKey: string;
  position: [number, number, number];
  target: [number, number, number];
}

/* ---------- Tooltip ---------- */

// Rendered in a portal so the scrolling settings panel never clips it.
function Tooltip({
  content,
  children,
  side = "left",
}: {
  content: ReactNode;
  children: ReactNode;
  side?: "left" | "bottom" | "top";
}) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    if (side === "left") setPosition({ x: rect.left - 10, y: rect.top + rect.height / 2 });
    else if (side === "top") setPosition({ x: rect.left + rect.width / 2, y: rect.top - 10 });
    else setPosition({ x: rect.left + rect.width / 2, y: rect.bottom + 10 });
  };
  const hide = () => setPosition(null);

  return (
    <span
      ref={anchorRef}
      className="tooltip-anchor"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {position &&
        createPortal(
          <div className={`tooltip tooltip-${side}`} style={{ left: position.x, top: position.y }} role="tooltip">
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <Tooltip content={children}>
      <span className="hint" tabIndex={0} aria-label="More information">
        <Info size={13} strokeWidth={1.6} />
      </span>
    </Tooltip>
  );
}

/* ---------- Viewport ---------- */

function ModelViewport({
  geometry,
  color,
  viewKey,
  highlightFaces,
  highlightColor,
  upAxis,
  wireframe,
}: {
  geometry: BufferGeometry | null;
  color: string;
  viewKey: string;
  /** Display-only orientation; the geometry itself is never rotated. */
  upAxis: UpAxis;
  /** Draws triangle edges over the shaded surface. */
  wireframe: boolean;
  /** Per-face flags; flagged faces are drawn in `highlightColor`. Requires non-indexed geometry. */
  highlightFaces?: Uint8Array | null;
  highlightColor?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const poseRef = useRef<ViewPose | null>(null);
  const wireRef = useRef<Mesh | null>(null);
  const wireframeRef = useRef(wireframe);
  wireframeRef.current = wireframe;

  // Toggling the overlay only flips visibility; the scene is not rebuilt.
  useEffect(() => {
    if (wireRef.current) wireRef.current.visible = wireframe;
  }, [wireframe]);

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
    scene.add(new AmbientLight(0xffffff, 1.6));
    const keyLight = new DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(4, 6, 5);
    scene.add(keyLight);
    const fillLight = new DirectionalLight(0xfff1e4, 0.8);
    fillLight.position.set(-4, 2, -3);
    scene.add(fillLight);
    const grid = new GridHelper(10, 20, 0xc4c1b9, 0xdedcd5);
    grid.position.y = -0.52;
    scene.add(grid);
    const axes = new AxesHelper(0.7);
    axes.position.set(-4.8, -0.5, -4.8);
    scene.add(axes);

    let model: Mesh | undefined;
    let wire: Mesh | undefined;
    if (geometry) {
      geometry.computeBoundingBox();
      const bounds = boundsOf(geometry);
      const center = geometry.boundingBox!.getCenter(geometry.boundingBox!.min.clone());
      const position = geometry.getAttribute("position");
      const highlight = !geometry.index && highlightFaces && highlightFaces.length * 3 === position.count;
      if (highlight) {
        const base = new Color(color);
        const accent = new Color(highlightColor);
        const colors = new Float32Array(position.count * 3);
        for (let face = 0; face < highlightFaces.length; face++) {
          const tint = highlightFaces[face] ? accent : base;
          for (let corner = 0; corner < 3; corner++) tint.toArray(colors, (face * 3 + corner) * 3);
        }
        geometry.setAttribute("color", new BufferAttribute(colors, 3));
      }
      model = new Mesh(
        geometry,
        new MeshStandardMaterial({
          color: highlight ? 0xffffff : color,
          vertexColors: !!highlight,
          roughness: 0.62,
          metalness: 0.02,
          side: DoubleSide,
          // Pushes the surface back slightly so the wireframe overlay doesn't z-fight with it.
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1,
        }),
      );
      model.position.copy(center).negate();
      wire = new Mesh(
        geometry,
        new MeshBasicMaterial({ color: 0x101010, wireframe: true, transparent: true, opacity: 0.28, depthWrite: false }),
      );
      wire.visible = wireframeRef.current;
      model.add(wire);
      wireRef.current = wire;
      // Z-up models are turned so their +Z points along the scene's +Y.
      const orientation = upAxis === "z" ? -Math.PI / 2 : 0;
      const display = new Object3DGroup();
      display.rotation.x = orientation;
      display.add(model);
      scene.add(display);
      const extent = Math.max(bounds.x, bounds.y, bounds.z, 0.01);
      const floor = -(upAxis === "z" ? bounds.z : bounds.y) / 2;
      grid.position.set(0, floor, 0);
      axes.rotation.x = orientation;
      axes.position.set(-extent, floor, upAxis === "z" ? extent : -extent);
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
      axes.scale.setScalar(extent / 0.7 / 3);
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
      if (wire) {
        (wire.material as MeshBasicMaterial).dispose();
        if (wireRef.current === wire) wireRef.current = null;
      }
      geometry?.deleteAttribute("color");
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [geometry, color, viewKey, highlightFaces, highlightColor, upAxis]);

  return <div className="viewport-canvas" ref={containerRef} />;
}

/* ---------- Panel building blocks ---------- */

function Switch({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <input
      className="switch"
      type="checkbox"
      checked={checked}
      disabled={disabled}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function Group({
  title,
  hint,
  enabled,
  onToggle,
  defaultOpen = true,
  children,
}: {
  title: string;
  hint?: ReactNode;
  enabled?: boolean;
  onToggle?: (enabled: boolean) => void;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const expanded = open && enabled !== false;
  return (
    <section className={`group ${enabled === false ? "group-off" : ""}`}>
      <header className="group-header">
        <button
          className="group-title"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={expanded}
          disabled={enabled === false}
        >
          {expanded ? <ChevronDown size={14} strokeWidth={1.6} /> : <ChevronRight size={14} strokeWidth={1.6} />}
          {title}
        </button>
        {hint && <Hint>{hint}</Hint>}
        {onToggle && <Switch checked={!!enabled} onChange={onToggle} label={`Enable ${title}`} />}
      </header>
      {expanded && children && <div className="group-body">{children}</div>}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="row">
      <span className="row-label">
        {label}
        {hint && <Hint>{hint}</Hint>}
      </span>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <span className="row-label">
        {label}
        {hint && <Hint>{hint}</Hint>}
      </span>
      {children}
    </div>
  );
}

function Slider({
  label,
  hint,
  value,
  display,
  min,
  max,
  step,
  onChange,
  disabled,
}: {
  label: string;
  hint?: ReactNode;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="slider">
      <div className="row">
        <span className="row-label">
          {label}
          {hint && <Hint>{hint}</Hint>}
        </span>
        <output>{display}</output>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly (readonly [T, string, string?])[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([option, text, tip]) => {
        const button = (
          <button
            key={option}
            role="radio"
            aria-checked={value === option}
            className={value === option ? "active" : ""}
            onClick={() => onChange(option)}
          >
            {text}
          </button>
        );
        return tip ? (
          <Tooltip key={option} content={tip} side="top">
            {button}
          </Tooltip>
        ) : (
          button
        );
      })}
    </div>
  );
}

/* ---------- Inspection ---------- */

const METRICS: { key: keyof MeshReport; label: string; hint?: string; zeroIsGood?: boolean; format?: (report: MeshReport) => string }[] = [
  { key: "triangles", label: "Triangles" },
  { key: "vertices", label: "Vertices" },
  { key: "boundaryEdges", label: "Open edges", hint: "Edges used by only one triangle. Any open edge means the mesh is not closed.", zeroIsGood: true },
  { key: "nonManifoldEdges", label: "Non-manifold", hint: "Edges shared by more than two triangles. Slicers may misread these.", zeroIsGood: true },
  { key: "degenerateTriangles", label: "Degenerate", hint: "Zero-area triangles.", zeroIsGood: true },
  { key: "components", label: "Shells", hint: "Separate connected pieces in the mesh." },
  { key: "volume", label: "Volume mm³", format: (report) => formatNumber(Math.round(report.volume)) },
  { key: "watertight", label: "Watertight", format: (report) => (report.watertight ? "Yes" : "No") },
];

function metricValue(report: MeshReport | null, metric: (typeof METRICS)[number]) {
  if (!report) return { text: "—", tone: "" };
  const raw = report[metric.key];
  const text = metric.format ? metric.format(report) : formatNumber(raw as number);
  let tone = "";
  if (metric.zeroIsGood) tone = raw === 0 ? "good" : "bad";
  if (metric.key === "watertight") tone = report.watertight ? "good" : "bad";
  return { text, tone };
}

function Inspection({ source, repaired }: { source: MeshReport | null; repaired: MeshReport | null }) {
  return (
    <table className="inspection">
      <thead>
        <tr>
          <th />
          <th>Source</th>
          <th>Repaired</th>
        </tr>
      </thead>
      <tbody>
        {METRICS.map((metric) => {
          const a = metricValue(source, metric);
          const b = metricValue(repaired, metric);
          return (
            <tr key={metric.key}>
              <th scope="row">
                {metric.hint ? (
                  <Tooltip content={metric.hint}>
                    <span className="dotted" tabIndex={0}>{metric.label}</span>
                  </Tooltip>
                ) : (
                  metric.label
                )}
              </th>
              <td className={a.tone}>{a.text}</td>
              <td className={b.tone}>{b.text}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function RepairLog({ summary }: { summary: RepairSummary }) {
  const rows: { label: string; value: number; warn?: boolean; hint?: string }[] = [
    { label: "Vertices welded", value: summary.weldedVertices },
    { label: "Faces removed", value: summary.removedTriangles },
    { label: "Holes capped", value: summary.cappedHoles, hint: `${formatNumber(summary.cappedBoundaryEdges)} boundary edges closed.` },
    { label: "Patch vertices", value: summary.patchVertices },
    { label: "Rims kept open", value: summary.preservedRims },
    {
      label: "Flat fallbacks",
      value: summary.fallbackHoles,
      warn: true,
      hint: "These holes could not take an edge-flow patch and were capped flat instead.",
    },
    {
      label: "Holes left open",
      value: summary.skippedHoles.length,
      warn: true,
      hint:
        summary.skippedHoles.slice(0, 4).map((hole) => `${hole.edges} edges: ${hole.reason}`).join("\n") +
        (summary.skippedHoles.length > 4 ? `\n…and ${summary.skippedHoles.length - 4} more` : ""),
    },
    {
      label: "Faces thickened",
      value: summary.thickenedFaces,
      hint: summary.wallThicknessEnabled
        ? `${formatNumber(summary.wallThicknessMm)} mm · ${summary.surfaceSide} · ${summary.thicknessScope === "all" ? "all surfaces" : "open-boundary components"}`
        : undefined,
    },
    {
      label: "Open edges left",
      value: summary.remainingBoundaryEdges,
      warn: true,
      hint: "Raise weld tolerance or maximum hole size if appropriate. Branched, non-manifold or self-intersecting defects need a different tool.",
    },
  ].filter((row) => row.value > 0);

  if (rows.length === 0) return <p className="log-empty">No changes were needed.</p>;
  return (
    <ul className="log">
      {rows.map((row) => (
        <li key={row.label} className={row.warn ? "warn" : ""}>
          <span className="row-label">
            {row.label}
            {row.hint && <Hint>{row.hint}</Hint>}
          </span>
          <span>{formatNumber(row.value)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ---------- App ---------- */

const SOURCE_COLOR = "#a8a49b";
const REPAIRED_COLOR = "#c98a62";
const GENERATED_COLOR = "#d9682f";

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const originalRef = useRef<BufferGeometry | null>(null);
  const repairedRef = useRef<BufferGeometry | null>(null);
  const [original, setOriginal] = useState<BufferGeometry | null>(null);
  const [repaired, setRepaired] = useState<BufferGeometry | null>(null);
  const [view, setView] = useState<ViewMode>("source");
  const [fileName, setFileName] = useState("");
  const [settings, setSettings] = useState<RepairSettings>(newDefaultSettings);
  const [repairedWith, setRepairedWith] = useState<RepairSettings | null>(null);
  const [repairSummary, setRepairSummary] = useState<RepairSummary | null>(null);
  const [generatedFaces, setGeneratedFaces] = useState<Uint8Array | null>(null);
  const [highlightNew, setHighlightNew] = useState(true);
  const [upAxis, setUpAxis] = useState<UpAxis>(readUpAxis);
  const [wireframe, setWireframe] = useState(readWireframe);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [toast, setToast] = useState<{ text: string; kind: "info" | "error"; id: number } | null>(null);

  const originalReport = useMemo(() => (original ? inspectMesh(original) : null), [original]);
  const repairedReport = useMemo(() => (repaired ? inspectMesh(repaired) : null), [repaired]);
  const showingRepaired = view === "repaired" && !!repaired;
  const viewedGeometry = showingRepaired ? repaired : original;
  const viewedReport = showingRepaired ? repairedReport : originalReport;
  const exportGeometry = repaired ?? original;
  const settingsChanged = repairedWith !== null && repairedWith !== settings;
  const generatedCount = useMemo(() => generatedFaces?.reduce((sum, flag) => sum + flag, 0) ?? 0, [generatedFaces]);
  const highlighting = showingRepaired && highlightNew && generatedCount > 0;

  const nextStep: "import" | "repair" | "export" = !original
    ? "import"
    : !repaired || settingsChanged
      ? "repair"
      : "export";

  const showToast = useCallback((text: string, kind: "info" | "error" = "info") => {
    setToast({ text, kind, id: Date.now() });
  }, []);

  useEffect(() => {
    if (!toast || toast.kind === "error") return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const importFile = useCallback(async (file?: File) => {
    if (!file || busy) return;
    setBusy(true);
    setToast(null);
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
      setRepairedWith(null);
      setRepairSummary(null);
      setGeneratedFaces(null);
      setView("source");
      setFileName(file.name);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "The model could not be opened.", "error");
    } finally {
      setBusy(false);
    }
  }, [busy, showToast]);

  const updateSetting = <K extends keyof RepairSettings>(key: K, value: RepairSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const runRepair = async () => {
    if (!original || busy) return;
    setBusy(true);
    setToast(null);
    try {
      const result = await repairInBackground(original, settings);
      const report = inspectMesh(result.geometry);
      repairedRef.current?.dispose();
      repairedRef.current = result.geometry;
      setRepaired(result.geometry);
      setRepairedWith(settings);
      setRepairSummary(result.summary);
      setGeneratedFaces(result.generatedFaces);
      setView("repaired");
      if (report.printable) showToast(result.summary.changed ? "Repaired · basic checks pass" : "No changes needed · basic checks pass");
      else showToast(`${formatNumber(report.boundaryEdges + report.nonManifoldEdges)} defects remain · see Inspection`, "error");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "Mesh repair failed.", "error");
    } finally {
      setBusy(false);
    }
  };

  const exportStl = async () => {
    if (!exportGeometry || busy) return;
    const report = inspectMesh(exportGeometry);
    const exportMessage = report.printable
      ? "Exported STL"
      : `Exported with ${formatNumber(report.boundaryEdges + report.nonManifoldEdges + report.degenerateTriangles)} unresolved defects`;
    try {
      const result = new STLExporter().parse(new Mesh(exportGeometry), { binary: true });
      const bytes = new Uint8Array(result.byteLength);
      bytes.set(new Uint8Array(result.buffer, result.byteOffset, result.byteLength));
      const suggestedName = `${fileName.replace(/\.[^.]+$/, "") || "model"}-export.stl`;
      if (window.meshcraft) {
        const saved = await window.meshcraft.saveStl(suggestedName, bytes.buffer);
        if (saved) showToast(exportMessage, report.printable ? "info" : "error");
      } else {
        const url = URL.createObjectURL(new Blob([bytes], { type: "model/stl" }));
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = suggestedName;
        anchor.click();
        URL.revokeObjectURL(url);
        showToast(exportMessage, report.printable ? "info" : "error");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "STL export failed.", "error");
    }
  };

  // V toggles between source and repaired, H the new-face highlight, W the wireframe.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement) return;
      const key = event.key.toLowerCase();
      if (key === "w" && original) setWireframe((current) => !current);
      if (!repaired) return;
      if (key === "v") setView((current) => (current === "source" ? "repaired" : "source"));
      else if (key === "h") setHighlightNew((current) => !current);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [original, repaired]);

  useEffect(() => writePreference(UP_AXIS_KEY, upAxis), [upAxis]);
  useEffect(() => writePreference(WIREFRAME_KEY, wireframe ? "1" : "0"), [wireframe]);

  useEffect(() => () => {
    originalRef.current?.dispose();
    repairedRef.current?.dispose();
  }, []);

  const size = original ? boundsOf(original) : null;

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
          Mesh<span>craft</span>
        </div>

        <nav className="steps" aria-label="Workflow">
          <Tooltip content="Open an STL, OBJ or 3MF file. You can also drop a file anywhere." side="bottom">
            <button
              className={`step ${nextStep === "import" ? "step-next" : ""}`}
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              <Upload size={15} strokeWidth={1.8} />
              Import
            </button>
          </Tooltip>
          <ChevronRight className="step-arrow" size={14} strokeWidth={1.5} />
          <Tooltip
            content={settingsChanged ? "Settings changed since the last repair." : "Run the selected fixes. The source model is never modified."}
            side="bottom"
          >
            <button
              className={`step ${nextStep === "repair" ? "step-next" : ""}`}
              onClick={() => void runRepair()}
              disabled={!original || busy}
            >
              {busy && original ? <span className="spinner" /> : <Wand2 size={15} strokeWidth={1.8} />}
              Repair
              {settingsChanged && <i className="step-dot" aria-label="Settings changed" />}
            </button>
          </Tooltip>
          <ChevronRight className="step-arrow" size={14} strokeWidth={1.5} />
          <Tooltip
            content={repaired ? "Save the repaired model as binary STL." : "Save the source model as binary STL."}
            side="bottom"
          >
            <button
              className={`step ${nextStep === "export" ? "step-next" : ""}`}
              onClick={() => void exportStl()}
              disabled={!exportGeometry || busy}
            >
              <Download size={15} strokeWidth={1.8} />
              Export
            </button>
          </Tooltip>
        </nav>

        <div className="file-name" title={fileName}>
          {fileName}
        </div>
      </header>

      <div className="workspace">
        <section className="stage">
          <ModelViewport
            geometry={viewedGeometry}
            color={showingRepaired && !highlighting ? REPAIRED_COLOR : SOURCE_COLOR}
            viewKey={fileName}
            highlightFaces={highlighting ? generatedFaces : null}
            highlightColor={GENERATED_COLOR}
            upAxis={upAxis}
            wireframe={wireframe}
          />

          {original && (
            <div className="stage-top">
              <div className="stage-controls">
                <Tooltip content={repaired ? "Switch model (V)" : "Run a repair to compare"} side="bottom">
                  <div className="view-toggle" role="radiogroup" aria-label="Displayed model">
                    <button role="radio" aria-checked={!showingRepaired} className={!showingRepaired ? "active" : ""} onClick={() => setView("source")}>
                      Source
                    </button>
                    <button
                      role="radio"
                      aria-checked={showingRepaired}
                      className={showingRepaired ? "active" : ""}
                      onClick={() => setView("repaired")}
                      disabled={!repaired}
                    >
                      Repaired
                    </button>
                  </div>
                </Tooltip>
                {showingRepaired && generatedCount > 0 && (
                  <Tooltip content="Faces created by the repair: hole patches and rim walls. Toggle highlight (H)" side="bottom">
                    <button
                      className={`legend ${highlightNew ? "active" : ""}`}
                      aria-pressed={highlightNew}
                      onClick={() => setHighlightNew((current) => !current)}
                    >
                      <i style={{ background: GENERATED_COLOR }} />
                      {formatNumber(generatedCount)} new faces
                    </button>
                  </Tooltip>
                )}
              </div>

              {viewedReport && (
                <span className={`status ${viewedReport.printable ? "status-good" : "status-warn"}`}>
                  {viewedReport.printable ? <Check size={13} strokeWidth={2} /> : <AlertTriangle size={13} strokeWidth={1.8} />}
                  {viewedReport.printable ? "Printable" : "Needs repair"}
                </span>
              )}
            </div>
          )}

          {size && (
            <div className="stage-bottom">
              <Tooltip content="STL and OBJ units are assumed to be millimeters; 3MF units are converted." side="top">
                <span className="dimensions" tabIndex={0}>
                  {formatNumber(size.x)} × {formatNumber(size.y)} × {formatNumber(size.z)} mm
                </span>
              </Tooltip>
              <div className="stage-controls">
                <Tooltip content="Wireframe (W)" side="top">
                  <button
                    className={`icon-toggle ${wireframe ? "active" : ""}`}
                    aria-pressed={wireframe}
                    aria-label="Wireframe"
                    onClick={() => setWireframe((current) => !current)}
                  >
                    <Grid3x3 size={15} strokeWidth={1.6} />
                  </button>
                </Tooltip>
                <Tooltip content="Display orientation only. Exported files keep their original axes." side="top">
                  <div className="view-toggle view-toggle-small" role="radiogroup" aria-label="Up axis">
                    {(["y", "z"] as const).map((axis) => (
                      <button
                        key={axis}
                        role="radio"
                        aria-checked={upAxis === axis}
                        className={upAxis === axis ? "active" : ""}
                        onClick={() => setUpAxis(axis)}
                      >
                        {axis}-up
                      </button>
                    ))}
                  </div>
                </Tooltip>
                <Tooltip content="Drag to orbit · Right-drag to pan · Scroll to zoom" side="top">
                  <span className="hint" tabIndex={0} aria-label="Viewport controls">
                    <Mouse size={15} strokeWidth={1.6} />
                  </span>
                </Tooltip>
              </div>
            </div>
          )}

          {!original && (
            <button className="empty" onClick={() => inputRef.current?.click()} disabled={busy}>
              {busy ? <span className="spinner spinner-dark" /> : <Upload size={22} strokeWidth={1.4} />}
              <span>STL · OBJ · 3MF</span>
            </button>
          )}

          {toast && (
            <div key={toast.id} className={`toast toast-${toast.kind}`} role="status">
              {toast.kind === "error" ? <AlertTriangle size={14} strokeWidth={1.8} /> : <Check size={14} strokeWidth={2} />}
              <span>{toast.text}</span>
              <button onClick={() => setToast(null)} aria-label="Dismiss">
                <X size={14} strokeWidth={1.8} />
              </button>
            </div>
          )}

          {dragging && <div className="drop-overlay">Drop to open</div>}
        </section>

        <aside className="panel">
          <Group title="Inspection">
            <Inspection source={originalReport} repaired={repairedReport} />
            {repairSummary && (
              <>
                <h4 className="subhead">Last repair</h4>
                <RepairLog summary={repairSummary} />
              </>
            )}
          </Group>

          <Group
            title="Cleanup"
            hint="Basic fixes applied before anything else."
          >
            <Row label="Weld vertices" hint="Join duplicate points that lie within the weld tolerance.">
              <Switch checked={settings.weldVertices} onChange={(value) => updateSetting("weldVertices", value)} label="Weld vertices" />
            </Row>
            <Slider
              label="Tolerance"
              hint="Maximum distance between points that get welded. Higher values are more aggressive."
              value={Math.log10(settings.weldTolerance)}
              display={`${Number(settings.weldTolerance.toFixed(4))} mm`}
              min={-4}
              max={0}
              step={0.1}
              onChange={(value) => updateSetting("weldTolerance", 10 ** value)}
              disabled={!settings.weldVertices}
            />
            <Row label="Remove degenerate" hint="Drop zero-area triangles.">
              <Switch checked={settings.removeDegenerate} onChange={(value) => updateSetting("removeDegenerate", value)} label="Remove degenerate faces" />
            </Row>
          </Group>

          <Group
            title="Holes"
            hint="Cap simple, closed boundary loops."
            enabled={settings.closeHoles}
            onToggle={(value) => updateSetting("closeHoles", value)}
          >
            <Field label="Patch shape">
              <Segmented
                label="Patch shape"
                value={settings.holeFillMethod}
                onChange={(value) => updateSetting("holeFillMethod", value)}
                options={[
                  ["planar", "Flat cap", "Fast. Triangulates the opening on its best-fit plane, with no new vertices."],
                  ["edge-flow", "Edge flow", "Matches the surrounding triangle size and continues the surface's curvature."],
                ]}
              />
            </Field>
            {settings.holeFillMethod === "edge-flow" && (
              <Row label="Smooth patches" hint="Curve patches to follow the surface. Off keeps them flat.">
                <Switch checked={settings.fairHoles} onChange={(value) => updateSetting("fairHoles", value)} label="Smooth patches" />
              </Row>
            )}
            <Slider
              label="Max size"
              hint="Largest hole to cap, counted in boundary edges per loop."
              value={settings.maxHoleEdges}
              display={`${settings.maxHoleEdges} edges`}
              min={3}
              max={1000}
              step={1}
              onChange={(value) => updateSetting("maxHoleEdges", value)}
            />
            <Row label="Keep outer rims" hint="Don't seal the outside edge of open surfaces, such as a cup's rim.">
              <Switch checked={settings.keepOuterRim} onChange={(value) => updateSetting("keepOuterRim", value)} label="Keep outer rims open" />
            </Row>
            {settings.keepOuterRim && (
              <Slider
                label="Hole vs rim"
                hint="Largest hole to fill, as a share of the outer rim's perimeter."
                value={settings.maxHoleRatio}
                display={`${Math.round(settings.maxHoleRatio * 100)}%`}
                min={0.05}
                max={1}
                step={0.05}
                onChange={(value) => updateSetting("maxHoleRatio", value)}
              />
            )}
          </Group>

          <Group
            title="Wall thickness"
            hint="Offset surfaces to create a printable wall. Keeps detail but may leave self-intersections; check the result in a slicer."
            enabled={settings.addWallThickness}
            onToggle={(value) => updateSetting("addWallThickness", value)}
          >
            <Slider
              label="Thickness"
              value={settings.wallThicknessMm}
              display={`${settings.wallThicknessMm.toFixed(1)} mm`}
              min={0.1}
              max={10}
              step={0.1}
              onChange={(value) => updateSetting("wallThicknessMm", value)}
            />
            <Field label="Direction">
              <Segmented
                label="Thicken toward"
                value={settings.surfaceSide}
                onChange={(value) => updateSetting("surfaceSide", value)}
                options={[
                  ["outside", "Outside", "Add the full thickness outward."],
                  ["inside", "Inside", "Add the full thickness inward."],
                  ["both", "Both", "Add half the thickness to each side."],
                ]}
              />
            </Field>
            <Field label="Apply to">
              <Segmented
                label="Surfaces to thicken"
                value={settings.thicknessScope}
                onChange={(value) => updateSetting("thicknessScope", value)}
                options={[
                  ["all", "All", "Thicken every surface component."],
                  ["single-sided", "Open only", "Thicken only components with open boundary edges; closed parts stay unchanged."],
                ]}
              />
            </Field>
          </Group>
        </aside>
      </div>
    </main>
  );
}
