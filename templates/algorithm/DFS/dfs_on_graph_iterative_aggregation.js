function traverseGraph(startNode) {
  const seen = new Set([startNode]);
  const stack = [startNode];
  let result = 0;

  while (stack.length) {
    const node = stack.pop();
    // DO SOME LOGIC AT THIS POINT
    for (const neighbor of node.neighbors){
      if (!seen.has(neighbor)) {
        seen.add(neighbor);
        stack.push(neighbor);
      }
    }
  }

        return result;
}
