export type ProfilingStage = {
  stage: string;
  count: number;
  totalMs: number;
  lastMs: number;
  maxMs: number;
};

export type ProfilingSnapshot = {
  name: string;
  totalMs: number;
  stages: ProfilingStage[];
};

type MutableStage = { count: number; totalMs: number; lastMs: number; maxMs: number };

/** Lightweight browser profiler for workflows that update progressively. */
export class Profiling {
  private readonly name: string;
  private startedAt = performance.now();
  private readonly stages = new Map<string, MutableStage>();
  private readonly listeners = new Set<(snapshot: ProfilingSnapshot) => void>();

  constructor(name = 'workflow') {
    this.name = name;
  }

  reset() {
    this.startedAt = performance.now();
    this.stages.clear();
    this.emit();
  }

  start(stage: string): () => void {
    const startedAt = performance.now();
    return () => {
      const elapsed = performance.now() - startedAt;
      const current = this.stages.get(stage) ?? { count: 0, totalMs: 0, lastMs: 0, maxMs: 0 };
      current.count += 1;
      current.totalMs += elapsed;
      current.lastMs = elapsed;
      current.maxMs = Math.max(current.maxMs, elapsed);
      this.stages.set(stage, current);
      this.emit();
    };
  }

  async measure<T>(stage: string, action: () => Promise<T>): Promise<T> {
    const stop = this.start(stage);
    try {
      return await action();
    } finally {
      stop();
    }
  }

  subscribe(listener: (snapshot: ProfilingSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): ProfilingSnapshot {
    return {
      name: this.name,
      totalMs: performance.now() - this.startedAt,
      stages: [...this.stages.entries()]
        .map(([stage, value]) => ({ stage, totalMs: value.totalMs, lastMs: value.lastMs, maxMs: value.maxMs, count: value.count }))
        .sort((left, right) => right.totalMs - left.totalMs),
    };
  }

  private emit() {
    const snapshot = this.snapshot();
    this.listeners.forEach(listener => listener(snapshot));
  }
}
