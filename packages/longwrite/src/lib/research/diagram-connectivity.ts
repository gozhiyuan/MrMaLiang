export type DiagramGraphSpec = {
  nodes: Array<{ id: string; label: string }>;
  edges: Array<{ from: string; to: string; label?: string }>;
};

/** Union-find over node ids, treating edges as undirected for the purpose of
 * "does this diagram read as one connected system" — a loop drawn with
 * arrows is still one component even though its edges are directional. */
export function connectedComponents(spec: DiagramGraphSpec): string[][] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let curr = x;
    while (parent.get(curr) !== root) {
      const next = parent.get(curr)!;
      parent.set(curr, root);
      curr = next;
    }
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const node of spec.nodes) find(node.id);
  for (const edge of spec.edges) {
    find(edge.from);
    find(edge.to);
    union(edge.from, edge.to);
  }
  const groups = new Map<string, string[]>();
  for (const node of spec.nodes) {
    const root = find(node.id);
    const group = groups.get(root) ?? [];
    group.push(node.id);
    groups.set(root, group);
  }
  return [...groups.values()];
}

export function isFullyConnected(spec: DiagramGraphSpec): boolean {
  return connectedComponents(spec).length <= 1;
}
