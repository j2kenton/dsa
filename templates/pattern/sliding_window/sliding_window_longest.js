function findLongestSlidingWindow(nums, target) {
  let sum = 0;
  let maxLength = 0;
  let left = 0;
  for (let right = 0; right < nums.length; right++) {
    sum += nums[right];
    while (sum > target && left <= right) {
      sum -= nums[left];
      left++;
    }
    const currLength = right - left + 1;
    maxLength = Math.max(maxLength, currLength);
  }
  return maxLength;
}
