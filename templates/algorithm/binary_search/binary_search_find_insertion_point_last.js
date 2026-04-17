function findLastInsertionPoint(nums, target) {
  let left = 0;
  let right = nums.length - 1;
  let lastMatch = nums.length;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (nums[mid] > target) {
      lastMatch = mid;
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return lastMatch;
}
