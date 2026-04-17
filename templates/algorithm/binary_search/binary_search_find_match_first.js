function findMatchOrInsertionPt(nums, target) {
  let left = 0;
  let right = nums.length - 1;
  let firstMatch = -1;

  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (nums[mid] === target) {
      firstMatch = mid;
      right = mid - 1;
    } else if (nums[mid] > target) {
      right = mid - 1;
    } else {
      left = mid + 1;
    }
  }

  return firstMatch;
}
