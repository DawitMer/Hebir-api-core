/**
 * Optional OpenTelemetry bootstrap.
 * Enabled when OTEL_ENABLED=true (and usually OTEL_EXPORTER_OTLP_ENDPOINT).
 *
 * Loaded dynamically so prod images without OTLP still boot lightly.
 */
export async function startTracingIfEnabled(): Promise<void> {
  if (process.env.OTEL_ENABLED !== 'true') return;

  try {
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const { getNodeAutoInstrumentations } =
      await import('@opentelemetry/auto-instrumentations-node');
    const { OTLPTraceExporter } =
      await import('@opentelemetry/exporter-trace-otlp-http');
    const { resourceFromAttributes } = await import('@opentelemetry/resources');
    const { ATTR_SERVICE_NAME } =
      await import('@opentelemetry/semantic-conventions');

    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const exporter = endpoint
      ? new OTLPTraceExporter({
          url: `${endpoint.replace(/\/$/, '')}/v1/traces`,
        })
      : undefined;

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME || 'api-core',
      }),
      traceExporter: exporter,
      instrumentations: [
        getNodeAutoInstrumentations({
          '@opentelemetry/instrumentation-fs': { enabled: false },
        }),
      ],
    });

    await sdk.start();
    console.log(
      `[otel] tracing started${endpoint ? ` → ${endpoint}` : ' (no OTLP endpoint; spans in-process only)'}`,
    );

    const shutdown = async () => {
      try {
        await sdk.shutdown();
      } catch {
        /* ignore */
      }
    };
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  } catch (error) {
    console.warn(
      `[otel] failed to start tracing: ${(error as Error).message}. Install OTEL packages or set OTEL_ENABLED=false.`,
    );
  }
}
