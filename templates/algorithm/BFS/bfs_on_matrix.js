const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function traverseMatrix(startNode) {
  const queue = [startNode];
  const seen = new Set([startNode]);
  while (queue.length) {
    const currentLength = queue.length;

    for (let i = 0; i < currentLength; i++) {
      const node = queue[i];
      const newQueue = [];

      for (const neighbor of getNeighbors(node)) {
        if (!seen.has(neighbor)) {
          // DO LOGIC AT THIS POINT
          seen.add(neighbor);
          newQueue.push(neighbor);
        }
      }
    }
  }
}

function getNeighbors(node) {
  const { row, col } = node;
  const result = [];
  for (const direction of DIRECTIONS) {
    const [deltaRow, deltaCol] = direction;
    result.push({ row: row + deltaRow, col: col + deltaCol });
  }
  return result;
}
