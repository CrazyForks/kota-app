import { useId } from 'react';
import { providerIconForId } from '../lib/provider-icons';

export function ProviderBadge({ provider, size = 14 }: {
  provider?: string | null;
  size?: 10 | 14 | 16;
}) {
  const tooltipId = useId();
  const icon = providerIconForId(provider);
  if (!icon) return null;
  return (
    <span className="provider-badge" data-provider={icon.id} tabIndex={0}
      aria-label={icon.label} aria-describedby={tooltipId}>
      <img src={icon.svg} alt="" width={size} height={size} aria-hidden="true" />
      <span className="provider-badge-tooltip" id={tooltipId} role="tooltip">{icon.label}</span>
    </span>
  );
}
