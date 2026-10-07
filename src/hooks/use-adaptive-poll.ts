import { useEffect, useRef, useCallback } from "react";
import { AdaptivePoll, type AdaptivePollOptions } from "@/lib/adaptive-poll";

type UseAdaptivePollOptions = Omit<AdaptivePollOptions, "onResult" | "fetcher"> & {
  enabled?: boolean;
};

/**
 * React hook that wraps AdaptivePoll.
 *
 * @param fetcher  Async function that returns data
 * @param onResult Callback when data arrives
 * @param opts     AdaptivePoll options + `enabled` flag
 * @returns reset() function to bump interval back to base
 */
export function useAdaptivePoll(
  fetcher: () => Promise<unknown>,
  onResult: (data: unknown) => void,
  opts: UseAdaptivePollOptions = {},
) {
  const pollRef = useRef<AdaptivePoll | null>(null);
  const { enabled = true, ...pollOpts } = opts;

  // Keep latest callbacks in refs to avoid re-creating poll on every render
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const onResultRef = useRef(onResult);
  onResultRef.current = onResult;

  useEffect(() => {
    if (!enabled) return;

    const poll = new AdaptivePoll({
      ...pollOpts,
      fetcher: () => fetcherRef.current(),
      onResult: (d) => onResultRef.current(d),
    });

    pollRef.current = poll;
    poll.start();

    return () => {
      poll.stop();
      pollRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const reset = useCallback(() => {
    pollRef.current?.reset();
  }, []);

  return { reset };
}
