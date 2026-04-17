function traverseGraph(root) {
  const stack = [root];
  let result = 0;
  while (stack.length) {
    let node = stack.pop();

    // DO SOME LOGIC AT THIS POINT

    if (node.left) {
      stack.push(node.left);
    }
    if (node.right) {
      stack.push(node.right);
    }
  }
  return result;
}
