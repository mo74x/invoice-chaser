# Observability, Grafana Dashboards & Prometheus Alerts

Invoice Chaser exposes native Prometheus metrics on `/metrics` (port 3000), protected by `METRICS_TOKEN`.

---

## 1. Key Metrics Exposed

| Metric Name | Type | Description |
|---|---|---|
| `invoice_chaser_webhook_latency_seconds` | Histogram | Latency of Stripe and Resend webhook processing |
| `invoice_chaser_reminders_total` | Counter | Total reminders processed partitioned by `status` and `stage` |
| `invoice_chaser_ai_validation_failures_total` | Counter | Total validation rejections from Claude Tone Engine |
| `invoice_chaser_external_errors_total` | Counter | Failures originating from external APIs (`stripe`, `resend`, `claude`) |
| `invoice_chaser_queue_depth` | Gauge | Active, delayed, waiting, and failed jobs in BullMQ |
| `invoice_chaser_dlq_depth` | Gauge | Dead-letter queue depth (`reminders-dlq`) |

---

## 2. Recommended Prometheus Alerting Rules (`alerts.yml`)

```yaml
groups:
  - name: invoice_chaser_alerts
    rules:
      # Alert when Dead-Letter Queue contains failed reminder jobs
      - alert: RemindersDLQNotEmpty
        expr: invoice_chaser_dlq_depth > 0
        for: 2m
        labels:
          severity: critical
        annotations:
          summary: "Reminders detected in Dead-Letter Queue"
          description: "Jobs in reminders-dlq reached max retries. Manual intervention required."

      # Alert on high Stripe/Resend webhook latency
      - alert: HighWebhookLatency
        expr: histogram_quantile(0.95, sum(rate(invoice_chaser_webhook_latency_seconds_bucket[5m])) by (le, source)) > 0.5
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "Webhook acknowledgement p95 latency exceeded 500ms"

      # Alert on sustained external API errors (e.g. Stripe/Resend rate limits or downtime)
      - alert: ExternalProviderErrorsSpike
        expr: rate(invoice_chaser_external_errors_total[5m]) > 0.1
        for: 3m
        labels:
          severity: warning
        annotations:
          summary: "High external provider error rate on {{ $labels.provider }}"

      # Alert when AI reminder generation validation failures spike
      - alert: HighAiValidationFailures
        expr: rate(invoice_chaser_ai_validation_failures_total[10m]) > 0.2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "High rate of AI reminder validation rejections"
```

---

## 3. Webhook Alert Notifications
In addition to Prometheus metrics, Invoice Chaser's internal `AlertService` automatically dispatches structured alert webhooks to `ALERT_WEBHOOK_URL` (Slack, Discord, or PagerDuty webhook) whenever jobs fail into the Dead-Letter Queue.

