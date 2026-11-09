const pad = (n: number): string => String(n).padStart(2, '0');

/** Local date and time with the UTC offset, for example 2026-11-08 16:02:51 UTC-05:00. */
export const localStamp = (d: Date): string => {
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
};

/** A duration in plain words: 45 s, 4 min 45 s, 1 h 2 min 3 s. */
export const elapsed = (ms: number): string => {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h} h ${m} min ${s} s`;
  if (m > 0) return `${m} min ${s} s`;
  return `${s} s`;
};
