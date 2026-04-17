function traverseGraph(startNode) {
  const seen = new Set();

  function dfs(node) {
    let result = 0;
    // DO SOME LOGIC AT THIS POINT
    for (const neighbor of node.neighbors) {
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        result += dfs(neighbor);
      }
    }
  }

  seen.add(startNode);
  return dfs(startNode);
}
