/** Evict old entries without moving the retained cache on every received row. */
export class Deque<T> {
  private items: (T | undefined)[] = [];
  private head = 0;
  get length() {
    return this.items.length - this.head;
  }
  at(index: number): T | undefined {
    return this.items[this.head + index];
  }
  push(item: T) {
    this.items.push(item);
  }
  shift(): T | undefined {
    if (!this.length) return undefined;
    const item = this.items[this.head];
    this.items[this.head++] = undefined;
    if (this.head >= 2048 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return item;
  }
  slice(start = 0): T[] {
    return this.items.slice(this.head + start) as T[];
  }
}
