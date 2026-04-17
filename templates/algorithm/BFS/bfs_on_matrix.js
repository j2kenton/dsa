const DIRECTIONS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

function traverseMatrix(matrix, startNode) {
  const rows = matrix.length;
  const cols = matrix[0].length;

  let queue = [startNode];
  const seen = new Set([stringifyNode(startNode)]);
  while (queue.length) {
    const nextLevel = [];

    for (const node of queue) {
      // DO SOME LOGIC FOR CURRENT NODE AT THIS POINT

      const { row, col } = node;

      for (const [dr, dc] of DIRECTIONS) {
        const nr = row + dr;
        const nc = col + dc;
        const nextNode = { row: nr, col: nc };
        const key = stringifyNode(nextNode);

        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && !seen.has(key)) {
          // DO LOGIC AT THIS POINT
          seen.add(key);
          nextLevel.push(nextNode);
        }
      }
    }

    queue = nextLevel;
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

function stringifyNode(node) {
  const { row, col } = node;
  return [row, col].join(",");
}
