import { BufferAttribute, BufferGeometry } from "three";
import { repairMesh, type RepairResult, type RepairSettings } from "./mesh";
import type { RepairRequest, RepairResponse } from "./repair.worker";

let worker: Worker | null | undefined;
let nextId = 0;

function getWorker(): Worker | null {
  if (worker === undefined) {
    try {
      worker = new Worker(new URL("./repair.worker.ts", import.meta.url), { type: "module" });
    } catch {
      worker = null;
    }
  }
  return worker;
}

function finish(geometry: BufferGeometry): BufferGeometry {
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Runs on this thread after yielding once, so the busy state can paint first. */
function repairHere(source: BufferGeometry, settings: RepairSettings): Promise<RepairResult> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      try {
        resolve(repairMesh(source, settings));
      } catch (error) {
        reject(error);
      }
    }, 0);
  });
}

/**
 * Repairs a copy of `source` in a Web Worker so large models don't freeze the UI. Falls back
 * to the main thread when workers are unavailable or the worker script fails to load.
 */
export function repairInBackground(source: BufferGeometry, settings: RepairSettings): Promise<RepairResult> {
  const active = getWorker();
  if (!active) return repairHere(source, settings);

  const id = ++nextId;
  const flat = source.index ? source.toNonIndexed() : source;
  const positions = new Float32Array(flat.getAttribute("position").array);
  if (flat !== source) flat.dispose();

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      active.removeEventListener("message", onMessage);
      active.removeEventListener("error", onError);
    };
    const onMessage = (event: MessageEvent<RepairResponse>) => {
      if (event.data.id !== id) return;
      cleanup();
      if ("error" in event.data) {
        reject(new Error(event.data.error));
        return;
      }
      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(event.data.positions, 3));
      resolve({ geometry: finish(geometry), summary: event.data.summary });
    };
    const onError = (event: ErrorEvent) => {
      event.preventDefault();
      cleanup();
      active.terminate();
      worker = null;
      repairHere(source, settings).then(resolve, reject);
    };
    active.addEventListener("message", onMessage);
    active.addEventListener("error", onError);
    const request: RepairRequest = { id, positions, settings };
    active.postMessage(request, [positions.buffer]);
  });
}
