"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface SSEHandlers {
  /** Called when the stream first connects or reconnects. */
  onConnected?: () => void;
  /** Called per named SSE event. Key is the event type (payment, login, etc). */
  onEvent?: (type: string, data: any) => void;
  /** Called when the connection drops (before retry). */
  onDisconnect?: () => void;
}

interface SSEState {
  connected: boolean;
  reconnectCount: number;
}

/**
 * Subscribe to the backend SSE event stream.
 *
 * Uses the JWT token as a query parameter because the native EventSource API
 * does not support custom headers.
 *
 * Automatically reconnects on disconnect with exponential backoff (1s → 30s max).
 * Cleanly closes on unmount.
 *
 * @example
 * ```ts
 * const { connected } = useSSE({
 *   onEvent: (type, data) => {
 *     if (type === 'payment') console.log('New payment:', data);
 *   },
 * });
 * ```
 */
export function useSSE(handlers: SSEHandlers = {}): SSEState {
  const [connected, setConnected] = useState(false);
  const [reconnectCount, setReconnectCount] = useState(0);
  const retriesRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);
  const mountedRef = useRef(true);

  const connect = useCallback(() => {
    // Clean up any existing connection
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }

    // Don't connect if no token available
    const token =
      typeof window !== "undefined" ? localStorage.getItem("token") : null;
    if (!token) return;

    const API =
      typeof window !== "undefined"
        ? `http://${window.location.hostname}:3001`
        : "http://localhost:3001";

    const url = `${API}/events?token=${encodeURIComponent(token)}`;
    const es = new EventSource(url);
    esRef.current = es;

    es.addEventListener("connected", () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setReconnectCount(0);
      retriesRef.current = 0;
      handlers.onConnected?.();
    });

    // Catch-all for any named event
    es.onmessage = (e) => {
      if (!mountedRef.current) return;
      try {
        const payload = JSON.parse(e.data);
        if (payload.type && payload.type !== "connected") {
          handlers.onEvent?.(payload.type, payload.data);
        }
      } catch {
        // ignore malformed messages
      }
    };

    // Also listen for named events
    const namedEvents = ["payment", "login"];
    for (const evt of namedEvents) {
      es.addEventListener(evt, (e: MessageEvent) => {
        if (!mountedRef.current) return;
        try {
          const data = JSON.parse(e.data);
          handlers.onEvent?.(evt, data);
        } catch {
          // ignore
        }
      });
    }

    es.onerror = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      handlers.onDisconnect?.();
      es.close();
      esRef.current = null;

      // Exponential backoff: 1s → 2s → 4s → 8s → 16s → 30s max
      retriesRef.current++;
      const delay = Math.min(1000 * Math.pow(2, retriesRef.current - 1), 30000);
      setTimeout(() => {
        if (mountedRef.current) {
          setReconnectCount(retriesRef.current);
          connect();
        }
      }, delay);
    };
  }, [handlers.onConnected, handlers.onEvent, handlers.onDisconnect]);

  useEffect(() => {
    mountedRef.current = true;
    connect();

    return () => {
      mountedRef.current = false;
      if (esRef.current) {
        esRef.current.close();
        esRef.current = null;
      }
    };
  }, [connect]);

  return { connected, reconnectCount };
}