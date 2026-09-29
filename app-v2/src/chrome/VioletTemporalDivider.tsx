import { useId } from 'react';
import type { ComposerTemporalGap } from '../pty-client';
import type { Agent, AgentId } from '../types/scene';
import temporalGapIcon from '../assets/tavern/icons/temporal-gap.png';
import '../styles/violet-temporal-divider.css';

export function VioletTemporalDivider({ gap, agentMeta }: {
  gap: ComposerTemporalGap;
  agentMeta?: Readonly<Record<AgentId, Agent>>;
}) {
  const tooltipId = useId();
  // Use the saved send-time values, never the current date or provider logs.
  const days = gap.targetAgentIds.map((id) => {
    const value = gap.elapsedDaysByTarget?.[id];
    return value !== undefined && Number.isInteger(value) && value >= 1 ? value : null;
  });
  const copy = (value: number | null) => value === null
    ? 'over 24 hours since last message'
    : `have been ${value} ${value === 1 ? 'day' : 'days'} since last message`;
  const rows = days.every((value) => value === days[0])
    ? [copy(days[0] ?? null)]
    : gap.targetAgentIds.map((id, index) => `${agentMeta?.[id]?.name ?? id}: ${copy(days[index]!)}`);
  return (
    <div className="violet-temporal-divider" role="separator" aria-label="Cross-day context">
      <span className="provider-badge violet-temporal-mark" tabIndex={0}
        aria-label="Cross-day context" aria-describedby={tooltipId}>
        <img src={temporalGapIcon} alt="" width={40} height={18} aria-hidden="true" />
        <span className="provider-badge-tooltip" id={tooltipId} role="tooltip">
          {rows.map((row, index) => <span key={index}>{row}</span>)}
        </span>
      </span>
    </div>
  );
}
