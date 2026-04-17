function traverseGraph(node, target) {
  if (node === null) {
    return null;
  }
  if (node === target) {
    return node;
  }
  return traverseGraph(node.left, target) || traverseGraph(node.right, target);
}
