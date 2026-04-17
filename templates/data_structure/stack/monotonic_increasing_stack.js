class MonoIncreasingStack {
  #stack = [];
  #someImportantValue = 0;

  constructor(entriesToInsert) {
    this.insertEntries(entriesToInsert);
  }

  insertEntries(nums) {
    for (const num of nums) {
      while (this.#stack.length > 0 && this.#stack.at(-1) > num) {
        // OPTIONAL: DO SOME LOGIC AT THIS POINT

        const popped = this.#stack.pop();

        // OPTIONAL: DO SOME LOGIC AT THIS POINT e.g.
        this.#someImportantValue += popped;
      }

      this.#stack.push(num);
    }
  }

  get value() {
    return this.#someImportantValue;
  }
}
