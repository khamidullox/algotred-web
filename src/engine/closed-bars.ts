import type { Bar } from "../data/types";
import type { ClosedBars } from "./types";

/**
 * A window over a full series that ends at the last closed bar. The engine
 * moves the end forward; strategies only ever hold the `ClosedBars` interface.
 */
export class ClosedBarsView implements ClosedBars {
  #count: number;

  constructor(
    private readonly source: readonly Bar[],
    count = 0,
  ) {
    this.#count = Math.min(count, source.length);
  }

  get length(): number {
    return this.#count;
  }

  /** Engine only: the first `count` bars are now closed. */
  advanceTo(count: number): void {
    this.#count = Math.min(Math.max(count, this.#count), this.source.length);
  }

  at(index: number): Bar | undefined {
    const resolved = index < 0 ? this.#count + index : index;
    return resolved >= 0 && resolved < this.#count
      ? this.source[resolved]
      : undefined;
  }

  last(): Bar | undefined {
    return this.at(-1);
  }

  lastN(count: number): readonly Bar[] {
    return this.source.slice(Math.max(0, this.#count - count), this.#count);
  }

  slice(start = 0, end = this.#count): readonly Bar[] {
    const clamp = (index: number): number => {
      const resolved = index < 0 ? this.#count + index : index;
      return Math.min(Math.max(resolved, 0), this.#count);
    };
    return this.source.slice(clamp(start), clamp(end));
  }
}
