class UnionFind {
  #id = new Map();

  find(x) {
    const match = this.#id.get(x);
    if (match === undefined || match === x) {
      return x;
    }
    const root = this.find(match);
    this.#id.set(x, root);
    return root;
  }

  union(x, y) {
    const rootX = this.find(x);
    const rootY = this.find(y);
    if (rootX !== rootY) {
      this.#id.set(rootX, rootY);
    }
  }
}
