import { useEffect, useState } from 'react';

type HealthResponse = {
  service: string;
  status: string;
  environment: string;
};

type ApiState =
  | { status: 'loading' }
  | { status: 'success'; data: HealthResponse }
  | { status: 'error'; message: string };

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:8000';

function App() {
  const [apiState, setApiState] = useState<ApiState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    async function loadHealth() {
      try {
        const response = await fetch(`${apiUrl}/health`, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`API returned ${response.status}`);
        }
        const data = (await response.json()) as HealthResponse;
        setApiState({ status: 'success', data });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        setApiState({
          status: 'error',
          message: error instanceof Error ? error.message : 'Unable to reach the API',
        });
      }
    }

    loadHealth();
    return () => controller.abort();
  }, []);

  return (
    <main className="page-shell">
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">GoodMorning Software Factory</p>
        <h1 id="page-title">Standard MVP starter</h1>
        <p className="lede">
          A minimal full-stack foundation for new GoodMorning products using React,
          FastAPI, PostgreSQL, Docker, and CI checks.
        </p>
        <div className="status-card" role="status" aria-live="polite">
          <span className={`status-dot status-dot--${apiState.status}`} aria-hidden="true" />
          {apiState.status === 'loading' && <p>Checking API connection…</p>}
          {apiState.status === 'success' && (
            <p>
              Connected to <strong>{apiState.data.service}</strong> ({apiState.data.environment}) with status{' '}
              <strong>{apiState.data.status}</strong>.
            </p>
          )}
          {apiState.status === 'error' && <p>API connection failed: {apiState.message}</p>}
        </div>
      </section>
    </main>
  );
}

export default App;
