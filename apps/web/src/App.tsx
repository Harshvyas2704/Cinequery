import type { HealthResponse } from "@cinequery/shared";
import { useCallback, useEffect, useState } from "react";
import { fetchHealth } from "./api.ts";

type State =
  | { kind: "loading" }
  | { kind: "loaded"; health: HealthResponse }
  | { kind: "failed" };

type Service = { status: "ok" | "error"; latencyMs?: number; version?: string; message?: string };

function ServiceRow({ name, service }: { name: string; service: Service }) {
  const detail =
    service.status === "error"
      ? service.message
      : service.version !== undefined
        ? `version ${service.version}`
        : `${service.latencyMs} ms`;
  return (
    <li className="service">
      <span className={`dot ${service.status}`} aria-hidden="true" />
      <span className="name">{name}</span>
      <span className="detail">{detail}</span>
      <span className={`badge ${service.status}`}>{service.status === "ok" ? "OK" : "Down"}</span>
    </li>
  );
}

export function App() {
  const [state, setState] = useState<State>({ kind: "loading" });

  const load = useCallback((signal?: AbortSignal) => {
    fetchHealth(signal)
      .then((health) => setState({ kind: "loaded", health }))
      .catch(() => {
        if (!signal?.aborted) setState({ kind: "failed" });
      });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const refresh = () => {
    setState({ kind: "loading" });
    load();
  };

  return (
    <main>
      <h1>Movie Recommendation Engine</h1>
      <section className="card" aria-live="polite">
        <header>
          <h2>System status</h2>
          <button type="button" onClick={refresh} disabled={state.kind === "loading"}>
            Refresh
          </button>
        </header>

        {state.kind === "loading" && <p className="note">Checking services…</p>}

        {state.kind === "failed" && (
          <p className="note error">
            Could not reach the API. Check that <code>pnpm dev</code> is running.
          </p>
        )}

        {state.kind === "loaded" && (
          <>
            <p className={`summary ${state.health.status}`}>
              {state.health.status === "ok"
                ? "All services are healthy."
                : "One or more services are down."}
            </p>
            <ul>
              <ServiceRow name="Postgres" service={state.health.services.postgres} />
              <ServiceRow name="pgvector" service={state.health.services.pgvector} />
              <ServiceRow name="Redis" service={state.health.services.redis} />
            </ul>
          </>
        )}
      </section>
    </main>
  );
}
