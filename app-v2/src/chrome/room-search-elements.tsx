export const VIOLET_DATE_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function roomSearchDateLabel(value: string, now: Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const startOfDay = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  // Local calendar days can be 23 or 25 hours at daylight-saving boundaries.
  const days = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days >= 2 && days <= 7) return `${days} days ago`;
  return `${VIOLET_DATE_MONTHS[date.getMonth()]} ${date.getDate()}${date.getFullYear() === now.getFullYear() ? '' : `, ${date.getFullYear()}`}`;
}

export function RoomSearchIcon() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></svg>;
}

export function SearchMatchText({ text, terms }: { text: string; terms: readonly string[] }) {
  const escaped = [...new Set(terms.filter(Boolean))]
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!escaped.length) return <>{text}</>;
  // Literal terms come from the backend, not a second frontend query parser.
  const pieces = text.split(new RegExp(`(${escaped.join('|')})`, 'giu'));
  return <>{pieces.map((piece, index) => index % 2 ? <mark key={index}>{piece}</mark> : piece)}</>;
}
