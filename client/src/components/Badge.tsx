/**
 * Status badges and metric pills.
 *
 * Layer status is the one thing the user reads on every screen, so it always
 * renders through the same component and the same colour vocabulary — a status
 * spelled differently in two panes would look like two different states.
 */

/** `MORE_RESEARCH_REQUIRED` -> `more_research_required`, safe for a class name. */
function statusKey(status: string): string {
  const key = status.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
  return key || 'unknown';
}

/** `MORE_RESEARCH_REQUIRED` -> `MORE RESEARCH REQUIRED`. */
function statusLabel(status: string): string {
  const label = status.trim().replace(/_/g, ' ');
  return label || 'UNKNOWN';
}

/** A coloured layer/run/document status chip. */
export function Badge(props: { status: string; title?: string }): JSX.Element {
  const key = statusKey(props.status);
  return (
    <span className={`badge badge--${key}`} title={props.title ?? statusLabel(props.status)}>
      {statusLabel(props.status)}
    </span>
  );
}

/** A compact `label value` metric, tinted by how worried the user should be. */
export function Pill(props: {
  label: string;
  value: string | number;
  tone?: 'ok' | 'warn' | 'bad' | 'muted';
}): JSX.Element {
  const tone = props.tone ?? 'muted';
  return (
    <span className={`pill pill--${tone}`} title={`${props.label}: ${String(props.value)}`}>
      <span className="pill__label">{props.label}</span>
      <span className="pill__value">{props.value}</span>
    </span>
  );
}
