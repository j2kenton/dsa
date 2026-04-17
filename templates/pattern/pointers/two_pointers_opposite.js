function twoPointersOpposite(nums) {
  let left = 0;
  let right = nums.length - 1;
  let result = 0;
  while (left < right) {
    // DO SOME LOGIC AT THIS POINT

    if (check(nums[left], nums[right])) {
      left++;
    } else {
      right--;
    }
  }
  return result;
}
