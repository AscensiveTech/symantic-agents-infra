// CloudWatch Embedded Metric Format: one JSON log line per data point, which
// CloudWatch turns into metrics with no SDK call on the hot path. Dimensions
// stay low-cardinality (provider, operation, outcome) - never a workspace id
// or phone number.
const METRIC_NAMESPACE = "Symantic/CRM";

const UNITS = {
  ApiLatency: "Milliseconds",
  LookupLatency: "Milliseconds",
  QueueAge: "Milliseconds",
  SyncDuration: "Milliseconds",
};

export function createMetrics({
  write = (line) => console.log(line),
  now = Date.now,
} = {}) {
  function emit(name, value, dimensions = {}) {
    const dims = Object.fromEntries(
      Object.entries(dimensions).filter(([, v]) => typeof v === "string" && v),
    );
    write(JSON.stringify({
      _aws: {
        Timestamp: Number(now()),
        CloudWatchMetrics: [{
          Namespace: METRIC_NAMESPACE,
          Dimensions: [Object.keys(dims)],
          Metrics: [{ Name: name, Unit: UNITS[name] ?? "Count" }],
        }],
      },
      ...dims,
      [name]: value,
    }));
  }

  return {
    emit,
    count(name, dimensions) {
      emit(name, 1, dimensions);
    },
  };
}

// Tests and local runs use this to assert on what would have been published.
export function createRecordingMetrics() {
  const points = [];
  return {
    points,
    emit(name, value, dimensions = {}) {
      points.push({ name, value, ...dimensions });
    },
    count(name, dimensions = {}) {
      points.push({ name, value: 1, ...dimensions });
    },
    sum(name, filter = {}) {
      return points
        .filter((point) => point.name === name &&
          Object.entries(filter).every(([key, value]) => point[key] === value))
        .reduce((total, point) => total + point.value, 0);
    },
  };
}
