function topDownDP(nums) {
  let memo = new Array(nums.length).fill(-1);

  function dp(i) {
    // handle base cases, e.g.
    if (i <= 1) {
      return i;
    }

    // get from memo
    if (memo[i] !== -1) {
      return memo[i];
    }

    // recurrence relation, e.g.
    let result = dp(i - 1) + dp(i - 2);

    memo[i] = result;
    return result;
  }

  return dp(nums.length - 1);
}
