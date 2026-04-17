const START_NODE_INDEX = 0;

function traverseGraph(adjacencyList) {
  let queue = [START_NODE_INDEX];
  const seen = new Set([START_NODE_INDEX]);
  let result = 0;

  while (queue.length) {
    const nextQueue = [];

    for (const nodeIndex of queue) {
      // DO SOME LOGIC AT THIS POINT
      // e.g., result += nodeValue;

      const neighbors = adjacencyList[nodeIndex];

      for (const neighbor of neighbors) {
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
