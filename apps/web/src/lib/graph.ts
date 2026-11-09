import type { FlowEdge } from "@baitnet/shared";

export interface GNode {
  id: string;
  layer: number;
  x: number;
  y: number;
}
export interface GEdge extends FlowEdge {
  key: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
export interface Layout {
  nodes: GNode[];
  edges: GEdge[];
  width: number;
  height: number;
  nodeW: number;
  nodeH: number;
}

/** Layered (top -> bottom) DAG layout via longest path from sources. Cycles are cut by a depth cap. */
export function layoutFlow(edges: FlowEdge[], opts: { nodeW?: number; nodeH?: number; rowH?: number; gap?: number } = {}): Layout {
  const nodeW = opts.nodeW ?? 168;
  const nodeH = opts.nodeH ?? 48;
  const rowH = opts.rowH ?? 120;
  const gap = opts.gap ?? 28;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const e of [...edges].sort((a, b) => (a.ts < b.ts ? -1 : 1)))
    for (const n of [e.from, e.to]) if (!seen.has(n)) (seen.add(n), ids.push(n));

  const layer = new Map<string, number>(ids.map((id) => [id, 0]));
  const cap = ids.length;
  for (let iter = 0; iter < cap; iter++) {
    let changed = false;
    for (const e of edges) {
      const want = (layer.get(e.from) ?? 0) + 1;
      if (e.from !== e.to && want > (layer.get(e.to) ?? 0) && want < cap) {
        layer.set(e.to, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const rows: string[][] = [];
  for (const id of ids) (rows[layer.get(id)!] ??= []).push(id);
  const compact = rows.filter(Boolean);
  const maxRow = Math.max(1, ...compact.map((r) => r.length));
  const width = Math.max(nodeW + 2 * gap, maxRow * nodeW + (maxRow + 1) * gap);
  const pos = new Map<string, GNode>();
  compact.forEach((row, li) => {
    const rowW = row.length * nodeW + (row.length - 1) * gap;
    const x0 = (width - rowW) / 2;
    row.forEach((id, i) => pos.set(id, { id, layer: li, x: x0 + i * (nodeW + gap), y: 16 + li * rowH }));
  });
  const height = 16 * 2 + (compact.length - 1) * rowH + nodeH;
  const gEdges = edges.map((e, i) => {
    const a = pos.get(e.from)!;
    const b = pos.get(e.to)!;
    return { ...e, key: `${i}`, x1: a.x + nodeW / 2, y1: a.y + nodeH, x2: b.x + nodeW / 2, y2: b.y };
  });
  return { nodes: [...pos.values()], edges: gEdges, width, height, nodeW, nodeH };
}
