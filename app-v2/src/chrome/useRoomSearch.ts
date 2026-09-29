import { useCallback, useEffect, useRef, useState } from 'react';
import { searchVioletRoom, type VioletRoomSearchRequest, type VioletRoomSearchResult } from '../pty-client';

type Job = { generation: number; request: VioletRoomSearchRequest };

/** One scan in flight, one replaceable pending query. A slow scan never builds a queue. */
export function useRoomSearch(projectRoot: string, query: string, humanOnly: boolean) {
  const [result, setResult] = useState<VioletRoomSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const disposed = useRef(false);
  const running = useRef(false);
  const pending = useRef<Job | null>(null);

  const dispatch = useCallback(function dispatch(job: Job) {
    if (disposed.current || job.generation !== generation.current) return;
    if (running.current) {
      pending.current = job;
      return;
    }
    running.current = true;
    setLoading(true);
    setError(null);
    void searchVioletRoom(job.request).then((page) => {
      if (disposed.current || job.generation !== generation.current) return;
      setResult((previous) => {
        if (!job.request.cursor || !previous) return page;
        const seen = new Set(previous.hits.map((hit) => hit.id));
        return {
          ...previous,
          hits: [...previous.hits, ...page.hits.filter((hit) => !seen.has(hit.id))],
          nextCursor: page.nextCursor,
        };
      });
    }).catch((reason: unknown) => {
      if (!disposed.current && job.generation === generation.current) setError(String(reason));
    }).finally(() => {
      running.current = false;
      if (!disposed.current && job.generation === generation.current) setLoading(false);
      const next = pending.current;
      pending.current = null;
      if (next) dispatch(next);
    });
  }, []);

  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      generation.current += 1;
      pending.current = null;
    };
  }, []);

  useEffect(() => {
    const current = ++generation.current;
    pending.current = null;
    setResult(null);
    setError(null);
    setLoading(!!query.trim());
    if (!query.trim()) return;
    const timer = window.setTimeout(() => dispatch({
      generation: current,
      request: { projectRoot, query, humanOnly, limit: 50 },
    }), 300);
    return () => window.clearTimeout(timer);
  }, [projectRoot, query, humanOnly, dispatch]);

  const loadMore = () => {
    if (loading || !result?.nextCursor) return;
    dispatch({ generation: generation.current, request: { projectRoot, query, humanOnly, limit: 50, cursor: result.nextCursor } });
  };
  const retry = () => {
    if (loading || !query.trim()) return;
    dispatch({ generation: generation.current, request: { projectRoot, query, humanOnly, limit: 50, cursor: result?.nextCursor } });
  };
  return { result, loading, error, loadMore, retry };
}
