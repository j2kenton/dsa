class TrieNode {
  #children = new Map();
  #isEndOfWord = false;

  get children() {
    return this.#children;
  }

  get isEndOfWord() {
    return this.#isEndOfWord;
  }

  set isEndOfWord(isEnd) {
    this.#isEndOfWord = isEnd;
  }
}

class Trie {
  #root = new TrieNode();

  insert(word) {
    let current = this.#root;
    for (const char of word) {
      if (!current.children.has(char)) {
        current.children.set(char, new TrieNode());
      }
      current = current.children.get(char);
    }
    current.isEndOfWord = true;
  }

  search(word) {
    const node = this.#traverse(word);
    if (node === null) {
      return false;
    }
    return node.isEndOfWord;
  }

  startsWith(prefix) {
    return this.#traverse(prefix) !== null;
  }

  #traverse(string) {
    let current = this.#root;
    for (const char of string) {
      if (!current.children.has(char)) {
        return null;
      }
      current = current.children.get(char);
    }
    return current;
  }
}
