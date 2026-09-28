/** Pure delegation-event tree assembly. Produces a forest, never a single root. */

import type { DelegationEvent } from "@freebuddy/protocol/delegation";

/** Minimum event shape needed to assemble and lay out the tree. */
export type DelegationTreeEventLike = Pick<
  DelegationEvent,
  "id" | "parentEventId" | "depth"
>;

export interface DelegationTreeNode<
  T extends DelegationTreeEventLike = DelegationEvent
> {
  event: T;
  children: Array<DelegationTreeNode<T>>;
  /**
   * Depth derived from the parentEventId chain.
   * Layout must use this, not `event.depth`: a repaired parent link would make
   * the declared depth jump.
   */
  depth: number;
  /** parentEventId references an event that is not in the input. */
  orphaned: boolean;
  /** A cycle broke this node's parent link, so it became a root. */
  repaired: boolean;
  /** Total descendants, regardless of collapse state. */
  descendantCount: number;
}

export type DelegationTreeWarning =
  | { kind: "duplicate-id"; eventId: string }
  | { kind: "orphan-parent"; eventId: string; parentEventId: string }
  | { kind: "cycle"; eventId: string; parentEventId: string }
  | {
      kind: "depth-mismatch";
      eventId: string;
      declaredDepth: number;
      computedDepth: number;
    };

export interface DelegationForest<
  T extends DelegationTreeEventLike = DelegationEvent
> {
  /**
   * Multiple roots are normal: pausing a run cancels the active events and
   * resuming inserts a fresh depth-0 event, so a single run can hold several.
   */
  roots: Array<DelegationTreeNode<T>>;
  byId: Map<string, DelegationTreeNode<T>>;
  warnings: DelegationTreeWarning[];
}

export interface FlatDelegationNode<
  T extends DelegationTreeEventLike = DelegationEvent
> {
  node: DelegationTreeNode<T>;
  depth: number;
  isLastChild: boolean;
  /** 1-based position among its siblings, for aria-posinset. */
  posInSet: number;
  /** Number of siblings, for aria-setsize. */
  setSize: number;
}

/**
 * Assemble events into a forest keyed by parentEventId.
 *
 * Sibling order follows the input order, which `listDelegationEvents` already
 * guarantees (`ORDER BY COALESCE(accepted_at, started_at) ASC`). Passing an
 * unordered array yields a deterministic but arbitrary sibling order.
 */
export function buildDelegationForest<T extends DelegationTreeEventLike>(
  events: readonly T[]
): DelegationForest<T> {
  const warnings: DelegationTreeWarning[] = [];
  const byId = new Map<string, DelegationTreeNode<T>>();
  const ordered: Array<DelegationTreeNode<T>> = [];

  for (const event of events) {
    if (byId.has(event.id)) {
      warnings.push({ kind: "duplicate-id", eventId: event.id });
      continue;
    }
    const node: DelegationTreeNode<T> = {
      event,
      children: [],
      depth: 0,
      orphaned: false,
      repaired: false,
      descendantCount: 0
    };
    byId.set(event.id, node);
    ordered.push(node);
  }

  // Effective parent per node; null means root.
  const parentOf = new Map<string, string | null>();
  for (const node of ordered) {
    const parentId = node.event.parentEventId;
    if (parentId === null || parentId === undefined) {
      parentOf.set(node.event.id, null);
    } else if (byId.has(parentId)) {
      parentOf.set(node.event.id, parentId);
    } else {
      parentOf.set(node.event.id, null);
      node.orphaned = true;
      warnings.push({
        kind: "orphan-parent",
        eventId: node.event.id,
        parentEventId: parentId
      });
    }
  }

  // Break cycles (parent_event_id has no foreign key, so corrupt rows are
  // possible). Without this the depth walk below would never terminate.
  const settled = new Set<string>();
  for (const node of ordered) {
    if (settled.has(node.event.id)) continue;
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | null = node.event.id;
    while (cursor !== null && !settled.has(cursor)) {
      if (onPath.has(cursor)) {
        warnings.push({
          kind: "cycle",
          eventId: cursor,
          parentEventId: String(parentOf.get(cursor) ?? "")
        });
        parentOf.set(cursor, null);
        byId.get(cursor)!.repaired = true;
        break;
      }
      onPath.add(cursor);
      path.push(cursor);
      cursor = parentOf.get(cursor) ?? null;
    }
    for (const id of path) settled.add(id);
  }

  const depthOf = new Map<string, number>();
  const computeDepth = (id: string): number => {
    const cached = depthOf.get(id);
    if (cached !== undefined) return cached;
    const parentId = parentOf.get(id) ?? null;
    const depth = parentId === null ? 0 : computeDepth(parentId) + 1;
    depthOf.set(id, depth);
    return depth;
  };

  const roots: Array<DelegationTreeNode<T>> = [];
  for (const node of ordered) {
    const id = node.event.id;
    node.depth = computeDepth(id);
    if (node.depth !== node.event.depth) {
      warnings.push({
        kind: "depth-mismatch",
        eventId: id,
        declaredDepth: node.event.depth,
        computedDepth: node.depth
      });
    }
    const parentId = parentOf.get(id) ?? null;
    if (parentId === null) roots.push(node);
    else byId.get(parentId)!.children.push(node);
  }

  const countDescendants = (node: DelegationTreeNode<T>): void => {
    let total = 0;
    for (const child of node.children) {
      countDescendants(child);
      total += 1 + child.descendantCount;
    }
    node.descendantCount = total;
  };
  for (const root of roots) countDescendants(root);

  return { roots, byId, warnings };
}

/**
 * Depth-first pre-order flattening for a row-based layout, skipping the
 * descendants of collapsed nodes. Sibling order is preserved.
 */
export function flattenDelegationForest<T extends DelegationTreeEventLike>(
  forest: DelegationForest<T>,
  options?: { isExpanded?: (node: DelegationTreeNode<T>) => boolean }
): Array<FlatDelegationNode<T>> {
  const isExpanded = options?.isExpanded;
  const flat: Array<FlatDelegationNode<T>> = [];

  const visit = (nodes: Array<DelegationTreeNode<T>>): void => {
    nodes.forEach((node, index) => {
      flat.push({
        node,
        depth: node.depth,
        isLastChild: index === nodes.length - 1,
        posInSet: index + 1,
        setSize: nodes.length
      });
      if (node.children.length === 0) return;
      if (isExpanded && !isExpanded(node)) return;
      visit(node.children);
    });
  };

  visit(forest.roots);
  return flat;
}
