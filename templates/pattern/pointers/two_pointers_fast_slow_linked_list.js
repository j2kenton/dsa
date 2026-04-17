function twoPointersFastSlowLinkedList(head) {
  let slow = head;
  let fast = head;
  let result = 0;

  while (fast?.next) {
    // DO SOME LOGIC AT THIS POINT

    slow = slow.next;
    fast = fast.next.next;
  }

  return result;
}
