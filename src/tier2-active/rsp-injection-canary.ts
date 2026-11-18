/**
 * RSP-08: Injection canary, IP-bound, V1 form (opt-in decoy post surface).
 *
 * A decoy post store: the owning IP sees its token, any other IP gets
 * a 404-shaped miss. V0 in the source had a flood defect: at capacity
 * it cleared the whole store, wiping every earlier post.
 *
 * V1 form built here, with BOTH halves of the lab fix:
 * 1. evict-oldest at capacity (never clear-all), and
 * 2. the id-derivation fix: ids come from a MONOTONIC store counter,
 *    never from the current length. Evict-oldest alone stalls the
 *    store at 511, because length-derived ids collide in steady
 *    state and overwrite instead of growing (lab defect 3: V1-naive
 *    newest-512 survival was only 423/512, final size 511).
 * With both fixes the lab measured newest-512 survival 512/512.
 *
 * Honeypot-surface only, advisory, low tier.
 */
export interface RspInjectionPost { id: number; ip: string; token: string }

export interface RspInjectionCanary {
  post(ip: string, token: string): RspInjectionPost;
  view(id: number, ip: string): { status: 200; post: RspInjectionPost } | { status: 404 };
  size(): number;
  capacity: number;
}

export function createRspInjectionCanary(options?: { capacity?: number; secret?: string | Uint8Array }): RspInjectionCanary {
  const capacity = Math.max(1, Math.floor(options?.capacity ?? 512) || 512);
  const store = new Map<number, RspInjectionPost>();
  let nextId = 1007; // monotonic counter; deliberately NOT derived from store size
  return {
    capacity,
    post(ip, token) {
      const id = nextId;
      nextId += 3;
      const post: RspInjectionPost = { id, ip, token };
      store.set(id, post);
      while (store.size > capacity) {
        const oldest = store.keys().next().value as number;
        store.delete(oldest);
      }
      return post;
    },
    view(id, ip) {
      const post = store.get(id);
      if (!post || post.ip !== ip) return { status: 404 };
      return { status: 200, post };
    },
    size: () => store.size,
  };
}
