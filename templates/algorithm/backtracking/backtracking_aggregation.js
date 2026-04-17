const INITIAL_VALUE = 0;

function traverseGraph(startIndex, ...additionalStates) {
  if (isLeaf(startIndex)) {
    return 1;
  }
  let result = INITIAL_VALUE;
  for (const edge of getEdges(startIndex, ...additionalStates)) {
    if (additionalStates) {
      // update additionalStates
    }
    const toAdd = traverseGraph(startIndex + edge.length, ...additionalStates);
    result = aggregate(result, toAdd);
    if (additionalStates) {
      // revert additionalStates if necessary
    }
  }
  return result;
}
