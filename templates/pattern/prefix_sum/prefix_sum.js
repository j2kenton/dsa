function buildPrefixSum(arr) {
  let prefixSum = new Array(arr.length);
  prefixSum[0] = arr[0];
  for (let i = 1; i < arr.length; i++) {
    prefixSum[i] = prefixSum[i - 1] + arr[i];
  }
  return prefixSum;
}

// query prefix sum for range [left, right] (inclusive)
function queryRange(prefixSum, left, right) {
  if (left === 0) {
    return prefixSum[right];
  }
  return prefixSum[right] - prefixSum[left - 1];
}
