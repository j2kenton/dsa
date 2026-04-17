const START_NODE_INDEX = 0;

function traverseGraph(adjacencyList) {
  const queue = [];
  const seen = new Set([START_NODE_INDEX]);
  let result = 0;

  while (queue.length) {
    const currentLength = queue.length;
    const nextQueue = [];

    for (let i = 0; i < currentLength; i++) {
      const nodeIndex = queue[i];
      // DO SOME LOGIC AT THIS POINT
      for (const neighbor of adjacencyList[nodeIndex]) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          nextQueue.push(neighbor);
        }
      }
    }

    queue = nextQueue;
  }

  return result;
}
