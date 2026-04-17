function findMaxLengthSlidingWindow(nums, windowSize) {
  let currentSum = 0;
  for (let i = 0; i < windowSize; i++) {
    currentSum += nums[i];
  }
  let maxSum = currentSum;
  let left = 0;
  for (let right = windowSize; right < nums.length; right++) {
    currentSum += nums[right];
    currentSum -= nums[left];
    left++;
    maxSum = Math.max(maxSum, currentSum);
  }
  return maxSum;
}
