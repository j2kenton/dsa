function traverseTree(root) {
  const queue = [root];
  let result = 0;

  while (queue.length) {
    const currentLength = queue.length;
    // DO LOGIC FOR CURRENT LEVEL

    const nextQueue = [];

    for (let i = 0; i < currentLength; i++) {
      const node = queue[i];
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
