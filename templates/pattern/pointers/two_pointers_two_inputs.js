function twoPointersTwoInputs(nums1, nums2) {
  let p1 = 0;
  let p2 = 0;
  let result = 0;

  while (p1 < nums1.length && p2 < nums2.length) {
    // DO SOME LOGIC AT THIS POINT

    if (check(nums1[p1], nums2[p2])) {
      p1++;
    } else {
      p2++;
    }
  }

  while (p1 < nums1.length) {
    // DO SOME LOGIC AT THIS POINT

    p1++;
  }

  while (p2 < nums2.length) {
    // DO SOME LOGIC AT THIS POINT

    p2++;
  }

  return result;
}
