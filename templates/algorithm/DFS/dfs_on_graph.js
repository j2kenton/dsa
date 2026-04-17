function traverseGraph(startNode) {
  const seen = new Set();

  function dfs(curr) {
    for (const neighbor of curr.neighbors) {
      if (seen.has(neighbor)) {
        continue;
      }
      seen.add(neighbor);
      dfs(neighbor);
    }
  }

  seen.add(startNode);
  dfs(startNode);
}
