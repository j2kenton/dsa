function traverseGraph(startIndex, path = [], res = [], ...additionalStates) {
  // for `additionalStates` include any additional states
  if (isLeaf(startIndex)) {
    res.push([...path]);
  }
  for (const edge of getEdges(startIndex, ...additionalStates)) {
    if (!isValid(edge)) {
      continue;
    }
    path.push(edge);
    if (additionalStates) {
      // update additionalStates
    }
    traverseGraph(startIndex + edge.length, path, res, ...additionalStates);
    if (additionalStates) {
      // revert additionalStates (if necessary)
    }
    path.pop();
  }
}
