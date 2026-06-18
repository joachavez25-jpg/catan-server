
'use strict';

const RESOURCE_TYPES = ['wood', 'brick', 'wheat', 'sheep', 'ore', 'desert'];

const STANDARD_RESOURCE_COUNTS = {
  wood: 4,
  brick: 3,
  wheat: 4,
  sheep: 4,
  ore: 3,
  desert: 1,
};

const STANDARD_NUMBER_TOKENS = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

const HEX_DIRECTIONS = [
  { q: 1, r: 0 },
  { q: 1, r: -1 },
  { q: 0, r: -1 },
  { q: -1, r: 0 },
  { q: -1, r: 1 },
  { q: 0, r: 1 },
];

function hexId(q, r) {
  return `${q},${r}`;
}

function generateHexCells() {
  const cells = [];
  const radius = 2;
  for (let q = -radius; q <= radius; q++) {
    const r1 = Math.max(-radius, -q - radius);
    const r2 = Math.min(radius, -q + radius);
    for (let r = r1; r <= r2; r++) {
      cells.push({ q, r, id: hexId(q, r) });
    }
  }
  return cells;
}

function axialToPixel(q, r, size = 50) {
  const x = size * (Math.sqrt(3) * q + (Math.sqrt(3) / 2) * r);
  const y = size * (1.5 * r);
  return { x, y };
}

function hexCorners(centerX, centerY, size = 50) {
  const corners = [];
  for (let i = 0; i < 6; i++) {
    const angleDeg = 60 * i - 30;
    const angleRad = (Math.PI / 180) * angleDeg;
    corners.push({
      x: centerX + size * Math.cos(angleRad),
      y: centerY + size * Math.sin(angleRad),
    });
  }
  return corners;
}

function pointKey(x, y) {
  return `${Math.round(x * 100)}:${Math.round(y * 100)}`;
}

function buildGraph(cells, size = 50) {
  const vertices = new Map();
  const hexVertices = new Map();

  for (const cell of cells) {
    const { x: cx, y: cy } = axialToPixel(cell.q, cell.r, size);
    const corners = hexCorners(cx, cy, size);
    const vIds = [];
    for (const corner of corners) {
      const key = pointKey(corner.x, corner.y);
      if (!vertices.has(key)) {
        vertices.set(key, {
          id: key,
          x: corner.x,
          y: corner.y,
          hexes: [],
          adjacentVertices: new Set(),
          building: null,
        });
      }
      const v = vertices.get(key);
      if (!v.hexes.includes(cell.id)) v.hexes.push(cell.id);
      vIds.push(key);
    }
    hexVertices.set(cell.id, vIds);

    for (let i = 0; i < 6; i++) {
      const a = vIds[i];
      const b = vIds[(i + 1) % 6];
      vertices.get(a).adjacentVertices.add(b);
      vertices.get(b).adjacentVertices.add(a);
    }
  }

  const edges = new Map();
  for (const v of vertices.values()) {
    for (const adjId of v.adjacentVertices) {
      const edgeKey = [v.id, adjId].sort().join('|');
      if (!edges.has(edgeKey)) {
        const other = vertices.get(adjId);
        const sharedHexes = v.hexes.filter((h) => other.hexes.includes(h));
        edges.set(edgeKey, {
          id: edgeKey,
          vertexA: v.id,
          vertexB: adjId,
          hexes: sharedHexes,
          road: null,
        });
      }
    }
  }

  return { vertices, edges, hexVertices };
}

function assignResourcesAndNumbers(cells, rng = Math.random) {
  const resourcePool = [];
  for (const [type, count] of Object.entries(STANDARD_RESOURCE_COUNTS)) {
    for (let i = 0; i < count; i++) resourcePool.push(type);
  }
  shuffleInPlace(resourcePool, rng);

  const cellsWithResources = cells.map((cell, i) => ({
    ...cell,
    resource: resourcePool[i],
  }));

  const numberPool = [...STANDARD_NUMBER_TOKENS];
  shuffleInPlace(numberPool, rng);

  let attempt = 0;
  let assigned;
  do {
    assigned = tryAssignNumbers(cellsWithResources, numberPool, rng);
    attempt++;
  } while (!assigned.ok && attempt < 50);

  return assigned.cells;
}

function tryAssignNumbers(cellsWithResources, numberPool, rng) {
  const pool = [...numberPool];
  shuffleInPlace(pool, rng);
  const result = cellsWithResources.map((c) => ({ ...c, number: null, hasRobber: false }));

  let poolIdx = 0;

  for (const cell of result) {
    if (cell.resource === 'desert') {
      cell.hasRobber = true;
      continue;
    }
    const num = pool[poolIdx++];
    cell.number = num;
  }

  const highProbCells = result.filter((c) => c.number === 6 || c.number === 8);
  let adjacentHighProb = false;
  for (const a of highProbCells) {
    for (const b of highProbCells) {
      if (a.id === b.id) continue;
      if (areHexesAdjacent(a, b)) adjacentHighProb = true;
    }
  }

  return { ok: !adjacentHighProb, cells: result };
}

function areHexesAdjacent(cellA, cellB) {
  return HEX_DIRECTIONS.some((d) => cellA.q + d.q === cellB.q && cellA.r + d.r === cellB.r);
}

function shuffleInPlace(arr, rng = Math.random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const STANDARD_PORTS = [
  'generic', 'generic', 'generic', 'generic',
  'wood', 'brick', 'wheat', 'sheep', 'ore',
];

function assignPorts(cells, vertices, hexVertices, rng = Math.random) {
  const cellMap = new Map(cells.map((c) => [c.id, c]));
  const edgeCells = cells.filter((cell) => {
    const neighborCount = HEX_DIRECTIONS.filter((d) =>
      cellMap.has(hexId(cell.q + d.q, cell.r + d.r))
    ).length;
    return neighborCount < 6;
  });

  shuffleInPlace(edgeCells, rng);
  const portTypes = shuffleInPlace([...STANDARD_PORTS], rng);
  const ports = [];
  const usedVertexPairs = new Set();

  for (let i = 0; i < portTypes.length && i < edgeCells.length; i++) {
    const cell = edgeCells[i];
    const vIds = hexVertices.get(cell.id);
    let placed = false;
    for (let k = 0; k < 6 && !placed; k++) {
      const vA = vIds[k];
      const vB = vIds[(k + 1) % 6];
      const pairKey = [vA, vB].sort().join('|');
      if (usedVertexPairs.has(pairKey)) continue;
      ports.push({ type: portTypes[i], vertexA: vA, vertexB: vB, hex: cell.id });
      usedVertexPairs.add(pairKey);
      placed = true;
    }
  }

  return ports;
}

function generateBoard(rng = Math.random) {
  const baseCells = generateHexCells();
  const cellsWithResources = assignResourcesAndNumbers(baseCells, rng);
  const { vertices, edges, hexVertices } = buildGraph(cellsWithResources);
  const ports = assignPorts(cellsWithResources, vertices, hexVertices, rng);

  return {
    hexes: cellsWithResources,
    vertices,
    edges,
    hexVertices,
    ports,
  };
}

module.exports = {
  RESOURCE_TYPES,
  STANDARD_RESOURCE_COUNTS,
  STANDARD_NUMBER_TOKENS,
  STANDARD_PORTS,
  HEX_DIRECTIONS,
  hexId,
  generateHexCells,
  axialToPixel,
  hexCorners,
  buildGraph,
  assignResourcesAndNumbers,
  assignPorts,
  generateBoard,
  areHexesAdjacent,
  shuffleInPlace,
};