function traverseTree(root) {
  let queue = [root];
  let result = 0;

  while (queue.length) {
    // DO LOGIC FOR CURRENT LEVEL

    const nextQueue = [];

    for (const node of queue) {
      // DO LOGIC FOR CURRENT NODE
      // e.g.
      // if (node === target){
      //   return node;
      // }
      if (node.left) {
        nextQueue.push(node.left);
      }
      if (node.right) {
        nextQueue.push(node.right);
      }
    }

    queue = nextQueue;
  }

  return result;
  // alternatively: return `-1` for not found
  // i.e. if there was no `return` call above in the `for` loop
}
