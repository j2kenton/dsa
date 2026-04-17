function twoPointersFastSlow(nums) {
  let slow = 0;
  let fast = 0;
  let result = 0;

  while (fast < nums.length) {
    // DO SOME LOGIC AT THIS POINT

    if (check(nums[slow], nums[fast])) {
      slow++;
    }
    fast++;
  }

  return result;
}
