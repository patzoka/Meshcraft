import { BufferAttribute, BufferGeometry } from "three";
import { repairMesh, type RepairSettings, type RepairSummary } from "./mesh";

export interface RepairRequest {
  id: number;
  positions: Float32Array;
  settings: RepairSettings;
}

export type RepairResponse =
  | { id: number; positions: Float32Array; generatedFaces: Uint8Array; summary: RepairSummary }
  | { id: number; error: string };

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RepairRequest>) => void) | null;
  postMessage(message: RepairResponse, transfer?: Transferable[]): void;
};

scope.onmessage = ({ data }) => {
  try {
    const source = new BufferGeometry();
    source.setAttribute("position", new BufferAttribute(data.positions, 3));
    const { geometry, summary, generatedFaces } = repairMesh(source, data.settings);
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    const positions = new Float32Array(flat.getAttribute("position").array);
    scope.postMessage({ id: data.id, positions, generatedFaces, summary }, [positions.buffer, generatedFaces.buffer]);
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : "Mesh repair failed." });
  }
};
